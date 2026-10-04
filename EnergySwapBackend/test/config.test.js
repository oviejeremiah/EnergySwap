const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const test = require('node:test');
const { loadConfig } = require('../config');

const { publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

const productionEnv = {
    NODE_ENV: 'production',
    PORT: '3000',
    HEDERA_NETWORK: 'testnet',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/energyswap',
    CORS_ORIGINS: 'https://energyswap.example',
    OPERATOR_ID: '0.0.12345',
    OPERATOR_KEY: 'test-key',
    HCS_TOPIC_ID: '0.0.12346',
    ENERGY_TOKEN_ID: '0.0.12347',
};

test('accepts explicit Testnet production settings without exposing credentials in config', () => {
    const config = loadConfig(productionEnv);
    assert.equal(config.hederaNetwork, 'testnet');
    assert.deepEqual(config.corsOrigins, ['https://energyswap.example']);
    assert.equal(config.operatorKey, 'test-key');
    assert.equal('databaseUrl' in config, true);
});

test('refuses Mainnet and any unknown network', () => {
    assert.throws(() => loadConfig({ ...productionEnv, HEDERA_NETWORK: 'mainnet' }), /Testnet-only/);
    assert.throws(() => loadConfig({ ...productionEnv, HEDERA_NETWORK: 'previewnet' }), /Testnet-only/);
});

test('requires exact production origins and required production services', () => {
    assert.throws(() => loadConfig({ ...productionEnv, CORS_ORIGINS: '*' }), /exact http\(s\) origins/);
    assert.throws(() => loadConfig({ ...productionEnv, CORS_ORIGINS: 'https://example.com/path' }), /exact http\(s\) origins/);
    assert.throws(() => loadConfig({ ...productionEnv, DATABASE_URL: '' }), /DATABASE_URL/);
    assert.throws(() => loadConfig({ ...productionEnv, ENERGY_TOKEN_ID: '' }), /Production Testnet deployments require/);
});

test('requires operator credentials to be configured as a pair', () => {
    assert.throws(() => loadConfig({ ...productionEnv, OPERATOR_KEY: '' }), /configured together/);
    assert.throws(() => loadConfig({ ...productionEnv, OPERATOR_ID: '' }), /configured together/);
});

test('validates TLS origins, PostgreSQL URLs, pool bounds, and oracle key type', () => {
    assert.throws(() => loadConfig({ ...productionEnv, CORS_ORIGINS: 'http://energyswap.example' }), /HTTPS/);
    assert.throws(() => loadConfig({ ...productionEnv, DATABASE_URL: 'https://db.example' }), /postgres/);
    assert.throws(() => loadConfig({ ...productionEnv, PGPOOL_MAX: '0' }), /PGPOOL_MAX/);
    assert.throws(
        () => loadConfig({ ...productionEnv, METER_ORACLE_PUBLIC_KEY: 'not-a-key' }),
        /Ed25519 PEM/,
    );
    assert.equal(loadConfig({ ...productionEnv, METER_ORACLE_PUBLIC_KEY: publicKeyPem }).meterOraclePublicKey, publicKeyPem);
});

test('applies local-only development CORS defaults and validates ports', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    assert.equal(config.port, 3000);
    assert.ok(config.corsOrigins.includes('http://localhost:5173'));
    assert.throws(() => loadConfig({ ...productionEnv, PORT: '70000' }), /PORT/);
});
