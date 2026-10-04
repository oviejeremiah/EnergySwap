require('dotenv').config();
const { closePool, migrate } = require('../database');

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured before running migrations.');
    await migrate();
    console.log('[Database] Migrations are up to date.');
}

main()
    .catch((error) => {
        console.error('[Database] Migration failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);
