require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
(async () => {
    const p = new Pool({ connectionString: process.env.DATABASE_URL });
    const t = await p.query(
        "SELECT id, offer_id, buyer_id, seller_id, energy_amount_kwh, hbar_amount, total_hbar_paid, status FROM trades WHERE transaction_id = '0.0.6242449@1793370585.796318635'",
    );
    console.log('trade row:', JSON.stringify(t.rows[0], null, 2));
    const o = await p.query(
        "SELECT id, energy_amount_kwh, total_hbar, status FROM offers WHERE id = 'offer-1793359475685-zdd2awgie'",
    );
    console.log('offer row:', JSON.stringify(o.rows[0], null, 2));
    await p.end();
})().catch((e) => { console.log('FAILED:', e.message); process.exitCode = 1; });
