const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');

const { app } = require('../server');

// The offer's remaining energy is the ceiling on what may be claimed. The
// frontend already enforces this, but the frontend is not a control.
//
// Without the check, a caller claiming more kWh than the offer holds still had
// to pay for it, so the record landed - flagged 'reconciliation_required', with
// the offer NOT debited. Nothing anywhere transitions that status back and a
// re-POST of the same transaction returns 409 forever, so the paid trade was
// stranded permanently and invisible through /api/trades.

const OFFER_ID = 'cap-test-offer';
const BUYER = '0.0.6242888';
const SELLER = '0.0.6242999';

function withRepository(repository, fn) {
    const prior = app.locals.repository;
    app.locals.repository = repository;
    return Promise.resolve(fn()).finally(() => {
        app.locals.repository = prior;
    });
}

test('a trade cannot claim more energy than the offer holds', async () => {
    const repository = {
        async findTradeByTransactionId() {
            return null;
        },
        async getOffer() {
            return {
                id: OFFER_ID,
                prosumerId: SELLER,
                energyAmountKWh: 10,
                hbarPerKWh: 0.5,
                status: 'available',
            };
        },
        async recordTrade() {
            throw new Error('recordTrade must never be reached for an over-claimed trade');
        },
    };

    await withRepository(repository, async () => {
        const response = await request(app)
            .post('/api/record-trade')
            .send({
                consumerAccountId: BUYER,
                offerId: OFFER_ID,
                energyAmountKWh: 25,
                transactionId: '0.0.999@1.000000456',
            });

        assert.equal(response.status, 400, 'an over-claim must be refused');
        assert.match(response.body.message, /only has 10 kWh available/);
    });
});

test('a trade within the offer is not blocked by the ceiling', async () => {
    // The guard must reject only genuine over-claims. A fractional remainder is
    // the normal case once an offer has been partially bought.
    const repository = {
        async findTradeByTransactionId() {
            return null;
        },
        async getOffer() {
            return {
                id: OFFER_ID,
                prosumerId: SELLER,
                energyAmountKWh: 10.00000001,
                hbarPerKWh: 0.5,
                status: 'available',
            };
        },
        async recordTrade() {
            throw new Error('recordTrade is stubbed out; this test only proves the guard passed it');
        },
    };

    await withRepository(repository, async () => {
        const response = await request(app)
            .post('/api/record-trade')
            .send({
                consumerAccountId: BUYER,
                offerId: OFFER_ID,
                energyAmountKWh: 10,
                transactionId: '0.0.999@1.000000457',
            });

        // Getting past the ceiling and failing later (in the stubbed chain
        // verification) is success for this assertion: the 400 would mean the
        // guard rejected a legitimate claim.
        assert.notEqual(response.status, 400);
        assert.doesNotMatch(response.body?.message ?? '', /only has .* kWh available/);
    });
});