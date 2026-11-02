const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseTransactionRecord } = require('../mirror-node');

// Verifying a settled trade and a gateway attestation both need more than the
// three facts an offer proof needs: they check that a sum of money actually
// moved to the right account, that a token was actually credited, and when the
// network reached consensus.
//
// Every field name here was taken from a real testnet record rather than from
// documentation, because the two disagree. A live CRYPTOTRANSFER record reports
// the payer leg as {"account": "...", "amount": 293398} - `account`, not the
// `account_id` the mirror node's published schema names. Reading only the
// documented spelling would find no legs at all, and the trade check would
// refuse every honest payment.
//
// Amounts are carried as decimal strings rather than numbers. HBAR amounts
// routinely exceed 2^53 tinybars' worth of precision in aggregate, and a float
// round-trip would silently compare equal for values that differ by a tinybar -
// which is precisely the difference between "paid the posted amount" and "did
// not".

const record = (over = {}) => ({
    transaction_id: '0.0.1234-1792007243-875440104',
    result: 'SUCCESS',
    ...over,
});

test('the consensus timestamp becomes an ISO instant', () => {
    // The mirror node reports seconds and nanoseconds as one dotted string. The
    // attestation window is compared against real time, so it has to become a
    // real instant rather than being carried around as text.
    const r = normaliseTransactionRecord(record({ consensus_timestamp: '1792007243.875440104' }));

    assert.equal(r.consensusTimestamp, '2026-10-14T19:47:23.875Z');
});

test('a record with no consensus timestamp reads as absent, not as the epoch', () => {
    const r = normaliseTransactionRecord(record());

    assert.equal(r.consensusTimestamp, null, 'the epoch would look like a real instant');
});

test('a malformed consensus timestamp does not throw', () => {
    for (const bad of ['not-a-time', 'abc.def', '', null, 12]) {
        const r = normaliseTransactionRecord(record({ consensus_timestamp: bad }));
        assert.equal(r.consensusTimestamp, null, `gave ${JSON.stringify(bad)} -> ${r.consensusTimestamp}`);
    }
});

test('transfers are normalised with the field spelling the network actually uses', () => {
    const r = normaliseTransactionRecord(
        record({
            transfers: [
                { account: '0.0.802', amount: 293398 },
                { account: '0.0.6795547', amount: -293398 },
            ],
        }),
    );

    assert.deepEqual(r.transfers, [
        { accountId: '0.0.802', amountTinybars: '293398' },
        { accountId: '0.0.6795547', amountTinybars: '-293398' },
    ]);
});

test('the documented account_id spelling is accepted too', () => {
    // The published schema names this field account_id while live records use
    // account. Supporting only one of them fails silently in whichever direction
    // is untested.
    const r = normaliseTransactionRecord(
        record({ transfers: [{ account_id: '0.0.802', amount: 5 }] }),
    );

    assert.equal(r.transfers.length, 1);
    assert.equal(r.transfers[0].accountId, '0.0.802');
});

test('a leg with no usable amount is dropped rather than read as zero', () => {
    // A missing amount is not an amount of zero. Keeping it would let a record
    // appear to contain a zero-value transfer to the prosumer.
    const r = normaliseTransactionRecord(
        record({ transfers: [{ account: '0.0.802' }, { account: '0.0.9', amount: '7' }] }),
    );

    assert.deepEqual(r.transfers, [{ accountId: '0.0.9', amountTinybars: '7' }]);
});

test('a large amount sent as a string keeps every digit', () => {
    // The mirror node returns small amounts as JSON numbers, but the exactness
    // guarantee only applies to amounts that arrive as strings - JSON parsing
    // has already rounded a number literal by the time any code sees it. What
    // matters here is that nothing here rounds it further, and that a string
    // amount survives without passing through a double at all.
    const r = normaliseTransactionRecord(
        record({ transfers: [{ account: '0.0.802', amount: '9007199254740993' }] }),
    );

    assert.equal(r.transfers[0].amountTinybars, '9007199254740993');
});

test('a whole-numbered JSON amount is not given a fractional part', () => {
    const r = normaliseTransactionRecord(record({ transfers: [{ account: '0.0.802', amount: 293398 }] }));

    assert.equal(r.transfers[0].amountTinybars, '293398');
});

test('an amount that is not a whole number of tinybars is refused', () => {
    // Hedera transfers move whole tinybars. A fractional amount means the record
    // is not what it claims to be, and truncating it would understate a payment.
    const r = normaliseTransactionRecord(record({ transfers: [{ account: '0.0.802', amount: '10.5' }] }));

    assert.deepEqual(r.transfers, [], 'a fractional amount must not be silently truncated');
});

test('the transaction fee is carried exactly, not as a float', () => {
    const r = normaliseTransactionRecord(record({ charged_tx_fee: 293398 }));

    assert.equal(r.transactionFeeTinybars, '293398');
    assert.equal(typeof r.transactionFeeTinybars, 'string');
});

test('a record with no fee reports none rather than zero', () => {
    // Zero fee would make the buyer-side arithmetic balance by accident.
    const r = normaliseTransactionRecord(record());

    assert.equal(r.transactionFeeTinybars, null);
});

test('token transfers are normalised with their token id', () => {
    const r = normaliseTransactionRecord(
        record({
            token_transfers: [
                { account_id: '0.0.6243111', token_id: '0.0.6241546', amount: 1560 },
                { account_id: '0.0.6242999', token_id: '0.0.6241546', amount: -1560 },
            ],
        }),
    );

    assert.deepEqual(r.tokenTransfers, [
        { accountId: '0.0.6243111', tokenId: '0.0.6241546', amount: '1560' },
        { accountId: '0.0.6242999', tokenId: '0.0.6241546', amount: '-1560' },
    ]);
});

test('a record with no token transfers reports none, not an error', () => {
    const r = normaliseTransactionRecord(record());

    assert.deepEqual(r.tokenTransfers, []);
});

test('a token leg naming no token is not presented as a token leg', () => {
    // Presenting a leg with no token id as one would let the credit check treat
    // an HBAR payment as a token credit - the exact forgery that was fixed once
    // already and would return through this path.
    const r = normaliseTransactionRecord(
        record({ token_transfers: [{ account_id: '0.0.6243111', amount: 100 }] }),
    );

    assert.deepEqual(r.tokenTransfers, []);
});

test('the transaction name is carried, so HCS can be told from an HTS mint', () => {
    // The attestation route verifies an HCS message submit and an HTS credit as
    // two different transactions. Checking that the reported id really is of the
    // expected kind is what stops one being submitted in place of the other.
    assert.equal(normaliseTransactionRecord(record({ name: 'CONSENSUSSUBMITMESSAGE' })).name, 'CONSENSUSSUBMITMESSAGE');
    assert.equal(normaliseTransactionRecord(record({ name: 'TOKENTRANSFER' })).name, 'TOKENTRANSFER');
    assert.equal(normaliseTransactionRecord(record()).name, null);
});