const { createHash, createPublicKey, verify } = require('node:crypto');

const READING_FIELDS = [
    'schemaVersion',
    'readingId',
    'meterId',
    'prosumerId',
    'intervalStart',
    'intervalEnd',
    'intervalConvention',
    'kwhGenerated',
];
const INTERVAL_CONVENTION = '[start,end)';

function isCanonicalUtcTimestamp(value) {
    return (
        typeof value === 'string' &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value
    );
}

function normalizeReading(reading) {
    if (!reading || typeof reading !== 'object' || Array.isArray(reading)) {
        throw new TypeError('Reading must be a JSON object.');
    }

    const normalized = Object.fromEntries(READING_FIELDS.map((field) => [field, reading[field]]));
    if (normalized.schemaVersion !== 2) throw new TypeError('Unsupported reading schema version.');

    for (const field of ['readingId', 'meterId', 'prosumerId']) {
        if (typeof normalized[field] !== 'string' || normalized[field].length < 1 || normalized[field].length > 128) {
            throw new TypeError(`${field} must be a string of 1 to 128 characters.`);
        }
    }

    if (
        !Number.isFinite(normalized.kwhGenerated) ||
        normalized.kwhGenerated <= 0 ||
        normalized.kwhGenerated > 1000000
    ) {
        throw new TypeError('kwhGenerated must be a positive finite number no greater than 1000000.');
    }
    if (Math.abs(normalized.kwhGenerated * 100 - Math.round(normalized.kwhGenerated * 100)) > 1e-8) {
        throw new TypeError('kwhGenerated must use increments of 0.01 kWh to match HTS token precision.');
    }

    if (!isCanonicalUtcTimestamp(normalized.intervalStart) || !isCanonicalUtcTimestamp(normalized.intervalEnd)) {
        throw new TypeError('intervalStart and intervalEnd must use canonical ISO-8601 UTC timestamps.');
    }
    if (normalized.intervalConvention !== INTERVAL_CONVENTION) {
        throw new TypeError(`intervalConvention must be ${INTERVAL_CONVENTION}.`);
    }
    const intervalDurationMs = Date.parse(normalized.intervalEnd) - Date.parse(normalized.intervalStart);
    if (intervalDurationMs <= 0 || intervalDurationMs > 24 * 60 * 60 * 1000) {
        throw new TypeError('The reading interval must be greater than zero and no longer than 24 hours.');
    }

    return normalized;
}

function canonicalizeReading(reading) {
    const normalized = normalizeReading(reading);
    return JSON.stringify(Object.fromEntries(READING_FIELDS.map((field) => [field, normalized[field]])));
}

function isReadingFresh(reading, now = Date.now(), maxAgeMs = 5 * 60 * 1000, maxFutureMs = 60 * 1000) {
    const intervalEnd = Date.parse(normalizeReading(reading).intervalEnd);
    return intervalEnd >= now - maxAgeMs && intervalEnd <= now + maxFutureMs;
}

function getGatewayKeyFingerprint(publicKeyPem) {
    const publicKey = createPublicKey(publicKeyPem.replace(/\\n/g, '\n'));
    if (publicKey.asymmetricKeyType !== 'ed25519') {
        throw new TypeError('Meter gateway key must use Ed25519.');
    }
    return createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex');
}

function verifyMeterReading(reading, signatureBase64, publicKeyPem) {
    if (typeof signatureBase64 !== 'string' || typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) return false;
    try {
        const signature = Buffer.from(signatureBase64, 'base64');
        if (
            signature.length !== 64 ||
            signature.toString('base64').replace(/=+$/, '') !== signatureBase64.replace(/=+$/, '')
        )
            return false;
        const publicKey = createPublicKey(publicKeyPem.replace(/\\n/g, '\n'));
        return (
            publicKey.asymmetricKeyType === 'ed25519' &&
            verify(null, Buffer.from(canonicalizeReading(reading)), publicKey, signature)
        );
    } catch {
        return false;
    }
}

module.exports = {
    canonicalizeReading,
    getGatewayKeyFingerprint,
    INTERVAL_CONVENTION,
    isReadingFresh,
    normalizeReading,
    verifyMeterReading,
};
