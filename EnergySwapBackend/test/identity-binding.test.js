const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normaliseEvmAddress,
    sameEvmAddress,
    isHederaAccountId,
    issueBindingNonce,
    peekNonce,
    buildAttestation,
    verifyBinding,
    fetchTopicMessages,
    BINDING_PURPOSE,
    _resetNonces,
} = require('../identity-binding');

const MIRROR = 'https://mirror.test';
const TOPIC = '0.0.9999999';
const VICTIM = '0.0.1111';
const ATTACKER = '0.0.2222';

const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

/** Replace global fetch with a mirror-node stand-in. */
function stubMirror(messages) {
    const original = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ messages }),
    });
    return () => {
        global.fetch = original;
    };
}

test.beforeEach(() => _resetNonces());

// ─── address handling ───────────────────────────────────────────────────────

test('normaliseEvmAddress lowercases and rejects malformed input', () => {
    assert.equal(normaliseEvmAddress('0xAbC0000000000000000000000000000000001234'),
        '0xabc0000000000000000000000000000000001234');
    assert.equal(normaliseEvmAddress('0xabc0000000000000000000000000000000001234'),
        '0xabc0000000000000000000000000000000001234');

    // Not addresses, or not 20 bytes.
    assert.equal(normaliseEvmAddress('0x123'), null);
    assert.equal(normaliseEvmAddress('0.0.1234'), null, 'a Hedera ID is not an EVM address');
    assert.equal(normaliseEvmAddress('not-an-address'), null);
    assert.equal(normaliseEvmAddress(''), null);
    assert.equal(normaliseEvmAddress(null), null);
    // 41 hex chars — one too many.
    assert.equal(normaliseEvmAddress(`0x${'a'.repeat(41)}`), null);
});

test('sameEvmAddress ignores case differences', () => {
    assert.ok(sameEvmAddress('0xAbC0000000000000000000000000000000001234', '0xabc0000000000000000000000000000000001234'));
    assert.ok(!sameEvmAddress('0xabc0000000000000000000000000000000001234', '0xabc0000000000000000000000000000000005678'));
});

test('isHederaAccountId rejects hex and non-canonical forms', () => {
    assert.ok(isHederaAccountId('0.0.1234'));
    assert.ok(isHederaAccountId('  0.0.1234  '));
    // The Hedera SDK's AccountId.fromString accepts these and rewrites them;
    // that silent rewrite is exactly what this guard exists to prevent.
    assert.ok(!isHederaAccountId('0x1234'), 'hex must not be accepted');
    assert.ok(!isHederaAccountId('0.0.abc'), 'non-numeric account must not be accepted');
    assert.ok(!isHederaAccountId('1234'));
    assert.ok(!isHederaAccountId('0.0.1234.5'));
});

// ─── nonces ─────────────────────────────────────────────────────────────────

test('issueBindingNonce returns a scoped, well-formed nonce', () => {
    const { nonce, expiresAt } = issueBindingNonce({
        evmAddress: '0xAbC0000000000000000000000000000000001234',
        hederaAccountId: VICTIM,
    });
    assert.match(nonce, /^[0-9a-f]{48}$/);
    assert.ok(Date.parse(expiresAt) > Date.now());

    const record = peekNonce(nonce);
    assert.equal(record.evmAddress, '0xabc0000000000000000000000000000000001234', 'stored lowercased');
    assert.equal(record.hederaAccountId, VICTIM);
});

test('issueBindingNonce refuses malformed addresses', () => {
    assert.throws(() => issueBindingNonce({ evmAddress: 'nope', hederaAccountId: VICTIM }), /EVM address/);
    assert.throws(() => issueBindingNonce({ evmAddress: '0xabc0000000000000000000000000000000001234', hederaAccountId: '0x1234' }), /Hedera account ID/);
});

test('verifyBinding refuses an unknown nonce without touching the network', async () => {
    const restore = stubMirror([]);
    try {
        const result = await verifyBinding({
            evmAddress: '0xabc0000000000000000000000000000000001234',
            hederaAccountId: VICTIM,
            nonce: 'f'.repeat(48),
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /nonce is unknown/);
    } finally {
        restore();
    }
});

test('verifyBinding refuses a nonce minted for a different identity', async () => {
    const { nonce } = issueBindingNonce({
        evmAddress: '0xabc0000000000000000000000000000000001234',
        hederaAccountId: VICTIM,
    });

    const restore = stubMirror([]);
    try {
        // Same nonce, different EVM address — must not bind.
        const crossed = await verifyBinding({
            evmAddress: '0xdef0000000000000000000000000000000005678',
            hederaAccountId: VICTIM,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(crossed.ok, false);
        assert.match(crossed.reason, /different EVM address/);

        // Same nonce, different Hedera account — must not bind either.
        const swapped = await verifyBinding({
            evmAddress: '0xabc0000000000000000000000000000000001234',
            hederaAccountId: ATTACKER,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(swapped.ok, false);
        assert.match(swapped.reason, /different Hedera account/);
    } finally {
        restore();
    }
});

// ─── the security boundary ──────────────────────────────────────────────────

test('accepts a genuine attestation paid for by the claimed Hedera account', async () => {
    const evm = '0xabc0000000000000000000000000000000001234';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });

    const attestation = buildAttestation({ evmAddress: evm, hederaAccountId: VICTIM, nonce });

    const restore = stubMirror([
        {
            payer_account_id: VICTIM,
            sequence_number: 7,
            consensus_timestamp: '1751000000.000000000',
            message: encode(attestation),
        },
    ]);

    try {
        const result = await verifyBinding({
            evmAddress: evm,
            hederaAccountId: VICTIM,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(result.ok, true);
        assert.equal(result.sequenceNumber, 7);
    } finally {
        restore();
    }
});

test('REJECTS a forged attestation: attacker submits claiming the victim', async () => {
    // This is the attack the whole module exists to stop. The attacker writes a
    // real, on-chain message naming the victim's Hedera account — but submits
    // it from their own account, so the payer is the attacker.
    const evm = '0xdead00000000000000000000000000000000dead';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });

    const forged = buildAttestation({
        evmAddress: evm,
        hederaAccountId: VICTIM, // lies about ownership
        nonce,
    });

    const restore = stubMirror([
        {
            payer_account_id: ATTACKER, // ← the truth the mirror node records
            sequence_number: 1,
            consensus_timestamp: '1751000000.000000000',
            message: encode(forged),
        },
    ]);

    try {
        const result = await verifyBinding({
            evmAddress: evm,
            hederaAccountId: VICTIM,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(result.ok, false, 'a message paid for by another account must never bind');
        assert.match(result.reason, /No matching attestation/);
    } finally {
        restore();
    }
});

test('rejects when the payer is absent entirely', async () => {
    const evm = '0xabc0000000000000000000000000000000001234';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });
    const attestation = buildAttestation({ evmAddress: evm, hederaAccountId: VICTIM, nonce });

    const restore = stubMirror([
        { sequence_number: 1, message: encode(attestation) }, // no payer_account_id
    ]);

    try {
        const result = await verifyBinding({
            evmAddress: evm,
            hederaAccountId: VICTIM,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(result.ok, false);
    } finally {
        restore();
    }
});

test('rejects an attestation whose purpose is not an identity binding', async () => {
    const evm = '0xabc0000000000000000000000000000000001234';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });

    // Something else published on the topic — a meter attestation, say — that
    // happens to carry a matching nonce. Purpose and version must be checked
    // so cross-protocol message confusion is impossible.
    const impostor = { ...buildAttestation({ evmAddress: evm, hederaAccountId: VICTIM, nonce }), purpose: 'some.other.protocol' };

    const restore = stubMirror([
        { payer_account_id: VICTIM, sequence_number: 1, message: encode(impostor) },
    ]);

    try {
        const result = await verifyBinding({
            evmAddress: evm,
            hederaAccountId: VICTIM,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(result.ok, false);
    } finally {
        restore();
    }
});

test('rejects a message that is not valid JSON', async () => {
    const evm = '0xabc0000000000000000000000000000000001234';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });

    const restore = stubMirror([
        { payer_account_id: VICTIM, sequence_number: 1, message: Buffer.from('not json').toString('base64') },
    ]);

    try {
        const result = await verifyBinding({
            evmAddress: evm,
            hederaAccountId: VICTIM,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(result.ok, false);
    } finally {
        restore();
    }
});

test('rejects when the mirror node is unreachable, without consuming the nonce', async () => {
    const evm = '0xabc0000000000000000000000000000000001234';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });

    const original = global.fetch;
    global.fetch = async () => {
        throw new Error('network down');
    };

    try {
        const result = await verifyBinding({
            evmAddress: evm,
            hederaAccountId: VICTIM,
            nonce,
            mirrorNodeUrl: MIRROR,
            topicId: TOPIC,
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /Could not read the Hedera topic/);
        assert.ok(peekNonce(nonce), 'a transient network failure must not burn the nonce');
    } finally {
        global.fetch = original;
    }
});

// ─── replay ─────────────────────────────────────────────────────────────────

test('a nonce cannot be replayed once a binding succeeds', async () => {
    const evm = '0xabc0000000000000000000000000000000001234';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });
    const attestation = buildAttestation({ evmAddress: evm, hederaAccountId: VICTIM, nonce });

    const restore = stubMirror([
        { payer_account_id: VICTIM, sequence_number: 3, message: encode(attestation) },
    ]);

    try {
        const first = await verifyBinding({
            evmAddress: evm, hederaAccountId: VICTIM, nonce, mirrorNodeUrl: MIRROR, topicId: TOPIC,
        });
        assert.equal(first.ok, true);
        assert.equal(peekNonce(nonce), null, 'nonce must be consumed');

        const second = await verifyBinding({
            evmAddress: evm, hederaAccountId: VICTIM, nonce, mirrorNodeUrl: MIRROR, topicId: TOPIC,
        });
        assert.equal(second.ok, false, 'the same attestation must not bind twice');
    } finally {
        restore();
    }
});

test('rejects messages from other topics', async () => {
    const evm = '0xabc0000000000000000000000000000000001234';
    const { nonce } = issueBindingNonce({ evmAddress: evm, hederaAccountId: VICTIM });
    const attestation = buildAttestation({ evmAddress: evm, hederaAccountId: VICTIM, nonce });

    const restore = stubMirror([
        { payer_account_id: VICTIM, sequence_number: 1, message: encode(attestation) },
    ]);

    try {
        const result = await verifyBinding({
            evmAddress: evm, hederaAccountId: VICTIM, nonce, mirrorNodeUrl: MIRROR, topicId: 'not-a-topic',
        });
        assert.equal(result.ok, false);
        assert.match(result.reason, /topicId is not a valid/);
    } finally {
        restore();
    }
});

// ─── mirror node behaviour ──────────────────────────────────────────────────

test('an empty topic 404s and is treated as no messages, not an error', async () => {
    const original = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

    try {
        const messages = await fetchTopicMessages({ mirrorNodeUrl: MIRROR, topicId: TOPIC });
        assert.deepEqual(messages, []);
    } finally {
        global.fetch = original;
    }
});

test('a 500 from the mirror node is surfaced, not silently swallowed', async () => {
    const original = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

    try {
        await assert.rejects(
            () => fetchTopicMessages({ mirrorNodeUrl: MIRROR, topicId: TOPIC }),
            /HTTP 500/,
        );
    } finally {
        global.fetch = original;
    }
});

test('the attestation payload is explicit about its purpose and version', () => {
    const attestation = buildAttestation({
        evmAddress: '0xAbC0000000000000000000000000000000001234',
        hederaAccountId: VICTIM,
        nonce: 'a'.repeat(48),
    });
    assert.equal(attestation.purpose, BINDING_PURPOSE);
    assert.equal(attestation.v, 1);
    assert.equal(attestation.evmAddress, '0xabc0000000000000000000000000000000001234', 'serialised lowercase');
    assert.equal(attestation.hederaAccountId, VICTIM);
    assert.ok(Date.parse(attestation.issuedAt) > 0);
});

test('buildAttestation rejects a short or missing nonce', () => {
    assert.throws(() => buildAttestation({ evmAddress: '0xabc0000000000000000000000000000000001234', hederaAccountId: VICTIM, nonce: 'short' }), /nonce/);
    assert.throws(() => buildAttestation({ evmAddress: '0xabc0000000000000000000000000000000001234', hederaAccountId: VICTIM }), /nonce/);
});