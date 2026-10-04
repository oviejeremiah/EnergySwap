const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

let pool;

function getPool(env = process.env) {
    if (pool) return pool;
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL must be configured before using PostgreSQL.');

    pool = new Pool({
        connectionString: env.DATABASE_URL,
        max: Number(env.PGPOOL_MAX || 10),
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        statement_timeout: 10000,
        ...(env.PGSSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    pool.on('error', (error) => console.error('[Database] Idle client error:', error.message));
    return pool;
}

async function migrate(targetPool = getPool()) {
    const migrationDirectory = path.join(__dirname, 'migrations');
    const files = (await fs.readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
    const client = await targetPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [74102931]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        `);

        for (const file of files) {
            const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
            if (existing.rowCount > 0) continue;
            const sql = await fs.readFile(path.join(migrationDirectory, file), 'utf8');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function closePool() {
    if (!pool) return;
    const closing = pool;
    pool = undefined;
    await closing.end();
}

module.exports = { closePool, getPool, migrate };
