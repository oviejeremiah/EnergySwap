require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { closePool, migrate } = require('../database');
const { importLegacyData } = require('../repository');

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured before importing data.');
    await migrate();

    const legacyPath = path.join(__dirname, '..', 'db.json');
    let rawData;
    try {
        rawData = await fs.readFile(legacyPath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`[Migration] No legacy JSON file found at ${legacyPath}; nothing to import.`);
            return;
        }
        throw error;
    }
    const legacyData = JSON.parse(rawData);
    const imported = await importLegacyData(legacyData);
    console.log(
        `[Migration] Imported ${imported.offers} offers, ${imported.trades} trades, and ${imported.meterReadings} meter readings.`,
    );
}

main()
    .catch((error) => {
        console.error('[Migration] Legacy import failed:', error.message);
        process.exitCode = 1;
    })
    .finally(closePool);
