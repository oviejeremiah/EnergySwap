const crypto = require('node:crypto');

/**
 * Proof of account control for EnergySwap write paths.
 *
 * Without this, any API caller can post an offer naming any Hedera account as
 * the producer, and so can sell energy that does not exist. A caller proves
 * control of the account it claims by getting that account to sign and pay for
 * a transaction carrying a nonce this server issued, which the server then
 * reads back from the network.
 *
 * ## Why a transaction and not a wallet message signature
 *
 * The obvious implementation - issue a message, have the wallet sign it, verify
 * against the account's public key from the mirror node - was built and could
 * not be made to work against a real wallet. The wallet returned structurally
 * valid ECDSA signatures that verified against nothing: twelve combinations of
 * digest and signature encoding, eight string encodings, and DER versus raw all
 * failed, while the same verification harness correctly accepted a signature it
 * had generated itself. The bytes the wallet signed were not derivable from the
 * message it displayed, and no encoding, digest or wrapper setting recovered
 * them.
 *
 * A transaction needs none of that. The account signs it and pays the fee, and
 * the network records who paid. The fee payer is authoritative and cannot be
 * spoofed, which is the property /api/record-trade already depends on to verify
 * a settlement.
 *
 * Threat model notes:
 *  - The nonce is single-use and time-bounded, so a captured proof transaction
 *    cannot be replayed to create additional offers.
 *  - The nonce is scoped to one account, so a proof issued to one account
 *    cannot be used to post on behalf of another.
 *  - A failure to read the transaction is a refusal, never an acceptance. Not
 *    being able to check is never treated as being allowed through.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 10_000;

/** Prepended to the nonce so a proof memo is recognisable on-chain. */
const PROOF_PREFIX = 'EnergySwap proof';

/** accountId -> Map<nonce, { issuedAt, expiresAt, network }> */
const challenges = new Map();

// Periodic sweep so an abandoned client cannot pin memory indefinitely.
setInterval(() => {
    const now = Date.now();
    for (const [accountId, entries] of challenges) {
        for (const [nonce, record] of entries) {
            if (record.expiresAt <= now) entries.delete(nonce);
        }
        if (entries.size === 0) challenges.delete(accountId);
    }
}, CHALLENGE_TTL_MS).unref();

function purgeAccountIfEmpty() {
    while (challenges.size > MAX_CHALLENGES) {
        const oldest = challenges.keys().next().value;
        challenges.delete(oldest);
    }
}

/** Test helper: drop all outstanding challenges. */
function _resetChallenges() {
    challenges.clear();
}

/**
 * The transaction memo that carries a proof nonce.
 *
 * Derived from the nonce rather than stored beside it, so the memo a client
 * signs cannot drift from the nonce the server will look for.
 *
 * @param {string} nonce
 * @returns {string}
 */
function proofMemoFor(nonce) {
    return `${PROOF_PREFIX}: ${nonce}`;
}

/**
 * Issue a challenge to be proved by a transaction.
 *
 * The caller signs a transaction carrying `memo` as its memo and submits it,
 * then posts the transaction id back with `nonce`.
 *
 * @param {string} accountId
 * @param {string} network testnet or mainnet, so the client can be built for it.
 * @returns {{nonce: string, memo: string, network: string, expiresAt: string}}
 */
function issueProofChallenge(accountId, network = 'testnet') {
    const account = String(accountId).trim();
    const nonce = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;

    if (!challenges.has(account)) challenges.set(account, new Map());
    challenges.get(account).set(nonce, { issuedAt: Date.now(), expiresAt, network });

    purgeAccountIfEmpty();
    return {
        nonce,
        memo: proofMemoFor(nonce),
        network,
        expiresAt: new Date(expiresAt).toISOString(),
    };
}

/**
 * Verify that a transaction proves control of an account.
 *
 * The three checks are the ones that cannot be spoofed: the transaction must
 * have succeeded, its fee payer must be the claimed account, and its memo must
 * carry the single-use nonce issued to that account.
 *
 * @param {{accountId: string, nonce: string, transactionId: string,
 *          queryRecord: (transactionId: string) => Promise<{status: string,
 *              payerAccountId: string|null, memo: string}|null>,
 *          now?: number}} params
 * @returns {Promise<{ok: boolean, reason?: string}>} never throws
 */
async function verifyTransactionProof({ accountId, nonce, transactionId, queryRecord, now = Date.now() }) {
    const account = String(accountId || '').trim();

    if (!account) return { ok: false, reason: 'No account was named.' };
    if (typeof transactionId !== 'string' || !transactionId.trim()) {
        return { ok: false, reason: 'No proof transaction was supplied.' };
    }
    if (typeof queryRecord !== 'function') {
        return { ok: false, reason: 'No way to read the transaction.' };
    }

    // Look the nonce up before spending a network request. An unknown nonce is a
    // local rejection, so flooding cannot amplify into mirror-node traffic.
    const record = typeof nonce === 'string' ? challenges.get(account)?.get(nonce) : undefined;
    if (!record) return { ok: false, reason: 'Unknown or already-used proof nonce.' };
    if (now > record.expiresAt) {
        challenges.get(account)?.delete(nonce);
        return { ok: false, reason: 'Proof challenge expired. Request a new one.' };
    }

    let txRecord;
    try {
        txRecord = await queryRecord(transactionId.trim());
    } catch (error) {
        return { ok: false, reason: `Could not read the proof transaction: ${error.message}` };
    }

    // The reader distinguishes "no such transaction" from "could not ask"; a
    // null here means the mirror node positively holds no such transaction,
    // which for a just-submitted proof usually means it has not been indexed yet.
    if (!txRecord) {
        return { ok: false, reason: 'The proof transaction could not be found on the network.' };
    }

    if (txRecord.status !== 'SUCCESS') {
        return {
            ok: false,
            reason: `The proof transaction did not succeed (${txRecord.status ?? 'unknown status'}).`,
        };
    }

    // The fee payer is the account that signed and paid. The network assigned
    // it, so it is authoritative: nobody can attach someone else's payer to
    // their own transaction.
    if (txRecord.payerAccountId !== account) {
        return {
            ok: false,
            reason: `The proof transaction was paid for by ${txRecord.payerAccountId ?? 'an unknown account'}, not ${account}.`,
        };
    }

    if (!String(txRecord.memo ?? '').includes(nonce)) {
        return { ok: false, reason: 'The proof transaction does not carry this challenge nonce.' };
    }

    // Single use, consumed only on success.
    challenges.get(account)?.delete(nonce);
    return { ok: true, accountId: account, network: record.network };
}

module.exports = {
    issueProofChallenge,
    verifyTransactionProof,
    proofMemoFor,
    _resetChallenges,
    CHALLENGE_TTL_MS,
};