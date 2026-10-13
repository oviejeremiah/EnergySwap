const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const request = require('supertest');

const { app, htsCreditError } = require('../server');
const { canonicalizeReading, verifyMeterReading } = require('../oracle-attestation');

// End-to-end test of the gateway handshake WITHOUT touching Hedera.
//
// The gateway is the party that owns the signing keys. What matters here is
// that it can produce a reading the API accepts, that the API hands back exact
// settlement instructions, and that the reported transactions are verified
// before a reading is marked credited. The actual chain submission needs a
// funded Hedera account, so the client is stubbed at that single boundary.

function createFakeRepository() {
    const readings = new Map();
    return {
        readings,
        async checkDatabase() {},
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
                return { created: false, conflict: 'meter_interval', reading: prior };
            }
            const record = { ...reading, status: reading.status, error: null };
            readings.set(reading.readingId, record);
            return { created: true, reading: record };
        },
        async updateMeterReading(readingId, updates) {
            const record = { ...readings.get(readingId), ...updates };
            readings.set(readingId, record);
            return record;
        },
    };
}

/** A stand-in for the gateway's Ed25519 signing identity. */
function makeGatewayIdentity() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        privateKey,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        signReading(reading) {
            return sign(null, Buffer.from(canonicalizeReading(reading)), privateKey).toString('base64');
        },
    };
}

function freshReading(overrides = {}) {
    const intervalEnd = new Date();
    return {
        schemaVersion: 2,
        readingId: 'gateway-e2e-1',
        meterId: 'meter-gateway-1',
        prosumerId: '0.0.12345',
        kwhGenerated: 12.5,
        readingTimestamp: intervalEnd.toISOString(),
        intervalStart: new Date(intervalEnd.getTime() - 3600_000).toISOString(),
        intervalEnd: intervalEnd.toISOString(),
        intervalConvention: '[start,end)',
        ...overrides,
    };
}

test('the gateway can attest a reading and the API returns settlement instructions it can execute', async () => {
    const repository = createFakeRepository();
    const gateway = makeGatewayIdentity();
    const priorRepository = app.locals.repository;
    const priorConfig = app.locals.config;
    const priorFactory = app.locals.createHederaClient;
    let clientOpened = 0;

    app.locals.repository = repository;
    app.locals.config = {
        hederaNetwork: 'testnet',
        meterOraclePublicKey: gateway.publicKeyPem,
        hcsTopicId: '0.0.999',
        energyTokenId: '0.0.1000',
    };
    app.locals.createHederaClient = () => {
        clientOpened += 1;
        return { close() {} };
    };

    try {
        const reading = freshReading();
        const signature = gateway.signReading(reading);

        // The signature must be verifiable with the configured public key.
        assert.equal(verifyMeterReading(reading, signature, gateway.publicKeyPem), true);

        const response = await request(app).post('/api/oracle/readings').send({ reading, signature }).expect(201);

        // Accepting and instructing must never require the platform to sign.
        assert.equal(clientOpened, 0);
        assert.equal(response.body.reading.status, 'hcs_pending');

        const { hcs, hts, reportTo } = response.body.settlement;
        assert.equal(hcs.topicId, '0.0.999');
        assert.equal(hts.tokenId, '0.0.1000');
        assert.equal(hts.prosumerId, reading.prosumerId);
        assert.equal(hts.tokenUnits, 1250, '12.5 kWh at 0.01 precision is 1250 token units');
        assert.equal(reportTo, '/api/oracle/readings/gateway-e2e-1/settlement');

        // The HCS payload is exactly what the gateway must submit verbatim.
        const payload = JSON.parse(hcs.message);
        assert.equal(payload.readingId, reading.readingId);
        assert.equal(payload.signature, signature);
        assert.equal(payload.tokenId, '0.0.1000');
        assert.equal(payload.network, 'testnet');
        assert.equal(
            Buffer.from(hcs.messageBase64, 'base64').toString('utf8'),
            hcs.message,
            'base64 and plain encodings must carry identical bytes',
        );
        assert.ok(Buffer.byteLength(hcs.message, 'utf8') <= 1024, 'must fit the HCS message limit');
    } finally {
        app.locals.repository = priorRepository;
        app.locals.config = priorConfig;
        app.locals.createHederaClient = priorFactory;
    }
});

test('energy is only released when the reported HTS transaction really credited the prosumer', () => {
    const prosumer = '0.0.12345';
    const units = 1250;
    // The credit must be in the energy token. HBAR legs carry no tokenId and
    // are scaled in tinybar, so a transfer that omits it is not evidence of a
    // token credit.
    const token = '0.0.6241546';
    const transfer = (account, tinybars, tokenId = token) => ({
        accountId: { toString: () => account },
        amount: { toTinybars: () => String(tinybars) },
        tokenId: tokenId ? { toString: () => tokenId } : null,
    });

    // Correct credit: the prosumer receives exactly the attested amount.
    assert.equal(
        htsCreditError({ transfers: [transfer('0.0.55555', -units), transfer(prosumer, units)] }, prosumer, units, token),
        null,
    );

    // A plain HBAR payment of the same size is not a token credit.
    assert.match(
        htsCreditError(
            { transfers: [transfer('0.0.55555', -units, null), transfer(prosumer, units, null)] },
            prosumer,
            units,
            token,
        ),
        /HBAR, not in energy tokens/,
    );

    // Nothing moved to the prosumer.
    assert.match(
        htsCreditError({ transfers: [] }, prosumer, units, token),
        /does not credit the prosumer/,
    );

    // Only the gateway was debited, with no matching credit.
    assert.match(
        htsCreditError({ transfers: [transfer('0.0.55555', -units)] }, prosumer, units, token),
        /does not credit the prosumer/,
    );

    // A short credit must not pass as a full one.
    assert.match(
        htsCreditError({ transfers: [transfer('0.0.55555', -999), transfer(prosumer, 999)] }, prosumer, units, token),
        /credits a different amount/,
    );

    // Crediting somebody else must not satisfy the check.
    assert.match(
        htsCreditError({ transfers: [transfer('0.0.55555', -units), transfer('0.0.99999', units)] }, prosumer, units, token),
        /does not credit the prosumer/,
    );

    // A prosumuer paying out (negative delta) is not a credit.
    assert.match(
        htsCreditError({ transfers: [transfer(prosumer, -units)] }, prosumer, units, token),
        /does not credit the prosumer/,
    );

    // A malformed record must fail closed rather than throw.
    assert.ok(htsCreditError(null, prosumer, units, token));
    assert.ok(htsCreditError({}, prosumer, units, token));
});

test('the settlement endpoint rejects incomplete reports and mismatched re-reports', async () => {
    const repository = createFakeRepository();
    const gateway = makeGatewayIdentity();
    const priorRepository = app.locals.repository;
    const priorConfig = app.locals.config;

    app.locals.repository = repository;
    app.locals.config = {
        hederaNetwork: 'testnet',
        meterOraclePublicKey: gateway.publicKeyPem,
        hcsTopicId: '0.0.999',
        energyTokenId: '0.0.1000',
    };

    try {
        // Unknown reading.
        await request(app)
            .post('/api/oracle/readings/does-not-exist/settlement')
            .send({ hcsTransactionId: '0.0.1@1.000000001', htsTransactionId: '0.0.1@1.000000002' })
            .expect(404);

        const reading = freshReading({ readingId: 'gateway-e2e-3' });
        await request(app)
            .post('/api/oracle/readings')
            .send({ reading, signature: gateway.signReading(reading) })
            .expect(201);

        // Missing the HTS transaction id.
        await request(app)
            .post(`/api/oracle/readings/${reading.readingId}/settlement`)
            .send({ hcsTransactionId: '0.0.1@1.000000001' })
            .expect(400);
    } finally {
        app.locals.repository = priorRepository;
        app.locals.config = priorConfig;
    }
});