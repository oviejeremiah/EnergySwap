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

test('oracle credit failure is durably reserved and a retry cannot double-credit', async () => {
    const repository = createFakeRepository();
    const priorRepository = app.locals.repository;
    const priorConfig = app.locals.config;
    const priorFactory = app.locals.createHederaClient;
    const priorSubmit = app.locals.submitHcsMessage;
    const priorCredit = app.locals.creditEnergyTokens;
    const priorConsensusTimestamp = app.locals.getHcsConsensusTimestamp;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const operatorKey = PrivateKey.generateED25519().toString();
    const reading = {
        schemaVersion: 2,
        readingId: 'failure-recovery-1',
        meterId: 'meter-test-1',
        prosumerId: '0.0.12345',
        kwhGenerated: 15.75,
        intervalStart: new Date(Date.now() - 60_000).toISOString(),
        intervalEnd: new Date().toISOString(),
        intervalConvention: '[start,end)',
    };
    const signature = sign(null, Buffer.from(canonicalizeReading(reading)), privateKey).toString('base64');
    let creditsAttempted = 0;
    let submittedHcsMessage;

    app.locals.repository = repository;
    app.locals.config = {
        hederaNetwork: 'testnet',
        meterOraclePublicKey: publicKeyPem,
        operatorId: '0.0.12345',
        operatorKey,
        hcsTopicId: '0.0.12346',
        energyTokenId: '0.0.12347',
    };
    app.locals.createHederaClient = () => ({
        setOperator() {},
        close() {},
    });
    app.locals.submitHcsMessage = async (_client, _topicId, message) => {
        submittedHcsMessage = JSON.parse(message);
        return { transactionId: { toString: () => '0.0.12346@1234.000000001' } };
    };
    app.locals.creditEnergyTokens = async () => {
        creditsAttempted += 1;
        throw new Error('test settlement failure');
    };
    app.locals.getHcsConsensusTimestamp = async () => null;
    app.locals.getHcsConsensusTimestamp = async () => null;

    try {
        await request(app).post('/api/oracle/readings').send({ reading, signature }).expect(502);
        const saved = repository.readings.get(reading.readingId);
        assert.equal(saved.status, 'credit_pending');
        assert.match(saved.error, /reconciliation/);
        assert.equal(submittedHcsMessage.readingId, reading.readingId);
        assert.equal(submittedHcsMessage.intervalStart, reading.intervalStart);
        assert.equal(submittedHcsMessage.intervalEnd, reading.intervalEnd);
        assert.equal(submittedHcsMessage.prosumerId, reading.prosumerId);
        assert.equal(submittedHcsMessage.signature, signature);
        assert.equal(submittedHcsMessage.gatewayKeyFingerprint.length, 64);
        const evidence = await request(app).get(`/api/oracle/readings/${reading.readingId}`).expect(200);
        assert.equal(evidence.body.evidence.status, 'credit_pending');
        assert.equal(evidence.body.evidence.hcs.transactionId, '0.0.12346@1234.000000001');
        assert.equal(
            verifyMeterReading(
                evidence.body.evidence.reading,
                evidence.body.evidence.signature,
                evidence.body.evidence.gateway.publicKey,
            ),
            true,
        );
        await request(app).post('/api/oracle/readings').send({ reading, signature }).expect(409);
        assert.equal(creditsAttempted, 1);

        const secondInterval = {
            ...reading,
            readingId: 'failure-recovery-2',
            intervalStart: new Date(Date.now() - 120_000).toISOString(),
            intervalEnd: new Date(Date.now() - 60_000).toISOString(),
        };
        const secondSignature = sign(null, Buffer.from(canonicalizeReading(secondInterval)), privateKey).toString('base64');
        await request(app).post('/api/oracle/readings').send({ reading: secondInterval, signature: secondSignature }).expect(502);
        const differentIdSameInterval = { ...reading, readingId: 'duplicate-interval' };
        const intervalSignature = sign(
            null,
            Buffer.from(canonicalizeReading(differentIdSameInterval)),
            privateKey,
        ).toString('base64');
        const duplicateInterval = await request(app)
            .post('/api/oracle/readings')
            .send({ reading: differentIdSameInterval, signature: intervalSignature })
            .expect(409);
        assert.match(duplicateInterval.body.message, /interval already has an attestation/);
        assert.equal(creditsAttempted, 2);
    } finally {
        app.locals.repository = priorRepository;
        app.locals.config = priorConfig;
        app.locals.createHederaClient = priorFactory;
        app.locals.submitHcsMessage = priorSubmit;
        app.locals.creditEnergyTokens = priorCredit;
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
