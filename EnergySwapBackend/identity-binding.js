/**
 * On-chain identity bindings.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * EnergySwap lets a person sign in with any wallet while settling in HBAR from a
 * Hedera account. Those are deliberately different wallets: the sign-in wallet
 * should hold nothing, so compromising it yields no funds.
 *
 * But "these two wallets belong to the same person" is a claim that must be
 * provable. If the platform merely recorded it, the platform would be a single
 * trusted party — it could assert any binding, and a database loss would erase
 * every relationship.
 *
 * ── The proof ───────────────────────────────────────────────────────────────
 * The Hedera account publishes a Consensus Service (HCS) message naming the EVM
 * address. On Hedera the *payer* of a consensus message is the account that
 * signed it, and the mirror node exposes that payer publicly forever.
 *
 * So anyone can read the message and confirm the payer is the Hedera account
 * being claimed. No trust in this codebase is required.
 *
 * ── The subtlety that makes this safe or worthless ──────────────────────────
 * Nothing stops anyone submitting a message that reads
 *
 *     { "hederaAccountId": "0.0.VICTIM", "evmAddress": "0xATTACKER" }
 *
 * from their own account. The message would be real and on-chain. So the payer
 * check in `verifyBinding` is the entire security boundary: a binding is valid
 * only when the message's payer is *the account being claimed*. Drop that check
 * and this module accepts forged bindings.
 *
 * ── Replay ──────────────────────────────────────────────────────────────────
 * Each binding is bound to a single-use nonce issued by this server. An
 * attestation echoing a consumed nonce is refused, so an observed on-chain
 * attestation cannot be replayed to re-bind a different EVM address later.
 */

const crypto = require('crypto');

const BINDING_PURPOSE = 'energyswap.identity-binding.v1';

// How long an issued nonce stays usable, and how long an attestation is
// considered fresh when re-read from the chain. Short enough that a leaked
// nonce has little value, long enough to survive a wallet round trip.
const NONCE_TTL_MS = 10 * 60 * 1000;

// ─── EVM address handling ───────────────────────────────────────────────────

/**
 * Validate an EVM address and return it lowercased.
 *
 * Addresses are compared lowercased throughout. EIP-55 checksums make
 * `0xAbC…` and `0xabc…` the same account, so treating them as different would
 * let a binding be recorded against one spelling and read against another.
 * Case is presentation; it is never identity here.
 *
 * @param {string} value
 * @returns {string|null} lowercase address, or null if malformed
 */
function normaliseEvmAddress(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
    return trimmed.toLowerCase();
}

/** True when two EVM addresses denote the same account. */
const sameEvmAddress = (a, b) => {
    const left = normaliseEvmAddress(a);
    const right = normaliseEvmAddress(b);
    return left !== null && left === right;
};

/**
 * Validate a Hedera account ID strictly.
 *
 * Same strictness as `isHederaAccountId` in server.js: digits only. The Hedera
 * SDK's `AccountId.fromString` accepts hex and EVM-shaped input and silently
 * rewrites it, which would let a crafted string resolve to a different account
 * than the one the caller named.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isHederaAccountId(value) {
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value.trim());
}

// ─── Nonce store ────────────────────────────────────────────────────────────

/** nonce -> { evmAddress, hederaAccountId, createdAt } */
const pendingNonces = new Map();

/** Drop nonces that can no longer be used. Called on every issue/verify. */
function purgeExpiredNonces(now = Date.now()) {
    for (const [nonce, record] of pendingNonces) {
        if (now - record.createdAt > NONCE_TTL_MS) pendingNonces.delete(nonce);
    }
}

/**
 * Issue a single-use nonce for a binding attempt.
 *
 * The nonce is scoped to the pair it was issued for, so a nonce minted while
 * signed in as one identity cannot be spent to bind a different identity.
 *
 * @param {{evmAddress: string, hederaAccountId: string}} params
 * @returns {{nonce: string, expiresAt: string}}
 */
function issueBindingNonce({ evmAddress, hederaAccountId }) {
    const evm = normaliseEvmAddress(evmAddress);
    if (!evm) throw new Error('evmAddress is not a valid EVM address.');
    if (!isHederaAccountId(hederaAccountId)) throw new Error('hederaAccountId is not a valid Hedera account ID.');

    purgeExpiredNonces();

    const nonce = crypto.randomBytes(24).toString('hex');
    pendingNonces.set(nonce, {
        evmAddress: evm,
        hederaAccountId: hederaAccountId.trim(),
        createdAt: Date.now(),
    });

    return {
        nonce,
        expiresAt: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
    };
}

/** Inspect an issued nonce without consuming it. Used by tests and diagnostics. */
function peekNonce(nonce) {
    return pendingNonces.get(nonce) ?? null;
}

// ─── Attestation payload ────────────────────────────────────────────────────

/**
 * Build the JSON payload a Hedera account publishes to bind an EVM address.
 *
 * The client renders this; the server never trusts it. It exists so both sides
 * agree on the exact bytes, and it is verified field-by-field after parsing
 * rather than by string comparison — key ordering and whitespace differences
 * between wallets must not decide whether a binding is valid.
 *
 * @param {{evmAddress: string, evmChainId?: number, hederaAccountId: string,
 *          nonce: string, issuedAt?: string}} params
 */
function buildAttestation({ evmAddress, evmChainId = 1, hederaAccountId, nonce, issuedAt }) {
    const evm = normaliseEvmAddress(evmAddress);
    if (!evm) throw new Error('evmAddress is not a valid EVM address.');
    if (!isHederaAccountId(hederaAccountId)) throw new Error('hederaAccountId is not a valid Hedera account ID.');
    if (typeof nonce !== 'string' || nonce.length < 16) throw new Error('nonce is missing or malformed.');

    return {
        v: 1,
        purpose: BINDING_PURPOSE,
        hederaAccountId: hederaAccountId.trim(),
        evmAddress: evm,
        evmChainId: Number(evmChainId) || 1,
        nonce,
        issuedAt: issuedAt || new Date().toISOString(),
    };
}

// ─── Mirror node ────────────────────────────────────────────────────────────

const decodeMessage = (encoded) => {
    if (typeof encoded !== 'string' || encoded.length === 0) return null;
    try {
        const json = Buffer.from(encoded, 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
};

/**
 * Fetch recent consensus messages on the identity topic.
 *
 * @param {{mirrorNodeUrl: string, topicId: string, limit?: number}} params
 * @returns {Promise<Array<object>>}
 */
async function fetchTopicMessages({ mirrorNodeUrl, topicId, limit = 25 }) {
    if (!isHederaAccountId(topicId)) throw new Error('topicId is not a valid Hedera account ID.');

    const base = String(mirrorNodeUrl).replace(/\/+$/, '');
    const url = `${base}/api/v1/consensus/topics/${encodeURIComponent(topicId)}/messages?limit=${limit}&order=desc`;

    const response = await fetch(url, { headers: { accept: 'application/json' } });
    // An empty topic 404s on the Hedera mirror node. That is "no messages",
    // not an error worth failing the request over.
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Mirror node returned HTTP ${response.status}.`);

    const body = await response.json();
    return Array.isArray(body.messages) ? body.messages : [];
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Verify an on-chain identity binding.
 *
 * Accepts only when every one of these holds:
 *   1. The nonce was issued by this server, is unexpired, and is scoped to
 *      exactly this (evmAddress, hederaAccountId) pair.
 *   2. A consensus message exists on the identity topic whose decoded payload
 *      matches the requested pair and echoes that nonce.
 *   3. That message's **payer** is the claimed Hedera account. This is the
 *      security boundary — see the header.
 *
 * The nonce is consumed only on success, so a failed attempt can be retried but
 * a successful binding cannot be reused.
 *
 * @param {object} params
 * @param {string} params.evmAddress
 * @param {string} params.hederaAccountId
 * @param {string} params.nonce
 * @param {string} params.mirrorNodeUrl
 * @param {string} params.topicId
 * @param {boolean} [params.consumeNonce=true]
 * @returns {Promise<{ok: boolean, reason?: string, sequenceNumber?: number,
 *                    consensusTimestamp?: string}>}
 */
async function verifyBinding({ evmAddress, hederaAccountId, nonce, mirrorNodeUrl, topicId, consumeNonce = true }) {
    const evm = normaliseEvmAddress(evmAddress);
    if (!evm) return { ok: false, reason: 'evmAddress is not a valid EVM address.' };
    if (!isHederaAccountId(hederaAccountId)) return { ok: false, reason: 'hederaAccountId is not a valid Hedera account ID.' };

    purgeExpiredNonces();

    const record = typeof nonce === 'string' ? pendingNonces.get(nonce) : null;
    if (!record) return { ok: false, reason: 'nonce is unknown or already used.' };
    if (Date.now() - record.createdAt > NONCE_TTL_MS) {
        pendingNonces.delete(nonce);
        return { ok: false, reason: 'nonce has expired.' };
    }
    // Scoping check: the nonce must have been minted for this exact pair.
    if (!sameEvmAddress(record.evmAddress, evm)) {
        return { ok: false, reason: 'nonce was issued for a different EVM address.' };
    }
    if (record.hederaAccountId !== hederaAccountId.trim()) {
        return { ok: false, reason: 'nonce was issued for a different Hedera account.' };
    }

    let messages;
    try {
        messages = await fetchTopicMessages({ mirrorNodeUrl, topicId });
    } catch (error) {
        return { ok: false, reason: `Could not read the Hedera topic: ${error.message}` };
    }

    const claimedHedera = hederaAccountId.trim();

    for (const entry of messages) {
        // ── The payer check ──────────────────────────────────────────────
        // The Hedera account that submitted a consensus message is recorded as
        // its payer. If that is not the account being claimed, someone else
        // wrote this message and it proves nothing.
        if (String(entry.payer_account_id ?? '').trim() !== claimedHedera) continue;

        const payload = decodeMessage(entry.message);
        if (!payload) continue;

        if (payload.purpose !== BINDING_PURPOSE) continue;
        if (payload.v !== 1) continue;
        if (payload.nonce !== nonce) continue;
        if (!sameEvmAddress(payload.evmAddress, evm)) continue;
        if (String(payload.hederaAccountId ?? '').trim() !== claimedHedera) continue;

        if (consumeNonce) pendingNonces.delete(nonce);

        return {
            ok: true,
            sequenceNumber: entry.sequence_number,
            consensusTimestamp: entry.consensus_timestamp,
        };
    }

    return {
        ok: false,
        reason:
            'No matching attestation was found on the identity topic. ' +
            'Confirm the Hedera account submitted it and that a few seconds have passed.',
    };
}

/** Clear all issued nonces. Test helper. */
function _resetNonces() {
    pendingNonces.clear();
}

module.exports = {
    BINDING_PURPOSE,
    NONCE_TTL_MS,
    normaliseEvmAddress,
    sameEvmAddress,
    isHederaAccountId,
    issueBindingNonce,
    peekNonce,
    buildAttestation,
    fetchTopicMessages,
    verifyBinding,
    _resetNonces,
};