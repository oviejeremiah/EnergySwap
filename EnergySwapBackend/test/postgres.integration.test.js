const assert = require('node:assert/strict');
const test = require('node:test');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = testDatabaseUrl
    ? test
    : (name, callback) => test(name, { skip: 'Set TEST_DATABASE_URL to a disposable PostgreSQL test database.' }, callback);

if (testDatabaseUrl) {
    const parsedUrl = new URL(testDatabaseUrl);
    if (!/(^|_)test($|_)/i.test(decodeURIComponent(parsedUrl.pathname.slice(1)))) {
        throw new Error('TEST_DATABASE_URL must point to a dedicated database with "test" in its name.');
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('PostgreSQL integration tests cannot run with NODE_ENV=production.');
    }
    process.env.DATABASE_URL = testDatabaseUrl;
}

const database = require('../database');
const repository = require('../repository');

integrationTest('PostgreSQL migrations, idempotency, and concurrent offer settlement', async () => {
    await database.migrate();
    const pool = database.getPool();
    await pool.query('TRUNCATE meter_readings, trades, offers CASCADE');

    const offer = await repository.createOffer({
        id: 'test-offer-concurrent',
        prosumerId: '0.0.12345',
        energyAmountKWh: 10,
        hbarPerKWh: 0.5,
        totalHbar: 5,
        timestamp: new Date().toISOString(),
    });
    assert.equal(offer.energyAmountKWh, 10);

    const trade = (transactionId) => ({
        id: `trade-${transactionId}`,
        offerId: offer.id,
        buyerId: '0.0.54321',
        sellerId: '0.0.12345',
        transactionId,
        energyAmountKWh: '7.00000000',
        hbarAmount: 3.5,
        hbarPerKWh: 0.5,
        gasFeeHbar: 0.01,
        totalHbarPaid: 3.51,
        hbarPriceUSD: 0.08,
        gasFeeUSD: '0.000800',
        timestamp: new Date().toISOString(),
    });
    const [first, second] = await Promise.all([
        repository.recordTrade(trade('test-tx-concurrent-a')),
        repository.recordTrade(trade('test-tx-concurrent-b')),
    ]);
    assert.deepEqual(
        [first.kind, second.kind].sort(),
        ['recorded', 'reconciliation_required'],
    );
    const openOffers = await repository.listOffers({ availableOnly: true });
    assert.equal(openOffers.length, 1);
    assert.equal(openOffers[0].energyAmountKWh, 3);
    assert.equal((await repository.listTrades({ completedOnly: true })).length, 1);
    assert.equal((await repository.listTrades()).length, 2);

    const duplicate = await repository.recordTrade(trade('test-tx-concurrent-a'));
    assert.equal(duplicate.kind, 'duplicate');
    assert.equal((await repository.listTrades()).length, 2);

    const reading = {
        readingId: 'test-reading-unique',
        meterId: 'meter-test',
        prosumerId: '0.0.12345',
        kwhGenerated: 1.25,
        intervalStart: new Date(Date.now() - 60_000).toISOString(),
        intervalEnd: new Date().toISOString(),
        hcsTopicId: '0.0.12346',
        gatewayPublicKey: 'test-public-key',
        gatewayKeyFingerprint: 'test-fingerprint',
        canonicalReading: '{"test":true}',
        signature: 'test-signature',
        tokenUnits: 125,
        status: 'hcs_pending',
        receivedAt: new Date().toISOString(),
    };
    const reservations = await Promise.all([
        repository.reserveMeterReading(reading),
        repository.reserveMeterReading(reading),
    ]);
    assert.equal(reservations.filter((reservation) => reservation.created).length, 1);
    assert.equal(reservations.filter((reservation) => !reservation.created).length, 1);
    const sameIntervalDifferentId = await repository.reserveMeterReading({
        ...reading,
        readingId: 'test-reading-duplicate-interval',
    });
    assert.equal(sameIntervalDifferentId.created, false);
    assert.equal(sameIntervalDifferentId.conflict, 'meter_interval');
    const updated = await repository.updateMeterReading(reading.readingId, {
        status: 'credit_pending',
        error: 'test interruption',
    });
    assert.equal(updated.status, 'credit_pending');
    assert.equal((await repository.getMeterReading(reading.readingId)).error, 'test interruption');

    await database.migrate();
});

test.after(async () => {
    if (testDatabaseUrl) await database.closePool();
});
