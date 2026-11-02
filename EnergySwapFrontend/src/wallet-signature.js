let cachedNetwork;

/**
 * Ask the API which Hedera network the platform is on, and remember it.
 *
 * Testnet now, mainnet after migration. A client built for the wrong network
 * either fails with an error that never mentions the network, or - worse -
 * appears to work against a chain nobody is reading. So the network is taken
 * from the server's own answer rather than hardcoded at a call site.
 *
 * The result is cached: the network does not change while the page is open, and
 * the trade path needs a client on every purchase.
 *
 * @returns {Promise<'testnet'|'mainnet'>}
 */
export async function resolvePlatformNetwork({ fetchImpl, baseUrl = '' } = {}) {
    if (cachedNetwork) return cachedNetwork;

    const doFetch = fetchImpl || globalThis.fetch;
    try {
        const response = await doFetch(`${baseUrl}/health/ready`, { headers: { accept: 'application/json' } });
        if (response.ok) {
            const body = await response.json();
            if (body?.network === 'mainnet' || body?.network === 'testnet') {
                cachedNetwork = body.network;
                return cachedNetwork;
            }
        }
    } catch {
        // Falling back to testnet keeps a local run working; the API's own
        // config is what ultimately decides, and it rejects mainnet unless set.
    }

    cachedNetwork = 'testnet';
    return cachedNetwork;
}

/** Test helper: forget the cached network. */
export function _resetPlatformNetwork() {
    cachedNetwork = undefined;
}

/**
 * Sign and submit the proof transaction.
 *
 * Separated from the orchestration so the flow around it - challenge, nonce,
 * account guard, error reporting - can be tested without standing up the SDK.
 *
 * The transaction is a self-transfer of one tinybar. No value moves; the only
 * effect is that a transaction exists, paid for by this account, carrying this
 * challenge's nonce in its memo.
 *
 * @returns {Promise<string>} the submitted transaction id
 */
export async function submitProofTransaction({ account, memo, signer, client }) {
    const transaction = new TransferTransaction()
        .addHbarTransfer(account, new Hbar(-1))
        .addHbarTransfer(account, new Hbar(1))
        .setTransactionId(TransactionId.generate(account))
        .setTransactionMemo(memo);

    // Sign through the wallet's own signer, then execute the signed result.
    // This is exactly what the trade path does, and the difference matters:
    // `transaction.sign(signer)` returns a value that is not directly
    // executable, which fails at `transaction.execute is not a function`.
    // The trade path has signed real HBAR transfers this way.
    const signed = await signer.signTransaction(transaction);
    const response = await signed.execute(client);
    await response.getReceipt(client);
    return response.transactionId.toString();
}

/**
 * Proving control of a Hedera account when writing to the platform.
 *
 * Offer posting is the one endpoint that does not move money, and it is the one
 * that must not be forgeable: anyone able to post an offer naming any account as
 * the producer can sell energy that does not exist. So posting requires proof
 * that the caller controls the account it claims.
 *
 * ## Why a transaction and not a message signature
 *
 * The obvious implementation - ask the wallet to sign a server-issued message -
 * could not be made to work. The wallet produced structurally valid ECDSA
 * signatures, but none of them verified against the challenge: twelve
 * combinations of digest and signature encoding, eight string encodings, and
 * DER versus raw all failed, while the same verification harness correctly
 * accepted a signature it had generated itself. The bytes the wallet signed were
 * not derivable from the message it displayed, and no amount of parameter
 * tuning recovered them.
 *
 * A transaction avoids the entire problem. The account signs it and pays the fee,
 * and the server reads the result back from the network, where the fee payer is
 * authoritative and cannot be spoofed. This is the same property that
 * `/api/record-trade` already relies on to verify a settlement.
 *
 * ## Network agnosticism
 *
 * The challenge states which network the platform is on, and the client is built
 * for that. Posting an offer therefore works with testnet HBAR now and mainnet
 * HBAR after migration, with no change to this module - the balance comes from
 * the account, not from anything the platform holds.
 */

import { Client, TransferTransaction, TransactionId, Hbar } from '@hashgraph/sdk';

/** Raised when proof of account control cannot be produced. */
export class SignatureError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = 'SignatureError';
    }
}

/**
 * Build a Hedera client for a named network.
 *
 * Injected so tests can supply a stand-in, and so the network decision comes from
 * the server's answer rather than being hardcoded at the call site.
 */
export function defaultClientFor(network) {
    return network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
}

/**
 * Prove control of an account by submitting a transaction that carries a
 * server-issued nonce.
 *
 * The transaction moves no value: it transfers a negligible amount to itself, so
 * the only cost is the network fee. What matters is that it exists, succeeded,
 * and was paid for by the account claiming control.
 *
 * @param {{accountId: string, signer: object, fetchImpl?: typeof fetch,
 *          baseUrl?: string, clientFor?: (network: string) => object,
 *          submitProof?: (params: {account: string, memo: string, network: string,
 *                                  signer: object, client: object}) => Promise<string>}} params
 * @returns {Promise<{proofNonce: string, proofTransactionId: string}>}
 *          Fields to merge into the write request body.
 * @throws {SignatureError} when the challenge cannot be fetched, the transaction
 *         cannot be signed or submitted, or the signer is a different account.
 */
export async function proveAccountControl({
    accountId,
    signer,
    fetchImpl,
    baseUrl = '',
    clientFor = defaultClientFor,
    submitProof = submitProofTransaction,
}) {
    const account = typeof accountId === 'string' ? accountId.trim() : '';
    if (!account) {
        throw new SignatureError('A Hedera account ID is required before an offer can be posted.');
    }
    if (!signer || typeof signer.signTransaction !== 'function') {
        throw new SignatureError('The Hedera wallet signer is unavailable, so this cannot be signed.');
    }

    // Guard locally: signing with the wrong account would be refused by the
    // server anyway, but only after the user approved a prompt that appeared
    // to be for the right thing.
    const signerAccount = signer.getAccountId?.()?.toString?.();
    if (signerAccount && signerAccount !== account) {
        throw new SignatureError(
            `The connected wallet is ${signerAccount}, not ${account}. ` +
                'Switch accounts in the wallet before signing.',
        );
    }

    const doFetch = fetchImpl || globalThis.fetch;
    const url =
        `${baseUrl}/api/wallet-auth/proof-challenge` +
        `?accountId=${encodeURIComponent(account)}`;

    let payload;
    try {
        const response = await doFetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new SignatureError(
                body?.message || `The API refused to issue a challenge (HTTP ${response.status}).`,
            );
        }
        payload = await response.json();
    } catch (error) {
        if (error instanceof SignatureError) throw error;
        throw new SignatureError(
            `Could not reach the API to request a proof challenge: ${error.message}`,
            error,
        );
    }

    const nonce = payload?.nonce;
    const memo = payload?.memo;
    if (typeof nonce !== 'string' || !nonce || typeof memo !== 'string' || !memo) {
        throw new SignatureError('The API did not return a usable proof challenge.');
    }

    const network = payload?.network === 'mainnet' ? 'mainnet' : 'testnet';

    const client = clientFor(network);

    let transactionId;
    try {
        transactionId = await submitProof({ account, memo, network, signer, client });
    } catch (error) {
        if (error instanceof SignatureError) throw error;
        throw new SignatureError(
            `The wallet could not submit the proof transaction: ${error?.message || error}`,
            error,
        );
    } finally {
        // close() may be absent or may return nothing; neither may turn a
        // successful proof into a failure.
        try {
            await client.close?.();
        } catch {
            /* the connection closing is not the caller's problem */
        }
    }

    if (!transactionId) {
        throw new SignatureError('The wallet did not return a transaction id for the proof.');
    }

    return { proofNonce: nonce, proofTransactionId: transactionId };
}

/**
 * Normalise a wallet signature to a base64 string.
 *
 * Retained for callers that still exchange a signature; the offer path no longer
 * does.
 *
 * @param {unknown} raw
 * @returns {string} base64, or '' when there is nothing usable.
 */
export function encodeSignature(raw) {
    if (typeof raw === 'string') return raw;
    if (raw instanceof Uint8Array) {
        let binary = '';
        for (let i = 0; i < raw.length; i += 0x8000) {
            binary += String.fromCharCode(...raw.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        return encodeSignature(new Uint8Array(raw instanceof ArrayBuffer ? raw : raw.buffer));
    }
    if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
        return encodeSignature(Uint8Array.from(raw));
    }
    return '';
}