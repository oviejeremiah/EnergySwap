const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchTransactionRecord, fetchTopicMessage } = require('../mirror-node.js');

// A user submits a transaction and the server verifies it seconds later. Consensus
// confirms the transaction quickly, but the mirror node indexes it slightly after,
// and until then answers 404 for a transaction (or reports a topic window without
// the asked timestamp). The first version of this reader treated one 404 as final
// evidence of absence, which refused honest offers - and would refuse honest
// trades - during exactly the window a live user posts in.

const MIRROR = 'https://testnet.mirrornode.hedera.com';

const recordBody = JSON.stringify({
    transactions: [{
        transaction_id: '0.0.6243111-1793356514-667294167',
        result: 'SUCCESS',
        memo_base64: Buffer.from('EnergySwap proof: nonce-abc').toString('base64'),
        consensus_timestamp: '1793356524.823756104',
        charged_tx_fee: 140652,
        transfers: [{ account: '0.0.6243111', amount: -140652 }],
    }],
});

const topicBody = JSON.stringify({
    messages: [{
        consensus_timestamp: '1793356524.823756104',
        payer_account_id: '0.0.6243111',
        sequence_number: 1,
        // The reader reads the message via `decodeMemo(entry.chunk)`, so `chunk`
        // is the base64 message string itself.
        chunk: Buffer.from('attestation payload').toString('base64'),
    }],
});

test('fetchTransactionRecord recovers a transaction that indexes after the first 404', async () => {
    const responses = [
        { ok: false, status: 404, json: async () => ({}) },
        { ok: true, status: 200, json: async () => JSON.parse(recordBody) },
    ];
    let call = 0;
    const result = await fetchTransactionRecord({
        mirrorNodeUrl: MIRROR,
        transactionId: '0.0.6243111-1793356514-667294167',
        fetchImpl: async () => responses[call++],
    });

    assert.ok(result !== null);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.payerAccountId, '0.0.6243111');
    assert.ok(result.memo.includes('nonce-abc'));
});

test('fetchTransactionRecord still reports absence (null) once the retry bound is exhausted', async () => {
    let calls = 0;
    const result = await fetchTransactionRecord({
        mirrorNodeUrl: MIRROR,
        transactionId: '0.0.6243111-1793356514-667294167',
        fetchImpl: async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; },
    });

    assert.equal(result, null);
    // 500 + 1000 + 2000 delay schedule means four attempts.
    assert.equal(calls, 4);
});

test('fetchTopicMessage recovers a message the window did not contain on the first pass', async () => {
    const responses = [
        // First pass: indexed messages exist but not the asked timestamp.
        { ok: true, status: 200, json: async () => ({ messages: [] }) },
        { ok: true, status: 200, json: async () => JSON.parse(topicBody) },
    ];
    let call = 0;
    const result = await fetchTopicMessage({
        mirrorNodeUrl: MIRROR,
        topicId: '0.0.6243156',
        consensusTimestamp: '1793356524.823756104',
        fetchImpl: async () => responses[call++],
    });

    assert.ok(result !== null);
    assert.equal(result.message, 'attestation payload');
    assert.equal(result.payerAccountId, '0.0.6243111');
});

test('fetchTopicMessage still reports absence (null) once the retry bound is exhausted', async () => {
    let calls = 0;
    const result = await fetchTopicMessage({
        mirrorNodeUrl: MIRROR,
        topicId: '0.0.6243156',
        consensusTimestamp: '1793356524.823756104',
        fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ messages: [] }) }; },
    });

    assert.equal(result, null);
    assert.equal(calls, 4);
});

test('fetchTopicMessage still reports absence when the topic is empty after the bound', async () => {
    let calls = 0;
    const result = await fetchTopicMessage({
        mirrorNodeUrl: MIRROR,
        topicId: '0.0.6243156',
        consensusTimestamp: '1793356524.823756104',
        fetchImpl: async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; },
    });

    assert.equal(result, null);
    assert.equal(calls, 4);
});
