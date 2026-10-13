const test = require('node:test');
const assert = require('node:assert/strict');

// ─────────────────────────────────────────────────────────────────────────────
// Bounds on state an unauthenticated caller can allocate.
//
// Both stores live in process memory and are reachable from routes that only
// need an address. Expiry is not a bound on its own: a caller issuing faster
// than the TTL expires grows the map monotonically, and every request then pays
// a full scan of it. The ceilings in identity-binding.js are what stop that,
// and nothing else in the suite exercises them.
// ─────────────────────────────────────────────────────────────────────────────

const {
    issueBindingNonce,
    peekNonce,
    issueUnlinkChallenge,
    _resetNonces,
    _resetUnlinkChallenges,
} = require('../identity-binding');

const MIRROR = 'https://mirror.test';
const TOPIC = '0.0.9999999';
const EVM = '0xabc0000000000000000000000000000000001234';
const ACCOUNT = '0.0.1111';

// The store caps itself at MAX_PENDING_NONCES. The constant is private, so the
// bound is established by observation: well past the ceiling, the oldest entries
// must be gone and the newest must survive. A test that simply issued a handful
// of nonces would pass whether the ceiling exists or not.
const OVERFLOW = 10_050;

test.beforeEach(() => {
    _resetNonces();
    _resetUnlinkChallenges();
});

test('the binding nonce store evicts oldest-first instead of growing without bound', () => {
    const first = issueBindingNonce({ evmAddress: EVM, hederaAccountId: ACCOUNT }).nonce;
    let last = first;
    for (let i = 0; i < OVERFLOW; i += 1) {
        last = issueBindingNonce({ evmAddress: EVM, hederaAccountId: ACCOUNT }).nonce;
    }

    assert.equal(peekNonce(first), null, 'the oldest nonce must have been evicted');
    assert.ok(peekNonce(last), 'the newest nonce must still be usable');
    assert.notEqual(first, last);
});

test('the unlink challenge store is bounded too', () => {
    const first = issueUnlinkChallenge({ evmAddress: EVM });
    let last = first;
    for (let i = 0; i < OVERFLOW; i += 1) {
        last = issueUnlinkChallenge({ evmAddress: EVM });
    }

    // Every challenge for one address shares a nonce, so re-issuing must produce
    // distinct nonces; what matters is that the store stops growing.
    const { verifyUnlinkChallenge } = require('../identity-binding');
    const firstAgain = verifyUnlinkChallenge({
        evmAddress: EVM,
        nonce: first.nonce,
        signature: `0x${'11'.repeat(65)}`,
    });
    assert.equal(firstAgain.ok, false);
    assert.match(firstAgain.reason, /unknown or already used/, 'the oldest challenge must be evicted');

    const newest = verifyUnlinkChallenge({
        evmAddress: EVM,
        nonce: last.nonce,
        signature: `0x${'11'.repeat(65)}`,
    });
    assert.match(newest.reason, /does not prove control/, 'the newest challenge must survive');
});

test('the mirror-node fetch is given an abort signal, so a hanging upstream cannot pin the request', async () => {
    const { fetchTopicMessages } = require('../identity-binding');

    let seen = null;
    const priorFetch = global.fetch;
    global.fetch = async (_url, init) => {
        seen = init;
        return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    };
    try {
        await fetchTopicMessages({ mirrorNodeUrl: MIRROR, topicId: TOPIC });
    } finally {
        global.fetch = priorFetch;
    }

    assert.ok(seen, 'fetch must be called');
    assert.ok(seen.signal, 'fetch must be given a signal; without one a hanging mirror node holds the socket open');
    assert.equal(typeof seen.signal.addEventListener, 'function', 'the signal must be an AbortSignal');
});

test('a hanging mirror node is reported as a failure, not an open request', async () => {
    const { fetchTopicMessages } = require('../identity-binding');

    const priorFetch = global.fetch;
    // Emulate the upstream never answering: honour the abort signal the caller
    // supplied, exactly as a real fetch would. The wait is the real one - this
    // test is what pins the bound at 8 seconds rather than asserting a constant.
    global.fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                const error = new Error('The operation was aborted.');
                error.name = 'AbortError';
                reject(error);
            });
        });
    const startedAt = Date.now();
    try {
        await assert.rejects(
            () => fetchTopicMessages({ mirrorNodeUrl: MIRROR, topicId: TOPIC }),
            /did not respond within|Could not read the Hedera topic|request failed/,
        );
        const elapsed = Date.now() - startedAt;
        assert.ok(elapsed >= 7_000, `the fetch must actually wait for its timeout, gave up after ${elapsed}ms`);
        assert.ok(elapsed < 20_000, `the timeout must be bounded, waited ${elapsed}ms`);
    } finally {
        global.fetch = priorFetch;
    }
});