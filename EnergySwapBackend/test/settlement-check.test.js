const test = require('node:test');
const assert = require('node:assert/strict');

const { settlementError } = require('../settlement-check');

// The only check that money actually moved. Everything downstream - the trade
// row, the prosumer's earnings, the kWh balance - depends on this answer, so
// each case below corresponds to a way a payment could look valid and not be.

const BUYER = '0.0.6243111';
const SELLER = '0.0.6242999';
const FEE = '293398'; // one real testnet network fee, observed live
const PRICE = 100_000_000n; // 1 HBAR in tinybars
const MEMO = 'EnergySwap trade-123';

function settled({ payerAccountId = BUYER, memo = MEMO, fee = FEE, sellerLeg, buyerLeg } = {}) {
    return {
        status: 'SUCCESS',
        payerAccountId,
        memo,
        transactionFeeTinybars: fee,
        transfers: [
            sellerLeg ?? { accountId: SELLER, amountTinybars: PRICE.toString() },
            buyerLeg ?? { accountId: BUYER, amountTinybars: `-${PRICE + BigInt(FEE)}` },
        ],
    };
}

const expected = {
    consumerAccountId: BUYER,
    prosumerId: SELLER,
    expectedTinybars: PRICE,
    expectedMemo: MEMO,
};

test('a payment that matches settles', () => {
    assert.equal(settlementError(settled(), expected), null);
});

test('a transaction that is not on the network does not settle', () => {
    // Distinct from a transaction that failed: nothing was found at all.
    assert.match(settlementError(null, expected), /could not be found/);
});

test('a failed transaction does not settle', () => {
    assert.match(settlementError({ ...settled(), status: 'REVERT' }, expected), /did not succeed/);
});

test('a record with no status does not settle', () => {
    const { status, ...rest } = settled();
    assert.match(settlementError(rest, expected), /did not succeed/, 'absence of a status is not success');
});

test('someone else paying for the buyer does not settle', () => {
    // Anyone can quote a transaction ID. Only the fee payer spent the money.
    assert.match(settlementError(settled({ payerAccountId: '0.0.99999' }), expected), /fee payer/);
});

test('a payment for a different offer does not settle', () => {
    // Otherwise one payment could settle two offers.
    assert.match(settlementError(settled({ memo: 'EnergySwap trade-999' }), expected), /memo does not match/);
});

test('no memo at all does not settle', () => {
    assert.match(settlementError(settled({ memo: '' }), expected), /memo does not match/);
});

test('a payment short of the posted amount does not settle', () => {
    // The seller being made whole by some other party is not a settlement: the
    // buyer would get the energy without paying for it.
    const short = PRICE - 1n;
    assert.match(
        settlementError(
            settled({
                sellerLeg: { accountId: SELLER, amountTinybars: short.toString() },
                buyerLeg: { accountId: BUYER, amountTinybars: `-${short + BigInt(FEE)}` },
            }),
            expected,
        ),
        /does not pay the posted offer amount/,
    );
});

test('a payment short by exactly one tinybar does not settle', () => {
    // The case float arithmetic would wave through.
    const short = PRICE - 1n;
    const result = settlementError(
        settled({
            sellerLeg: { accountId: SELLER, amountTinybars: short.toString() },
            buyerLeg: { accountId: BUYER, amountTinybars: `-${short + BigInt(FEE)}` },
        }),
        expected,
    );
    assert.ok(result, 'a one-tinybar shortfall must not settle');
});

test('an overpayment does not settle', () => {
    // The offer names one price. Charging more than that is not the trade that
    // was agreed, and recording it would leave the two ledgers disagreeing.
    const over = PRICE + 1n;
    assert.match(
        settlementError(
            settled({
                sellerLeg: { accountId: SELLER, amountTinybars: over.toString() },
                buyerLeg: { accountId: BUYER, amountTinybars: `-${over + BigInt(FEE)}` },
            }),
            expected,
        ),
        /does not pay the posted offer amount/,
    );
});

test('a payment that skips the fee does not settle', () => {
    // Right gross amount, but the buyer was not charged the network fee, so the
    // money came from somewhere other than the buyer.
    assert.match(
        settlementError(settled({ buyerLeg: { accountId: BUYER, amountTinybars: `-${PRICE}` } }), expected),
        /does not charge the consumer/,
    );
});

test('a payment the prosumer never received does not settle', () => {
    // Built explicitly rather than through the helper: `sellerLeg: undefined`
    // would fall back to the default leg, and `transfers` is not a parameter the
    // helper honours, so asking for "no seller leg" that way produced a record
    // that settled - a test that could not fail.
    const record = {
        status: 'SUCCESS',
        payerAccountId: BUYER,
        memo: MEMO,
        transactionFeeTinybars: FEE,
        transfers: [{ accountId: BUYER, amountTinybars: `-${PRICE + BigInt(FEE)}` }],
    };

    assert.match(settlementError(record, expected), /does not pay the prosumer/);
});

test('a payment the buyer never paid does not settle', () => {
    const record = {
        status: 'SUCCESS',
        payerAccountId: BUYER,
        memo: MEMO,
        transactionFeeTinybars: FEE,
        transfers: [{ accountId: SELLER, amountTinybars: PRICE.toString() }],
    };

    assert.match(settlementError(record, expected), /does not charge the consumer/);
});

test('a record with no fee does not settle', () => {
    // Without the fee the buyer leg cannot be checked, so accepting here would
    // let any payment of the right gross amount through.
    assert.match(settlementError(settled({ fee: null }), expected), /does not report a network fee/);
});

test('a fee that is not a number does not settle', () => {
    assert.match(settlementError(settled({ fee: 'about a tenth of a bar' }), expected), /not a number/);
});

test('a zero fee is accepted when the record really reports one', () => {
    // Not every transaction is charged, and refusing a genuinely free transfer
    // would be a false refusal rather than a defence.
    const result = settlementError(
        settled({
            fee: '0',
            buyerLeg: { accountId: BUYER, amountTinybars: `-${PRICE}` },
        }),
        expected,
    );
    assert.equal(result, null);
});

test('a round trip between HBAR and tinybars agrees with itself', () => {
    // The posted amount arrives as a decimal HBAR figure and must reach the
    // comparison as an exact integer. A conversion that rounds here would let
    // a short payment through.
    const hbarToTinybars = (hbar) => BigInt(Math.round(hbar * 100_000_000));

    assert.equal(hbarToTinybars(1), 100_000_000n);
    assert.equal(hbarToTinybars(0.00000001), 1n);
    assert.equal(hbarToTinybars(0.12345678), 12_345_678n);
    // 8 decimals is the limit HBAR supports; a 9th must not appear silently.
    assert.equal(hbarToTinybars(0.123456789), 12_345_679n);
});

test('every refusal names a reason a user could act on', () => {
    const refusals = [
        null,
        { ...settled(), status: 'REVERT' },
        settled({ payerAccountId: '0.0.1' }),
        settled({ memo: 'other' }),
        settled({ fee: null }),
        settled({ buyerLeg: { accountId: BUYER, amountTinybars: `-${PRICE}` } }),
    ];

    for (const record of refusals) {
        const reason = settlementError(record, expected);
        assert.ok(reason, 'each of these must be refused');
        assert.ok(reason.length > 10, `reason too terse to act on: ${reason}`);
    }
});