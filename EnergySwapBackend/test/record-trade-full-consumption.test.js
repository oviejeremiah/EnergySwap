const test = require('node:test');
const assert = require('node:assert/strict');

// The first-ever live trade (requestId 3bdec464…, stderr log 2026-10-30) failed
// with HTTP 500 AFTER the buyer's payment had settled on-chain: the buyer took
// the whole offer, the recorder wrote energy_amount_kwh = 0.00000000 for it,
// and the column's CHECK (energy_amount_kwh > 0) rejected that UPDATE. Partial
// purchases always left a positive remainder, so no test ever travelled this
// road. This test exists so the full-purchase path is guarded from now on.
//
// Migration 006 relaxes the constraint to >= 0; this test is written against
// the RELAXED schema. If someone later reintroduces the strict bound, this test
// goes red exactly where the live trade went red.

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describe = connectionString ? test : test.skip;

if (!connectionString) {
    console.warn(
        '[full-consumption] skipped: neither TEST_DATABASE_URL nor DATABASE_URL is set.',
    );
}

const repository = require('../repository');

const OFFER_ID = 'test-offer-full-consumption';
const TRADE_ID = 'test-trade-full-consumption';

// The real live values of the first trade, halved for clarity of name.
const LIVE_KWH = 0.1;
const LIVE_RATE = '0.01';

const trade = {
    id: TRADE_ID,
    offerId: OFFER_ID,
    buyerId: '0.0.6242449',
    sellerId: '0.0.6243111',
    transactionId: '0.0.999@2.000000456',
    settlementNetwork: 'hedera-testnet',
    energyAmountKWh: LIVE_KWH,
    hbarAmount: '0.00100000',
    hbarPerKWh: LIVE_RATE,
    gasFeeHbar: '0.00138471',
    totalHbarPaid: '0.00238471',
    hbarPriceUSD: '0.24',
    gasFeeUSD: '0.00033',
    timestamp: new Date().toISOString(),
};

describe('a trade that consumes an offer entirely still records', async (t) => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString });
    t.after(() => pool.end());

    await test('full-quantity trade completes the offer instead of violating the column check', async () => {
        await pool.query('DELETE FROM trades WHERE id = $1', [TRADE_ID]);
        await pool.query('DELETE FROM offers WHERE id = $1', [OFFER_ID]);
        await pool.query(
            `INSERT INTO offers
                (id, prosumer_id, energy_amount_kwh, hbar_per_kwh, total_hbar, status,
                 settlement_network, settlement_asset, seller_address, price_per_kwh, created_at)
             VALUES ($1, $2, $3, $4, $5, 'available', 'hedera-testnet', 'HBAR', $2, $4, now())`,
            [OFFER_ID, '0.0.6243111', LIVE_KWH, LIVE_RATE, '0.00100000'],
        );

        const result = await repository.recordTrade(trade, pool);
        assert.equal(result.kind, 'recorded');

        const offerRow = await pool.query('SELECT energy_amount_kwh, status, total_hbar FROM offers WHERE id = $1', [OFFER_ID]);
        assert.equal(Number(offerRow.rows[0].energy_amount_kwh), 0, 'the offer must end at exactly zero remaining');
        assert.equal(offerRow.rows[0].status, 'completed', 'a fully consumed offer is completed');

        await pool.query('DELETE FROM trades WHERE id = $1', [TRADE_ID]);
        await pool.query('DELETE FROM offers WHERE id = $1', [OFFER_ID]);
    });
});
