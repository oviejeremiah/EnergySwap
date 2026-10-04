const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const { canonicalizeReading, isReadingFresh, normalizeReading, verifyMeterReading } = require('../oracle-attestation');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

function createReading(overrides = {}) {
    return {
        schemaVersion: 2,
        readingId: 'reading-001',
        meterId: 'meter-001',
        prosumerId: '0.0.12345',
        intervalStart: '2026-10-03T11:45:00.000Z',
        intervalEnd: '2026-10-03T12:00:00.000Z',
        intervalConvention: '[start,end)',
        kwhGenerated: 15.75,
        ...overrides,
    };
}

function signReading(reading) {
    return sign(null, Buffer.from(canonicalizeReading(reading)), privateKey).toString('base64');
}

test('normalizes and verifies a correctly signed reading', () => {
    const reading = createReading();
    assert.equal(verifyMeterReading(reading, signReading(reading), publicKeyPem), true);
    assert.equal(normalizeReading(reading).kwhGenerated, 15.75);
});

test('rejects a reading modified after signing', () => {
    const reading = createReading();
    const signature = signReading(reading);
    assert.equal(verifyMeterReading({ ...reading, kwhGenerated: 16 }, signature, publicKeyPem), false);
});

test('rejects stale and future-dated readings', () => {
    const now = Date.parse('2026-10-03T12:00:00.000Z');
    assert.equal(isReadingFresh(createReading(), now), true);
    assert.equal(isReadingFresh(createReading({ intervalEnd: '2026-10-03T11:54:59.000Z' }), now), false);
    assert.equal(isReadingFresh(createReading({ intervalEnd: '2026-10-03T12:01:01.000Z' }), now), false);
});

test('rejects precision that the configured HTS token cannot represent', () => {
    assert.throws(() => canonicalizeReading(createReading({ kwhGenerated: 1.234 })), /increments of 0.01/);
});

test('binds the reading to the meter, prosumer, and exact interval', () => {
    const reading = createReading();
    const signature = signReading(reading);
    for (const changed of [
        { meterId: 'meter-002' },
        { prosumerId: '0.0.99999' },
        { intervalStart: '2026-10-03T11:30:00.000Z' },
        { intervalEnd: '2026-10-03T12:15:00.000Z' },
    ]) {
        assert.equal(verifyMeterReading({ ...reading, ...changed }, signature, publicKeyPem), false);
    }
});

test('rejects invalid, reversed, or overlong measurement intervals', () => {
    assert.throws(() => normalizeReading(createReading({ intervalStart: 'bad' })), /canonical ISO-8601/);
    assert.throws(
        () => normalizeReading(createReading({ intervalStart: '2026-10-03T12:00:00.000Z' })),
        /greater than zero/,
    );
    assert.throws(
        () => normalizeReading(createReading({ intervalStart: '2026-10-02T11:00:00.000Z' })),
        /no longer than 24 hours/,
    );
});

test('rejects unsupported schema and malformed signatures', () => {
    const reading = createReading();
    assert.throws(() => normalizeReading(createReading({ schemaVersion: 1 })), /schema version/);
    assert.equal(verifyMeterReading(reading, 'not-a-signature', publicKeyPem), false);
});
