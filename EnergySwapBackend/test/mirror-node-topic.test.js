const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchTopicMessage } = require('../mirror-node');

// Reading back what a transaction actually carried.
//
// The settlement route accepts an `hcsTransactionId` and used to check only that
// the transaction succeeded. That is not evidence: the meter topic has no submit
// key, so any account can submit to it, and a successful transaction carrying
// somebody else's message would have been accepted as this reading's
// attestation. The audit trail recorded against the reading - the transaction id
// and the consensus timestamp - would have pointed at an unrelated message.
//
// The fix is to read the message back and confirm it is this reading's
// attestation. That makes the recorded evidence evidence.
//
// Matching is by EXACT consensus timestamp, never by "most recent" or by
// sequence proximity. A loose match is the hole itself: an attacker submitting
// their own message would land within any window.

// The API refuses to issue attestation instructions for a message over 1024
// bytes, so a real attestation is always a single HCS chunk. The reader still
// refuses a chunked message rather than assuming, because mis-assembling chunks
// would mean verifying something other than what was submitted.
const TS = '1792008583.908472104';

const message = (chunk, over = {}) => ({
    consensus_timestamp: TS,
    sequence_number: 42,
    payer_account_id: '0.0.6243111',
    chunk: Buffer.from(chunk, 'utf8').toString('base64'),
    chunk_info: { number: 1, total: 1 },
    ...over,
});

const topicResponse = (messages) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages }),
});

const BASE = {
    mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
    topicId: '0.0.6243112',
    consensusTimestamp: TS,
};

test('returns the message carried at that exact consensus timestamp', async () => {
    const payload = JSON.stringify({ readingId: 'r-1', signature: 'abc' });

    const result = await fetchTopicMessage({
        ...BASE,
        fetchImpl: topicResponse([message(payload)]),
    });

    assert.equal(result.message, payload, 'the chunk must be decoded back to the submitted text');
    assert.equal(result.consensusTimestamp, TS);
    assert.equal(result.payerAccountId, '0.0.6243111');
    assert.equal(result.sequenceNumber, 42);
});

test('a message at any other timestamp is not returned', async () => {
    // The security property. An attacker submitting their own message to the
    // topic produces a transaction that succeeds and carries a message - just
    // not at the timestamp of the transaction being claimed as the attestation.
    const impostor = message(JSON.stringify({ readingId: 'someone-elses' }), {
        consensus_timestamp: '1792008584.000000000',
    });

    const result = await fetchTopicMessage({
        ...BASE,
        fetchImpl: topicResponse([impostor]),
    });

    assert.equal(result, null, 'a near-miss timestamp must not be accepted as the attestation');
});

test('the right message is chosen from a list containing others', async () => {
    const wanted = message('THE-ATTESTATION');
    const others = [
        message('earlier', { consensus_timestamp: '1792008000.000000000', sequence_number: 40 }),
        wanted,
        message('later', { consensus_timestamp: '1792009000.000000000', sequence_number: 44 }),
    ];

    const result = await fetchTopicMessage({ ...BASE, fetchImpl: topicResponse(others) });

    assert.equal(result.message, 'THE-ATTESTATION');
    assert.equal(result.sequenceNumber, 42);
});

test('an empty topic reads as absent, not as an error', async () => {
    // The Hedera mirror node answers 404 for a topic with no messages.
    const empty = await fetchTopicMessage({
        ...BASE,
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ _status: { messages: [] } }) }),
    });
    assert.equal(empty, null);

    const listed = await fetchTopicMessage({ ...BASE, fetchImpl: topicResponse([]) });
    assert.equal(listed, null);
});

test('a message that was split across chunks is refused, not reassembled', async () => {
    // Reassembling wrongly would mean verifying a payload the submitter did not
    // sign. A real attestation is always one chunk, because the API refuses to
    // issue instructions for anything longer.
    const chunked = message('part', { chunk_info: { number: 1, total: 3 } });

    const result = await fetchTopicMessage({ ...BASE, fetchImpl: topicResponse([chunked]) });

    assert.equal(result, null, 'a chunked message must not be accepted as a whole attestation');
});

test('a message with no topic configured is refused without a request', async () => {
    let requested = false;
    const result = await fetchTopicMessage({
        ...BASE,
        topicId: undefined,
        fetchImpl: async () => {
            requested = true;
            return topicResponse([])();
        },
    });

    assert.equal(result, null);
    assert.equal(requested, false);
});

test('a missing timestamp is refused without a request', async () => {
    // There is nothing to look up, and guessing the most recent message is
    // exactly the substitution that must never happen.
    let requested = false;
    for (const bad of [undefined, '', 'not-a-timestamp', null]) {
        const result = await fetchTopicMessage({
            ...BASE,
            consensusTimestamp: bad,
            fetchImpl: async () => {
                requested = true;
                return topicResponse([])();
            },
        });
        assert.equal(result, null, `expected a refusal for ${JSON.stringify(bad)}`);
    }
    assert.equal(requested, false);
});

test('a mirror node failure is reported rather than read as an absent message', async () => {
    // "Cannot ask" and "there is nothing there" lead to different responses, so
    // they must not collapse into the same value.
    await assert.rejects(
        fetchTopicMessage({
            ...BASE,
            fetchImpl: async () => {
                throw new Error('socket hang up');
            },
        }),
        /socket hang up/,
    );
});

test('the request is bounded by a timeout', async () => {
    const fetchImpl = (_url, options) =>
        new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });

    await assert.rejects(fetchTopicMessage({ ...BASE, fetchImpl, timeoutMs: 50 }), /did not answer within 50ms/);
});

test('the requested topic is the one asked for', async () => {
    // Identity bindings and meter attestations share this topic, so a lookup
    // against the wrong topic would return a message that is not the
    // attestation while still matching a timestamp.
    let requested = null;
    await fetchTopicMessage({
        ...BASE,
        topicId: '0.0.9876543',
        fetchImpl: async (url) => {
            requested = url;
            return topicResponse([])();
        },
    });

    assert.match(requested, /\/api\/v1\/consensus\/topics\/0\.0\.9876543\/messages/);
});