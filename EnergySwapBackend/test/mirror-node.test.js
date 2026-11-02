const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchTransactionRecord, normaliseTransactionRecord } = require('../mirror-node');

// Reading a submitted transaction is how the platform learns who actually paid
// for it. That question can only be answered from the network, and getting it
// wrong means either refusing an honest prosumer or accepting a forged offer
// from anyone.
//
// ## Why the REST API rather than the SDK
//
// The obvious implementation - TransactionRecordQuery - cannot work here, and
// the reason is structural rather than a mistake that can be corrected.
//
// In @hashgraph/sdk 2.81.0 `Query._isPaymentRequired()` returns true, and
// `TransactionRecordQuery` does not override it. There is no public setter to
// opt out; only `setQueryPayment`/`setPaymentTransactionId`, which both need
// an operator. The SDK therefore insists:
//
//   `client` must have an `operator` or an explicit payment transaction
//
// EnergySwap deliberately holds no signing identity - prosumers and consumers
// sign for themselves, and the API only reads. Giving the API an operator to
// satisfy a query would break the platform's central guarantee, so the SDK
// route is not available at all. It was never available: /api/record-trade has
// used the same query since it was written, so settlement verification against
// the live network could not have succeeded either.
//
// The mirror node's REST API answers the same question with no key, no payment
// and no account. It is already how this service fetches account keys, so this
// is the mechanism the codebase was using successfully all along.
//
// ## The payer
//
// The fee payer is part of the transaction ID itself (shard.realm.account),
// which the network assigns. The mirror node reports the ID it recorded, so the
// payer read from it is what the network saw - not something a caller supplied.

const MEMO_TEXT = 'EnergySwap proof: abc123';

function mirrorResponse(record) {
    return async () => ({
        ok: true,
        status: 200,
        json: async () => ({ transactions: [record] }),
    });
}

test('normalises a successful record into status, payer and memo', () => {
    const result = normaliseTransactionRecord({
        transaction_id: '0.0.6243111-1792006000-000000001',
        result: 'SUCCESS',
        memo_base64: Buffer.from(MEMO_TEXT, 'utf8').toString('base64'),
    });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.payerAccountId, '0.0.6243111');
    assert.equal(result.memo, MEMO_TEXT);
});

test('accepts the @ separator the SDK uses', () => {
    // The wallet submits a transaction id in this form, so this is the shape
    // that actually arrives at the API.
    const result = normaliseTransactionRecord({
        transaction_id: '0.0.6243111@1792006000.000000001',
        result: 'SUCCESS',
    });

    assert.equal(result.payerAccountId, '0.0.6243111');
});

test('a record with no memo reads as empty rather than undefined', () => {
    const result = normaliseTransactionRecord({
        transaction_id: '0.0.6243111-1792006000-000000001',
        result: 'SUCCESS',
    });

    assert.equal(result.memo, '', 'an absent memo must be comparable, not undefined');
});

test('a memo that is not valid UTF-8 does not throw', () => {
    // Hedera memos are arbitrary bytes. Decoding one that happens not to be text
    // must not take down the request that is checking it.
    const result = normaliseTransactionRecord({
        transaction_id: '0.0.6243111-1792006000-000000001',
        result: 'SUCCESS',
        memo_base64: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'),
    });

    assert.equal(typeof result.memo, 'string');
});

test('a record missing its result is not treated as a success', () => {
    // Absence of evidence must not read as success. A record with no status
    // cannot have its payer relied on.
    const result = normaliseTransactionRecord({
        transaction_id: '0.0.6243111-1792006000-000000001',
    });

    assert.notEqual(result.status, 'SUCCESS');
});

test('a record with no transaction id yields no payer', () => {
    const result = normaliseTransactionRecord({ result: 'SUCCESS' });

    assert.equal(result.payerAccountId, null, 'no payer can be asserted without an id');
});

test('a transaction that does not exist reads as absent, not as an error', async () => {
    // "Not yet indexed" and "does not exist" must be told apart from a failure
    // to ask. A proof whose transaction has not propagated yet is worth
    // retrying; one that never existed is not.
    const notFound = await fetchTransactionRecord({
        mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
        transactionId: '0.0.6243111@1792006000.000000001',
        fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ _status: { messages: [] } }) }),
    });

    assert.equal(notFound, null);
});

test('a mirror node failure is reported, not mistaken for absence', async () => {
    // Absent and unreachable are different facts. A proof whose transaction
    // cannot be found may be worth retrying once the network has caught up; one
    // whose transaction cannot be read at all is a fault worth reporting. Both
    // refuse the proof, but only one of them should look retryable, so the
    // reader refuses to guess and surfaces the fault instead of returning null.
    await assert.rejects(
        fetchTransactionRecord({
            mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
            transactionId: '0.0.6243111@1792006000.000000001',
            fetchImpl: async () => {
                throw new Error('socket hang up');
            },
        }),
        /socket hang up/,
    );
});

test('a malformed transaction id is refused before any request is made', async () => {
    let requested = false;
    const result = await fetchTransactionRecord({
        mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
        transactionId: 'not-an-id',
        fetchImpl: async () => {
            requested = true;
            return mirrorResponse({ transaction_id: 'not-an-id', result: 'SUCCESS' });
        },
    });

    assert.equal(result.payerAccountId, null);
    assert.equal(requested, false, 'a malformed id must not be sent to the mirror node');
});

test('the payer account is validated, not merely split out', async () => {
    // A transaction id whose payer part is not an account id cannot have been
    // assigned by the network, so nothing about it can be relied on.
    const result = await fetchTransactionRecord({
        mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
        transactionId: '0.0.6243111@1792006000.000000001',
        fetchImpl: mirrorResponse({
            transaction_id: 'garbage@1792006000.000000001',
            result: 'SUCCESS',
        }),
    });

    assert.equal(result.payerAccountId, null);
});

test('a mirror node with no transaction id configured cannot reach the network', async () => {
    // Failing loudly beats silently returning "not found", which would refuse
    // every honest offer for a reason that has nothing to do with the offer.
    await assert.rejects(
        fetchTransactionRecord({
            mirrorNodeUrl: undefined,
            transactionId: '0.0.6243111@1792006000.000000001',
            fetchImpl: async () => assert.fail('must not attempt a request'),
        }),
        /mirror/i,
    );
});

test('a transaction id in SDK form is converted to the form the mirror node accepts', async () => {
    // The wallet reports a transaction as 0.0.1234@1792006000.000000001.
    // The mirror node's REST API accepts only the dash form
    // (0.0.1234-1792006000-000000001) and answers HTTP 400 to the @ form - not
    // 404, and not even for a transaction that genuinely exists.
    //
    // A stub returning 404 for a missing transaction would never have revealed
    // this: the request fails before the lookup happens, so the proof is
    // refused for a reason that has nothing to do with the proof.
    let requested = null;
    const result = await fetchTransactionRecord({
        mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
        transactionId: '0.0.6243111@1792006000.000000001',
        fetchImpl: async (url) => {
            requested = url;
            return mirrorResponse({
                transaction_id: '0.0.6243111-1792006000-000000001',
                result: 'SUCCESS',
                memo_base64: Buffer.from(MEMO_TEXT, 'utf8').toString('base64'),
            })();
        },
    });

    assert.match(
        requested,
        /0\.0\.6243111-1792006000-000000001$/,
        `the @ form was sent unconverted: ${requested}`,
    );
    assert.equal(result.payerAccountId, '0.0.6243111');
    assert.equal(result.memo, MEMO_TEXT);
});

test('an id already in REST form is left alone', async () => {
    let requested = null;
    await fetchTransactionRecord({
        mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
        transactionId: '0.0.6243111-1792006000-000000001',
        fetchImpl: async (url) => {
            requested = url;
            return mirrorResponse({ transaction_id: '0.0.6243111-1792006000-000000001', result: 'SUCCESS' })();
        },
    });

    assert.match(requested, /0\.0\.6243111-1792006000-000000001$/);
});

test('the nanosecond field is preserved exactly, not reformatted', async () => {
    // Reformatting a timestamp would silently point the lookup at a different
    // transaction. The digits must be carried through as written.
    const conversions = [
        ['0.0.1234@1792006000.000000001', '0.0.1234-1792006000-000000001'],
        ['0.0.1234@1792006000.1', '0.0.1234-1792006000-1'],
        ['0.0.1234@1792006000.000000001@7', null], // a second @ is not a transaction id
    ];

    for (const [input, expected] of conversions) {
        let requested = null;
        await fetchTransactionRecord({
            mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
            transactionId: input,
            fetchImpl: async (url) => {
                requested = url;
                return mirrorResponse({ transaction_id: '0.0.1234-1792006000-000000001', result: 'SUCCESS' })();
            },
        });

        if (expected === null) {
            assert.doesNotMatch(requested, /000000001000000001|999/, `malformed id was mangled into ${requested}`);
        } else {
            assert.ok(requested.endsWith(expected), `${input} became ${requested}, expected ${expected}`);
        }
    }
});

test('the request is bounded by a timeout', async () => {
    // A mirror node that accepts the connection and never answers would
    // otherwise hold a request open indefinitely, and this sits in front of a
    // user waiting to post an offer.
    const fetchImpl = (_url, options) =>
        new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });

    await assert.rejects(
        fetchTransactionRecord({
            mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
            transactionId: '0.0.6243111@1792006000.000000001',
            fetchImpl,
            timeoutMs: 50,
        }),
        /did not answer within 50ms/i,
    );
});