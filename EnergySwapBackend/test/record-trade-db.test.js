const test = require('node:test');
const assert = require('node:assert/strict');

// This exercises the real INSERT against a real PostgreSQL schema. It exists
// because the trade-recording path was broken in a way no unit test could see:
// migration 003 added four NOT NULL columns and the INSERT never mentioned
// them, so every trade failed with SQLSTATE 23502 *after* the buyer had already
// paid. Mocking the pool would have hidden exactly that class of bug, so this
// test talks to a database.

// Loaded here rather than assumed: `node --test` starts a fresh process, so
// .env is not populated the way it is when the server boots.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describe = connectionString ? test : test.skip;

if (!connectionString) {
    console.warn(
        '[record-trade-db] skipped: neither TEST_DATABASE_URL nor DATABASE_URL is set. ' +
            'This test is the only thing that proves a trade can actually be persisted.',
    );
}

const repository = require('../repository');

const OFFER_ID = 'test-offer-record-trade';
const TRADE_ID = 'test-trade-record-trade';

const offer = {
    id: OFFER_ID,
    prosumerId: '0.0.6242999',
    energyAmountKWh: 100,
    hbarPerKWh: '0.5',
    totalHbar: '50.00000000',
};

const trade = {
    id: TRADE_ID,
    offerId: OFFER_ID,
    buyerId: '0.0.6242888',
    sellerId: '0.0.6242999',
    transactionId: '0.0.999@1.000000123',
    settlementNetwork: 'hedera-testnet',
    energyAmountKWh: 10,
    hbarAmount: '5.00000000',
    hbarPerKWh: '0.5',
    gasFeeHbar: '0.0001',
    totalHbarPaid: '5.00010000',
    hbarPriceUSD: '0.24',
    gasFeeUSD: '0.00002',
    timestamp: new Date().toISOString(),
};

async function reset(pool) {
    await pool.query('DELETE FROM trades WHERE id = $1', [TRADE_ID]);
    await pool.query('DELETE FROM offers WHERE id = $1', [OFFER_ID]);
    await pool.query(
        `INSERT INTO offers
            (id, prosumer_id, energy_amount_kwh, hbar_per_kwh, total_hbar, status,
             settlement_network, settlement_asset, seller_address, price_per_kwh, created_at)
         VALUES ($1, $2, $3, $4, $5, 'available', 'hedera-testnet', 'HBAR', $2, $4, now())
         ON CONFLICT (id) DO NOTHING`,
        [offer.id, offer.prosumerId, offer.energyAmountKWh, offer.hbarPerKWh, offer.totalHbar],
    );
}

describe('recordTrade persists against the real schema', async (t) => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString });
    t.after(() => pool.end());

    await t.test('a completed trade is written with every NOT NULL column populated', async () => {
        await reset(pool);
        const result = await repository.recordTrade(trade, pool);

        assert.equal(result.kind, 'recorded', `expected a recorded trade, got ${result.kind}`);

        const stored = await pool.query('SELECT * FROM trades WHERE id = $1', [TRADE_ID]);
        assert.equal(stored.rows.length, 1, 'the trade row must exist');

        // The four columns migration 003 added. Each was NOT NULL with no
        // default and absent from the INSERT, so a missing one here is the
        // original bug returning.
        assert.equal(stored.rows[0].buyer_address, trade.buyerId);
        assert.equal(stored.rows[0].seller_address, trade.sellerId);
        assert.equal(Number(stored.rows[0].payment_amount), Number(trade.hbarAmount));
        assert.equal(Number(stored.rows[0].payment_fee), Number(trade.gasFeeHbar));

        await pool.query('DELETE FROM trades WHERE id = $1', [TRADE_ID]);
    });

    await t.test('the offer is debited by the traded energy only', async () => {
        await reset(pool);
        await repository.recordTrade(trade, pool);

        const after = await pool.query('SELECT * FROM offers WHERE id = $1', [OFFER_ID]);
        assert.equal(Number(after.rows[0].energy_amount_kwh), 90, '100 kWh offered, 10 traded');

        await pool.query('DELETE FROM trades WHERE id = $1', [TRADE_ID]);
    });

    await t.test('re-recording the same transaction is idempotent, not a 500', async () => {
        await reset(pool);
        const first = await repository.recordTrade(trade, pool);
        assert.equal(first.kind, 'recorded');

        // The unique-violation fallback. Migration 003 renamed the constraint, so
        // a match on the old name would rethrow and surface as a 500 - telling
        // the buyer their confirmed payment could not be recorded.
        const second = await repository.recordTrade(trade, pool);
        assert.equal(second.kind, 'duplicate');
        assert.equal(second.trade.transactionId, trade.transactionId);

        await pool.query('DELETE FROM trades WHERE id = $1', [TRADE_ID]);
    });

    await t.test('a missing settlement value fails loudly before touching the database', async () => {
        await reset(pool);
        await assert.rejects(
            () => repository.recordTrade({ ...trade, hbarAmount: null }, pool),
            /paymentAmount is required/,
        );

        const stray = await pool.query('SELECT count(*)::int AS n FROM trades WHERE id = $1', [TRADE_ID]);
        assert.equal(stray.rows[0].n, 0, 'a rejected trade must leave no row behind');
    });

    await t.test('the one-to-one identity binding holds after migration 005', async () => {
        const evm = '0xabcdef0123456789abcdef0123456789abcdef01';

        await pool.query('DELETE FROM identity_bindings WHERE evm_address = $1', [evm]);

        await repository.saveIdentityBinding(
            { evmAddress: evm, hederaAccountId: '0.0.6242777', topicId: '0.0.6242998' },
            pool,
        );

        // Same wallet, different settlement account. The unique index must
        // refuse this rather than letting one identity hold several accounts.
        await assert.rejects(
            () =>
                repository.saveIdentityBinding(
                    { evmAddress: evm, hederaAccountId: '0.0.6242666', topicId: '0.0.6242998' },
                    pool,
                ),
            /identity_bindings_evm_unique|duplicate key/,
            'one wallet must not be able to hold two settlement accounts',
        );

        await pool.query('DELETE FROM identity_bindings WHERE evm_address = $1', [evm]);
    });
});