require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
(async () => {
    const p = new Pool({ connectionString: process.env.DATABASE_URL });
    const c = await p.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'offers_energy_amount_kwh_check'");
    console.log('constraint:', c.rows[0].def);
    const m = await p.query("SELECT version FROM schema_migrations WHERE version LIKE '006%'");
    console.log('migration 006 recorded:', m.rowCount === 1);
    await p.end();
})().catch((e) => { console.log('FAILED:', e.message); process.exitCode = 1; });
