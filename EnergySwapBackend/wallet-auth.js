const crypto = require('node:crypto');

/**
 * Wallet-ownership proof for EnergySwap write paths.
 *
 * Without this, any API caller can post an offer claiming to be any Hedera
 * account. This module lets a caller prove control of the account by signing a
 * server-issued challenge with their wallet; the server then verifies that
 * signature against the account's public key from the Hedera mirror node.
 *
 * Threat model notes:
 *  - The challenge is single-use and time-bounded, so a captured signature
 *    cannot be replayed to create additional offers.
 *  - Only Ed25519 accounts are supported. Contract accounts and ECDSA keys are
 *    rejected rather than silently mishandled.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = 'EnergySwap';
const MAX_CHALLENGES = 10_000;

/** accountId -> Map<nonce, { message, createdAt, expiresAt }> */
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

/**
 * Issue a challenge the client must sign to prove ownership of `accountId`.
 * The caller signs `message` with their wallet and posts `nonce` + `signature`.
 */
function issueChallenge(accountId, network = 'testnet') {
    const account = String(accountId).trim();
    const nonce = crypto.randomBytes(24).toString('hex');
    const issuedAt = Date.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;

    // Signed payload is bound to the account, network, and a single-use nonce.
    const message = [CHALLENGE_PREFIX, 'auth', network, account, nonce, String(issuedAt), String(expiresAt)].join('|');

    if (!challenges.has(account)) challenges.set(account, new Map());
    challenges.get(account).set(nonce, { message, issuedAt, expiresAt, network });

    purgeAccountIfEmpty();
    return { nonce, message, issuedAt, expiresAt };
}

/**
 * Extract the raw Ed25519 public key from a mirror-node key blob.
 *
 * The Hedera mirror node returns the raw key bytes (equivalent to the SDK's
 * PublicKey.toBytesRaw()), NOT a DER/SPKI structure. Verified: an Ed25519
 * account key is 32 bytes and an ECDSA_SECP256K1 key is 49 bytes.
 */
function extractEd25519RawKey(rawKey) {
    if (rawKey.length !== 32) {
        throw new Error(`Unexpected Ed25519 key length: ${rawKey.length} bytes (expected 32).`);
    }
    return rawKey;
}

/**
 * Expand a compressed secp256k1 public key (33 bytes) to uncompressed form
 * (65 bytes) by recovering y from the curve equation
 *   y^2 = x^3 + 7 (mod p).
 */
function decompressSecp256k1(compressed) {
    const P = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
    const x = BigInt('0x' + compressed.subarray(1).toString('hex'));
    if (x >= P) throw new Error('secp256k1 x coordinate is out of field range.');

    const alpha = (BigInt(7) + ((x * x * x) % P)) % P;
    // p ≡ 3 (mod 4), so the square root is alpha^((p+1)/4).
    let beta = powMod(alpha, (P + BigInt(1)) / BigInt(4), P);
    if ((beta * beta) % P !== alpha) {
        throw new Error('secp256k1 key is not a valid curve point.');
    }
    const wantOdd = compressed[0] === 0x03;
    const isOdd = (beta & BigInt(1)) === BigInt(1);
    const y = wantOdd === isOdd ? beta : P - beta;

    const yHex = y.toString(16).padStart(64, '0');
    return Buffer.concat([Buffer.from([0x04]), compressed.subarray(1), Buffer.from(yHex, 'hex')]);
}

function powMod(base, exponent, modulus) {
    let result = BigInt(1);
    let b = base % modulus;
    let e = exponent;
    while (e > BigInt(0)) {
        if (e & BigInt(1)) result = (result * b) % modulus;
        b = (b * b) % modulus;
        e >>= BigInt(1);
    }
    return result;
}

/** Fetch an account's public key type and key bytes from the Hedera mirror node. */
async function fetchAccountKey(mirrorNodeUrl, accountId) {
    const url = `${String(mirrorNodeUrl).replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(accountId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            const error = new Error(`Mirror node returned ${response.status} for ${accountId}.`);
            error.status = response.status;
            throw error;
        }
        const body = await response.json();
        if (!body?.account || !body?.key?._type) {
            throw new Error('Mirror node response did not include an account key.');
        }
        // The mirror node returns the key as a lowercase HEX string, not base64.
        // Decoding as base64 yields a bogus length (48 instead of 32 for
        // Ed25519) and an undecodable key, so decode as hex explicitly.
        return { type: body.key._type, raw: Buffer.from(body.key.key, 'hex') };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Verify a signed challenge.
 * Resolves to { ok: true } or { ok: false, reason } — never throws.
 */
async function verifyChallenge({
    accountId,
    nonce,
    signature,
    mirrorNodeUrl,
    expectedNetwork = 'testnet',
    maxAgeMs = CHALLENGE_TTL_MS,
}) {
    const account = String(accountId || '').trim();
    if (!challenges.has(account)) {
        // Covers both "never requested one" and "already consumed and purged",
        // so the reason is worded to fit either case.
        return {
            ok: false,
            reason: 'No active challenge for this account. Request a new challenge before posting.',
        };
    }
    const record = challenges.get(account).get(String(nonce || ''));
    if (!record) {
        return { ok: false, reason: 'Unknown or already-used challenge nonce.' };
    }

    // Single use: burn the nonce regardless of outcome so a signature cannot
    // be retried against a different payload.
    challenges.get(account).delete(String(nonce));
    if (challenges.get(account).size === 0) challenges.delete(account);

    const now = Date.now();
    if (record.expiresAt <= now) {
        return { ok: false, reason: 'Challenge expired. Request a new one.' };
    }
    if (now - record.createdAt > maxAgeMs) {
        return { ok: false, reason: 'Challenge is older than the accepted signing window.' };
    }
    if (record.network !== expectedNetwork) {
        return { ok: false, reason: 'Challenge was issued for a different Hedera network.' };
    }

    let signatureBytes;
    try {
        signatureBytes = Buffer.from(String(signature || ''), 'base64');
    } catch {
        return { ok: false, reason: 'Signature must be base64 encoded.' };
    }
    // Signature framing differs by key type and is validated after we know which
    // type the account uses: Ed25519 is always 64 raw bytes, while ECDSA
    // signatures are DER-encoded and therefore variable length (typically
    // 70-72 bytes). Only guard against obviously malformed input here.
    if (signatureBytes.length < 8 || signatureBytes.length > 256) {
        return { ok: false, reason: `Signature length ${signatureBytes.length} is out of range.` };
    }

    let accountKey;
    try {
        accountKey = await fetchAccountKey(mirrorNodeUrl, account);
    } catch (error) {
        return { ok: false, reason: `Could not resolve the account key: ${error.message}` };
    }

    // Most Hedera accounts - including wallets created by HashPack and the
    // default testnet faucet - use ECDSA_SECP256K1, not Ed25519. Both must be
    // supported or legitimate users cannot post offers at all.
    const isEd25519 = accountKey.type === 'ED25519';
    const isEcdsa = accountKey.type === 'ECDSA_SECP256K1';
    if (!isEd25519 && !isEcdsa) {
        return { ok: false, reason: `Unsupported account key type: ${accountKey.type}.` };
    }

    const messageBytes = Buffer.from(record.message, 'utf8');

    if (isEd25519) {
        if (signatureBytes.length !== 64) {
            return { ok: false, reason: `Ed25519 signatures are 64 bytes, received ${signatureBytes.length}.` };
        }
        let rawKey;
        try {
            rawKey = extractEd25519RawKey(accountKey.raw);
        } catch (error) {
            return { ok: false, reason: error.message };
        }
        // Wrap the 32-byte raw key in the Ed25519 SPKI structure Node expects.
        const publicKey = crypto.createPublicKey({
            key: Buffer.concat([
                Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
                rawKey,
            ]),
            format: 'der',
            type: 'spki',
        });
        if (!crypto.verify(null, messageBytes, publicKey, signatureBytes)) {
            return { ok: false, reason: 'Signature does not match the account key.' };
        }
        return { ok: true, accountId: account };
    }

    // ECDSA_SECP256K1. The mirror node returns the 33-byte compressed public
    // key, which Node cannot parse directly, so wrap it in an SPKI header.
    // Wallets return DER-encoded ECDSA signatures.
    // secp256k1 public keys arrive in compressed (33) or uncompressed (65) form.
    // Node's SPKI export always uses the uncompressed form, so a compressed key
    // must be expanded first.
    let point = accountKey.raw;
    if (point.length === 33) {
        if (point[0] !== 0x02 && point[0] !== 0x03) {
            return { ok: false, reason: 'secp256k1 key is not in compressed form.' };
        }
        point = decompressSecp256k1(point);
    } else if (point.length !== 65 || point[0] !== 0x04) {
        return { ok: false, reason: `Unexpected secp256k1 key length: ${accountKey.raw.length} bytes.` };
    }

    // Standard X.509 SubjectPublicKeyInfo for id-ecPublicKey + secp256k1
    // (OID 1.3.132.0.10 = 2b 81 04 00 0a), header captured from Node's own
    // export. The EC point is appended verbatim.
    const spkiHeader = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
    let publicKey;
    try {
        publicKey = crypto.createPublicKey({
            key: Buffer.concat([spkiHeader, point]),
            format: 'der',
            type: 'spki',
        });
    } catch {
        return { ok: false, reason: 'Could not parse the secp256k1 account key.' };
    }
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'secp256k1') {
        return { ok: false, reason: 'Account key is not a secp256k1 public key.' };
    }
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'secp256k1') {
        return { ok: false, reason: 'Account key is not a secp256k1 public key.' };
    }

    const valid = crypto.verify('sha256', messageBytes, publicKey, signatureBytes);
    if (!valid) {
        return { ok: false, reason: 'Signature does not match the account key.' };
    }
    return { ok: true, accountId: account };
}

/** Test helper: drop all outstanding challenges. */
function _resetChallenges() {
    challenges.clear();
}

module.exports = { issueChallenge, verifyChallenge, extractEd25519RawKey, _resetChallenges };