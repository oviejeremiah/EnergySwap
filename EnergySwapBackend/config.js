const { createPublicKey } = require('node:crypto');

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function parsePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535.');
    }
    return port;
}

function parseOrigins(value, nodeEnv) {
    if (!value && nodeEnv !== 'production') return DEFAULT_CORS_ORIGINS;
    if (!value) throw new Error('CORS_ORIGINS must be set in production.');

    const origins = value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    if (origins.length === 0) throw new Error('CORS_ORIGINS must contain at least one origin.');

    for (const origin of origins) {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw new Error('CORS_ORIGINS must contain exact http(s) origins, not paths or wildcards.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || origin === '*') {
            throw new Error('CORS_ORIGINS must contain exact http(s) origins, not paths or wildcards.');
        }
        if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
            throw new Error('CORS_ORIGINS must use HTTPS in production.');
        }
    }
    return [...new Set(origins)];
}

function validateDatabaseUrl(databaseUrl) {
    if (!databaseUrl) return;
    let parsed;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
    }
}

function loadConfig(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    if (!['development', 'test', 'production'].includes(nodeEnv)) {
        throw new Error('NODE_ENV must be development, test, or production.');
    }

    const hederaNetwork = env.HEDERA_NETWORK || 'testnet';
    if (hederaNetwork !== 'testnet') {
        throw new Error('This release is Testnet-only. Mainnet is intentionally disabled.');
    }

    const hasOperatorId = Boolean(env.OPERATOR_ID);
    const hasOperatorKey = Boolean(env.OPERATOR_KEY);
    if (hasOperatorId !== hasOperatorKey) {
        throw new Error('OPERATOR_ID and OPERATOR_KEY must be configured together.');
    }
    if (nodeEnv === 'production' && (!hasOperatorId || !env.HCS_TOPIC_ID || !env.ENERGY_TOKEN_ID)) {
        throw new Error('Production Testnet deployments require operator, HCS topic, and energy token configuration.');
    }
    if (Boolean(env.HCS_TOPIC_ID) !== Boolean(env.ENERGY_TOKEN_ID)) {
        throw new Error('HCS_TOPIC_ID and ENERGY_TOKEN_ID must be configured together.');
    }
    if (env.METER_ORACLE_PUBLIC_KEY && (!hasOperatorId || !env.HCS_TOPIC_ID || !env.ENERGY_TOKEN_ID)) {
        throw new Error('METER_ORACLE_PUBLIC_KEY requires operator, HCS topic, and energy token configuration.');
    }
    if (env.METER_ORACLE_PUBLIC_KEY) {
        try {
            if (createPublicKey(env.METER_ORACLE_PUBLIC_KEY.replace(/\\n/g, '\n')).asymmetricKeyType !== 'ed25519') {
                throw new Error('METER_ORACLE_PUBLIC_KEY must be an Ed25519 public key.');
            }
        } catch {
            throw new Error('METER_ORACLE_PUBLIC_KEY must be a valid Ed25519 PEM public key.');
        }
    }
    if (nodeEnv === 'production' && !env.DATABASE_URL) {
        throw new Error('DATABASE_URL must be set in production.');
    }
    validateDatabaseUrl(env.DATABASE_URL);
    const databasePoolMax = Number(env.PGPOOL_MAX || 10);
    if (!Number.isInteger(databasePoolMax) || databasePoolMax < 1 || databasePoolMax > 50) {
        throw new Error('PGPOOL_MAX must be an integer between 1 and 50.');
    }

    return Object.freeze({
        nodeEnv,
        port: parsePort(env.PORT || '3000'),
        databaseUrl: env.DATABASE_URL || '',
        databasePoolMax,
        corsOrigins: parseOrigins(env.CORS_ORIGINS, nodeEnv),
        hederaNetwork,
        databaseSsl: env.PGSSL === 'true',
        operatorId: env.OPERATOR_ID || '',
        operatorKey: env.OPERATOR_KEY || '',
        hcsTopicId: env.HCS_TOPIC_ID || '',
        energyTokenId: env.ENERGY_TOKEN_ID || '',
        meterOraclePublicKey: env.METER_ORACLE_PUBLIC_KEY || '',
    });
}

module.exports = { loadConfig };
