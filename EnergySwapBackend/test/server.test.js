const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const request = require('supertest');
const { canonicalizeReading, verifyMeterReading } = require('../oracle-attestation');
const { app } = require('../server');
const { PrivateKey } = require('@hashgraph/sdk');

function createFakeRepository() {
    const readings = new Map();
    const offers = [];
    return {
        readings,
        offers,
        async checkDatabase() {},
        async createOffer(offer) {
            offers.unshift(offer);
            return offer;
        },
        async getMeterReading(readingId) {
            return readings.get(readingId) || null;
        },
        async reserveMeterReading(reading) {
            const prior = [...readings.values()].find(
                (item) =>
                    item.readingId === reading.readingId ||
                    (item.meterId === reading.meterId &&
                        item.intervalStart === reading.intervalStart &&
                        item.intervalEnd === reading.intervalEnd),
            );
            if (prior) {
                return {
                    created: false,
                    conflict: prior.readingId === reading.readingId ? 'reading_id' : 'meter_interval',
                    reading: prior,
                };
            }
            readings.set(reading.readingId, reading);
            return { created: true, reading };
        },
        async updateMeterReading(readingId, updates) {
            const reading = { ...readings.get(readingId), ...updates };
            readings.set(readingId, reading);
            return reading;
        },
        async findTradeByTransactionId() {
            return null;
        },
        async listOffers({ availableOnly = false } = {}) {
            return offers.filter((offer) => !availableOnly || offer.status === 'available');
        },
        async listTrades() {
            return [];
        },
    };
}

test('health endpoints separate liveness from database readiness', async () => {
    const repository = createFakeRepository();
    app.locals.repository = repository;
    const live = await request(app).get('/health/live').expect(200);
    assert.equal(live.body.status, 'ok');
    await request(app).get('/health/ready').expect(200);

    repository.checkDatabase = async () => {
        throw new Error('database offline');
    };
    const ready = await request(app).get('/health/ready').expect(503);
    assert.deepEqual(ready.body, { status: 'not_ready' });
});

test('offer API validates input and persists well-formed offers', async () => {
    const repository = createFakeRepository();
    app.locals.repository = repository;

    await request(app)
        .post('/api/post-offer')
        .send({ prosumerId: '0.0.12', energyAmountKWh: '10junk', hbarPerKWh: 2 })
        .expect(400);
    await request(app)
        .post('/api/post-offer')
        .send({ prosumerId: 'not-an-account', energyAmountKWh: 10, hbarPerKWh: 2 })
        .expect(400);
    const response = await request(app)
        .post('/api/post-offer')
        .send({ prosumerId: '0.0.12', energyAmountKWh: 10, hbarPerKWh: 2 })
        .expect(201);
    assert.equal(response.body.offer.totalHbar, 20);
    assert.equal((await request(app).get('/api/offers').expect(200)).body.offers.length, 1);
});

test('API rejects oversized bodies and does not emit CORS access for an unknown origin', async () => {
    await request(app)
        .post('/api/post-offer')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ data: 'x'.repeat(33 * 1024) }))
        .expect(413);
    const response = await request(app)
        .get('/health/live')
        .set('Origin', 'https://untrusted.example')
        .expect(200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    await request(app).post('/api/post-offer').send('not-json').expect(415);
    await request(app).post('/api/post-offer').set('Content-Type', 'application/json').send('[]').expect(400);
});

test('a verified reading is reserved and handed to the gateway, and cannot be double-reserved', async () => {
    const repository = createFakeRepository();
    const priorRepository = app.locals.repository;
    const priorConfig = app.locals.config;
    const priorFactory = app.locals.createHederaClient;
    const priorConsensusTimestamp = app.locals.getHcsConsensusTimestamp;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const reading = {
        schemaVersion: 2,
        readingId: 'gateway-settle-1',
        meterId: 'meter-test-1',
        prosumerId: '0.0.12345',
        kwhGenerated: 15.75,
        intervalStart: new Date(Date.now() - 60_000).toISOString(),
        intervalEnd: new Date().toISOString(),
        intervalConvention: '[start,end)',
    };
    const signature = sign(null, Buffer.from(canonicalizeReading(reading)), privateKey).toString('base64');
    let clientCreated = 0;

    app.locals.repository = repository;
    app.locals.config = {
        hederaNetwork: 'testnet',
        meterOraclePublicKey: publicKeyPem,
        hcsTopicId: '0.0.12346',
        energyTokenId: '0.0.12347',
    };
    // If the platform ever needs to sign to accept a reading, this fails the test.
    app.locals.createHederaClient = () => {
        clientCreated += 1;
        return { close() {} };
    };
    app.locals.getHcsConsensusTimestamp = async () => null;

    try {
        const accepted = await request(app).post('/api/oracle/readings').send({ reading, signature }).expect(201);

        // No chain client was needed: the platform holds no signing identity.
        assert.equal(clientCreated, 0, 'accepting a reading must not open a Hedera client');
        assert.equal(accepted.body.reading.status, 'hcs_pending');

        // The gateway is told exactly what to submit, and pays its own fees.
        const settlement = accepted.body.settlement;
        assert.equal(settlement.hcs.topicId, '0.0.12346');
        assert.equal(settlement.hts.tokenId, '0.0.12347');
        assert.equal(settlement.hts.prosumerId, reading.prosumerId);
        assert.equal(settlement.hts.tokenUnits, 1575);
        assert.equal(settlement.reportTo, `/api/oracle/readings/${reading.readingId}/settlement`);

        const hcsPayload = JSON.parse(settlement.hcs.message);
        assert.equal(hcsPayload.readingId, reading.readingId);
        assert.equal(hcsPayload.prosumerId, reading.prosumerId);
        assert.equal(hcsPayload.signature, signature);
        assert.equal(hcsPayload.gatewayKeyFingerprint.length, 64);

        // Settling requires both transaction IDs.
        await request(app)
            .post(`/api/oracle/readings/${reading.readingId}/settlement`)
            .send({ hcsTransactionId: '0.0.1@1.000000001' })
            .expect(400);

        // A second submission of the same reading is refused, so the gateway can
        // never make the same energy count twice.
        await request(app).post('/api/oracle/readings').send({ reading, signature }).expect(409);

        // A different readingId claiming the same meter interval is refused.
        const sameInterval = { ...reading, readingId: 'gateway-settle-2' };
        const sameIntervalSig = sign(null, Buffer.from(canonicalizeReading(sameInterval)), privateKey).toString('base64');
        const conflict = await request(app)
            .post('/api/oracle/readings')
            .send({ reading: sameInterval, signature: sameIntervalSig })
            .expect(409);
        assert.match(conflict.body.message, /interval already has an attestation/);

        // Evidence remains publicly verifiable.
        const evidence = await request(app).get(`/api/oracle/readings/${reading.readingId}`).expect(200);
        assert.equal(
            verifyMeterReading(
                evidence.body.evidence.reading,
                evidence.body.evidence.signature,
                evidence.body.evidence.gateway.publicKey,
            ),
            true,
        );
    } finally {
        app.locals.repository = priorRepository;
        app.locals.config = priorConfig;
        app.locals.createHederaClient = priorFactory;
        app.locals.getHcsConsensusTimestamp = priorConsensusTimestamp;
    }
});

test('meter evidence endpoint exposes signed fields and public HCS verification links', async () => {
    const repository = createFakeRepository();
    const priorRepository = app.locals.repository;
    const priorConfig = app.locals.config;
    app.locals.repository = repository;
    app.locals.config = { hederaNetwork: 'testnet' };
    repository.readings.set('public-evidence-1', {
        readingId: 'public-evidence-1',
        meterId: 'meter-public',
        prosumerId: '0.0.12345',
        intervalStart: '2026-10-04T10:00:00.000Z',
        intervalEnd: '2026-10-04T10:15:00.000Z',
        intervalConvention: '[start,end)',
        kwhGenerated: 3.25,
        canonicalReading: '{"schemaVersion":2}',
        signature: 'public-signature',
        gatewayPublicKey: 'public-key-pem',
        gatewayKeyFingerprint: 'a'.repeat(64),
        hcsTopicId: '0.0.12346',
        hcsTransactionId: '0.0.12346@1728036900.000000001',
        hcsConsensusTimestamp: '2026-10-04T10:15:01.000Z',
        htsTransactionId: '0.0.12345@1728036901.000000001',
        status: 'credited',
        receivedAt: '2026-10-04T10:15:00.000Z',
        attestedAt: '2026-10-04T10:15:01.000Z',
        creditedAt: '2026-10-04T10:15:02.000Z',
    });

    try {
        const response = await request(app).get('/api/oracle/readings/public-evidence-1').expect(200);
        assert.equal(response.body.evidence.reading.meterId, 'meter-public');
        assert.equal(response.body.evidence.reading.prosumerId, '0.0.12345');
        assert.equal(response.body.evidence.reading.intervalStart, '2026-10-04T10:00:00.000Z');
        assert.equal(response.body.evidence.reading.intervalEnd, '2026-10-04T10:15:00.000Z');
        assert.equal(response.body.evidence.reading.intervalConvention, '[start,end)');
        assert.equal(response.body.evidence.hcs.consensusTimestamp, '2026-10-04T10:15:01.000Z');
        assert.match(response.body.evidence.hcs.transactionUrl, /hashscan\.io\/testnet\/transaction/);
        assert.equal(response.body.evidence.gateway.keyFingerprint, 'a'.repeat(64));
        await request(app).get('/api/oracle/readings/unknown').expect(404);
    } finally {
        app.locals.repository = priorRepository;
        app.locals.config = priorConfig;
    }
});
