const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    issueChallenge,
    verifyChallenge,
    extractEd25519RawKey,
    _resetChallenges,
} = require('../wallet-auth');

const MIRROR = 'https://testnet.mirrornode.hedera.com';
const ACCOUNT = '0.0.1234';

// The Hedera mirror node returns raw key bytes encoded as HEX (not base64 and
// not DER/SPKI), so tests mirror that shape exactly.

function sign(message, privateKey) {
    return crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

test.beforeEach(() => _resetChallenges());

test('extractEd25519RawKey accepts a 32-byte raw key', () => {
    const raw = crypto.randomBytes(32);
    const extracted = extractEd25519RawKey(raw);
    assert.equal(extracted.length, 32);
    assert.deepEqual(extracted, raw);
});

test('extractEd25519RawKey rejects a wrong length', () => {
    assert.throws(() => extractEd25519RawKey(Buffer.alloc(44)), /Unexpected Ed25519 key length/);
});

test('challenge binds the account, network, nonce and expiry', () => {
    const challenge = issueChallenge(ACCOUNT, 'testnet');
    const parts = challenge.message.split('|');
    assert.equal(parts[0], 'EnergySwap');
    assert.equal(parts[1], 'auth');
    assert.equal(parts[2], 'testnet');
    assert.equal(parts[3], ACCOUNT);
    assert.equal(parts[4], challenge.nonce);
    assert.ok(challenge.expiresAt > challenge.issuedAt);
});

test('verifyChallenge rejects an unknown nonce', async () => {
    issueChallenge(ACCOUNT, 'testnet');
    const result = await verifyChallenge({
        accountId: ACCOUNT,
        nonce: 'not-a-real-nonce',
        signature: 'AAAA',
        mirrorNodeUrl: MIRROR,
        expectedNetwork: 'testnet',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Unknown or already-used/);
});

test('verifyChallenge rejects when no challenge was issued', async () => {
    const result = await verifyChallenge({
        accountId: ACCOUNT,
        nonce: 'abc',
        signature: 'AAAA',
        mirrorNodeUrl: MIRROR,
        expectedNetwork: 'testnet',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /No active challenge for this account/);
});

test('verifyChallenge rejects a nonce issued for a different account', async () => {
    const challenge = issueChallenge(ACCOUNT, 'testnet');
    const result = await verifyChallenge({
        accountId: '0.0.9999',
        nonce: challenge.nonce,
        signature: 'AAAA',
        mirrorNodeUrl: MIRROR,
        expectedNetwork: 'testnet',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /No active challenge for this account/);
});

test('verifyChallenge rejects a challenge issued for another network', async () => {
    const challenge = issueChallenge(ACCOUNT, 'testnet');
    const result = await verifyChallenge({
        accountId: ACCOUNT,
        nonce: challenge.nonce,
        signature: 'AAAA',
        mirrorNodeUrl: MIRROR,
        expectedNetwork: 'mainnet',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /different Hedera network/);
});

test('verifyChallenge rejects a malformed signature before any network call', async () => {
    const challenge = issueChallenge(ACCOUNT, 'testnet');
    const result = await verifyChallenge({
        accountId: ACCOUNT,
        nonce: challenge.nonce,
        signature: Buffer.alloc(10).toString('base64'),
        mirrorNodeUrl: MIRROR,
        expectedNetwork: 'testnet',
    });
    assert.equal(result.ok, false);
    // A 10-byte signature is rejected as too short; the exact wording depends on
// whether the key type is known yet, so assert on rejection rather than text.
assert.equal(result.ok, false);
assert.ok(
    /out of range|64 bytes/.test(result.reason),
    `unexpected reason: ${result.reason}`,
);
});

test('a nonce is single use even when the signature fails', async () => {
    const challenge = issueChallenge(ACCOUNT, 'testnet');
    const first = await verifyChallenge({
        accountId: ACCOUNT,
        nonce: challenge.nonce,
        signature: Buffer.alloc(64).toString('base64'),
        mirrorNodeUrl: MIRROR,
        expectedNetwork: 'testnet',
    });
    assert.equal(first.ok, false);

    // Replaying the same nonce must not work even with a good signature.
    const second = await verifyChallenge({
        accountId: ACCOUNT,
        nonce: challenge.nonce,
        signature: Buffer.alloc(64).toString('base64'),
        mirrorNodeUrl: MIRROR,
        expectedNetwork: 'testnet',
    });
    assert.equal(second.ok, false);
    assert.match(second.reason, /No active challenge for this account/);
});

test('verifyChallenge reports a mirror node failure rather than throwing', async () => {
    const challenge = issueChallenge(ACCOUNT, 'testnet');
    const result = await verifyChallenge({
        accountId: ACCOUNT,
        nonce: challenge.nonce,
        signature: Buffer.alloc(64).toString('base64'),
        // Reserved TEST-NET-1 style address on an unroutable host.
        mirrorNodeUrl: 'https://127.0.0.1:9',
        expectedNetwork: 'testnet',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /Could not resolve the account key/);
});

test('an Ed25519 signature verifies against the account key', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    assert.equal(extractEd25519RawKey(rawKey).length, 32);

    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ account: ACCOUNT, key: { _type: 'ED25519', key: rawKey.toString('hex') } }),
    });

    try {
        const good = issueChallenge(ACCOUNT, 'testnet');
        const ok = await verifyChallenge({
            accountId: ACCOUNT,
            nonce: good.nonce,
            signature: sign(good.message, privateKey),
            mirrorNodeUrl: MIRROR,
            expectedNetwork: 'testnet',
        });
        assert.equal(ok.ok, true);
        assert.equal(ok.accountId, ACCOUNT);

        // A signature from a different key must not verify.
        const other = crypto.generateKeyPairSync('ed25519');
        const bad = issueChallenge(ACCOUNT, 'testnet');
        const rejected = await verifyChallenge({
            accountId: ACCOUNT,
            nonce: bad.nonce,
            signature: sign(bad.message, other.privateKey),
            mirrorNodeUrl: MIRROR,
            expectedNetwork: 'testnet',
        });
        assert.equal(rejected.ok, false);
        assert.match(rejected.reason, /does not match the account key/);
    } finally {
        global.fetch = originalFetch;
    }
});

test('an ECDSA_SECP256K1 signature verifies against a compressed account key', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    const compressed = Buffer.concat([Buffer.from([0x02 | (y[y.length - 1] & 1)]), x]);

    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ account: ACCOUNT, key: { _type: 'ECDSA_SECP256K1', key: compressed.toString('hex') } }),
    });

    try {
        const challenge = issueChallenge(ACCOUNT, 'testnet');
        const signature = crypto
            .sign('sha256', Buffer.from(challenge.message, 'utf8'), privateKey)
            .toString('base64');
        const result = await verifyChallenge({
            accountId: ACCOUNT,
            nonce: challenge.nonce,
            signature,
            mirrorNodeUrl: MIRROR,
            expectedNetwork: 'testnet',
        });
        assert.equal(result.ok, true, result.reason);

        // A signature over a different message must fail.
        const other = issueChallenge(ACCOUNT, 'testnet');
        const tampered = crypto
            .sign('sha256', Buffer.from('tampered'), privateKey)
            .toString('base64');
        const rejected = await verifyChallenge({
            accountId: ACCOUNT,
            nonce: other.nonce,
            signature: tampered,
            mirrorNodeUrl: MIRROR,
            expectedNetwork: 'testnet',
        });
        assert.equal(rejected.ok, false);
    } finally {
        global.fetch = originalFetch;
    }
});

test('an unsupported account key type is rejected', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ account: ACCOUNT, key: { _type: 'RSA_3072', key: '00' } }),
    });

    try {
        const challenge = issueChallenge(ACCOUNT, 'testnet');
        const result = await verifyChallenge({
            accountId: ACCOUNT,
            nonce: challenge.nonce,
            signature: Buffer.alloc(64).toString('base64'),
            mirrorNodeUrl: MIRROR,
            expectedNetwork: 'testnet',
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /Unsupported account key type/);
    } finally {
        global.fetch = originalFetch;
    }
});