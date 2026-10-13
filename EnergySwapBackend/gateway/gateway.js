/**
 * EnergySwap meter gateway client.
 *
 * The gateway sits with the physical meter and IoT hardware. It owns the keys
 * that the platform deliberately does not have:
 *
 *   GRID_ATTESTATION_PRIVATE_KEY  Ed25519, signs each meter reading.
 *                                The matching public key is configured on the
 *                                API as METER_ORACLE_PUBLIC_KEY.
 *   GRID_PRIVATE_KEY              Hedera account key used to submit the HCS
 *                                attestation and the HTS energy-token credit.
 *                                This account must hold the energy tokens.
 *
 * The API never signs anything. This client does:
 *
 *   1. sign the reading and POST it to /api/oracle/readings
 *   2. receive the exact HCS payload and HTS credit instructions
 *   3. submit both to Hedera, paying the network fees
 *   4. report the transaction IDs back so the API can verify and finalise
 *
 * Usage:
 *   node gateway/submit.js --meter <id> --prosumer 0.0.1234 --kwh 12.5
 *   node gateway/submit.js --file readings.json
 *   node gateway/submit.js --recover      # finish any interrupted settlement
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
    AccountId,
    PrivateKey,
    TopicMessageSubmitTransaction,
    TransactionRecordQuery,
    TransferTransaction,
    Client,
} = require('@hashgraph/sdk');

const { canonicalizeReading, INTERVAL_CONVENTION } = require('../oracle-attestation');

const API_BASE = (process.env.ENERGYSWAP_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const JOURNAL_PATH = process.env.GATEWAY_JOURNAL_PATH || path.join(__dirname, '.settlement-journal.jsonl');

const RETRY_DELAYS_MS = [1000, 3000, 8000, 20000];

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required to run the gateway.`);
    return value;
}

function loadConfig() {
    const network = process.env.HEDERA_NETWORK || 'testnet';
    if (network !== 'testnet') {
        throw new Error('This release is Testnet-only. Mainnet is intentionally disabled.');
    }
    return {
        network,
        apiBase: API_BASE,
        accountId: requireEnv('GRID_ACCOUNT_ID'),
        privateKey: PrivateKey.fromString(requireEnv('GRID_PRIVATE_KEY')),
        attestationKey: PrivateKey.fromString(requireEnv('GRID_ATTESTATION_PRIVATE_KEY')),
        hcsTopicId: requireEnv('HCS_TOPIC_ID'),
        energyTokenId: requireEnv('ENERGY_TOKEN_ID'),
        journalPath: JOURNAL_PATH,
    };
}

const log = (message) => console.log(`[gateway] ${message}`);

// ── journal: crash-safe record of in-flight settlements ────────────────────
function appendJournal(entry) {
    fs.appendFileSync(JOURNAL_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Read the journal, collapsing updates to a single entry per reading.
 *
 * The journal is append-only, so a reading that was re-appended after its
 * transaction IDs were known appears twice. The later line is authoritative -
 * it is the more complete record - so entries are keyed by readingId with the
 * last occurrence winning.
 */
function readJournal() {
    if (!fs.existsSync(JOURNAL_PATH)) return [];
    const entries = fs
        .readFileSync(JOURNAL_PATH, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);

    const byReading = new Map();
    for (const entry of entries) {
        if (!entry || typeof entry.readingId !== 'string') continue;
        byReading.set(entry.readingId, entry);
    }
    return [...byReading.values()];
}

/**
 * Rewrite the journal keeping only the entries still awaiting settlement.
 *
 * Written to a temp file and renamed, so a crash mid-write cannot leave the
 * journal truncated and destroy pending entries for other readings.
 */
function compactJournal(keep) {
    const lines = keep.map((entry) => JSON.stringify(entry)).join('\n');
    const temp = `${JOURNAL_PATH}.tmp`;
    fs.writeFileSync(temp, lines ? `${lines}\n` : '', 'utf8');
    fs.renameSync(temp, JOURNAL_PATH);
}

async function apiPost(pathname, body) {
    const response = await fetch(`${API_BASE}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`Unexpected response from ${pathname}: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
        throw new Error(parsed.message || `${pathname} failed with ${response.status}`);
    }
    return parsed;
}

/** Poll until the transaction has a SUCCESS receipt. */
async function awaitTransaction(client, transaction, label) {
    const receipt = await transaction.getReceipt(client, 60);
    if (receipt.status?.toString() !== 'SUCCESS') {
        throw new Error(`${label} did not succeed.`);
    }
    return receipt;
}

/**
 * Submit the HCS attestation and the HTS token credit.
 * Both are signed by the gateway account and paid for by the gateway account.
 */
async function settleOnChain(config, client, readingId, settlement) {
    const hcsTransaction = await new TopicMessageSubmitTransaction()
        .setTopicId(settlement.hcs.topicId || config.hcsTopicId)
        .setMessage(settlement.hcs.message)
        .execute(client);
    await awaitTransaction(client, hcsTransaction, 'HCS attestation');
    const hcsTransactionId = hcsTransaction.transactionId.toString();
    log(`HCS attested in ${hcsTransactionId}`);

    const htsTransaction = await new TransferTransaction()
        .addTokenTransfer(settlement.hts.tokenId || config.energyTokenId, config.accountId, -settlement.hts.tokenUnits)
        .addTokenTransfer(settlement.hts.tokenId || config.energyTokenId, settlement.hts.prosumerId, settlement.hts.tokenUnits)
        .setTransactionMemo(settlement.hts.memo || `EnergySwap ${readingId}`)
        .execute(client);
    await awaitTransaction(client, htsTransaction, 'HTS energy credit');
    const htsTransactionId = htsTransaction.transactionId.toString();
    log(`credited ${settlement.hts.tokenUnits} token units to ${settlement.hts.prosumerId} in ${htsTransactionId}`);

    return { hcsTransactionId, htsTransactionId };
}

/** Full happy path for one reading. */
async function submitReading(config, client, reading) {
    const signature = config.attestationKey.sign(Buffer.from(canonicalizeReading(reading))).toString('base64');

    const accepted = await apiPost('/api/oracle/readings', { reading, signature });
    if (accepted.duplicate) {
        log(`${reading.readingId} was already accepted (${accepted.reading.status}); nothing to do.`);
        return;
    }
    const settlement = accepted.settlement;
    if (!settlement) {
        throw new Error('The API accepted the reading but returned no settlement instructions.');
    }

    // Record intent BEFORE touching the chain, so a crash mid-settlement is
    // recoverable and the same energy can never be credited twice unnoticed.
    const journalEntry = {
        readingId: reading.readingId,
        hcsTransactionId: null,
        htsTransactionId: null,
        startedAt: new Date().toISOString(),
    };
    appendJournal(journalEntry);

    const ids = await settleOnChain(config, client, reading.readingId, settlement);
    journalEntry.hcsTransactionId = ids.hcsTransactionId;
    journalEntry.htsTransactionId = ids.htsTransactionId;

    // Persist the transaction IDs before reporting them. Mutating the in-memory
    // object is not enough: the on-disk entry still holds nulls, and the
    // compactJournal call below re-reads from disk and deletes the entry. A
    // crash after settleOnChain but before the API call would therefore lose the
    // only pointer to energy that had already been credited on chain.
    appendJournal(journalEntry);

    await apiPost(`/api/oracle/readings/${reading.readingId}/settlement`, ids);
    compactJournal(readJournal().filter((entry) => entry.readingId !== reading.readingId));
    log(`${reading.readingId} settled and reported to the API.`);
}

/**
 * Finish settlements that were interrupted by a crash or network failure.
 * Safe to run repeatedly: the API rejects duplicate or mismatched reports.
 */
async function recover(config, client) {
    const pending = readJournal().filter((entry) => entry.hcsTransactionId && entry.htsTransactionId);
    const orphaned = readJournal().filter((entry) => !entry.hcsTransactionId || !entry.htsTransactionId);
    if (!pending.length && !orphaned.length) {
        log('Nothing to recover.');
        return;
    }

    for (const entry of pending) {
        log(`re-reporting settlement for ${entry.readingId}`);
        try {
            await apiPost(`/api/oracle/readings/${entry.readingId}/settlement`, {
                hcsTransactionId: entry.hcsTransactionId,
                htsTransactionId: entry.htsTransactionId,
            });
        } catch (error) {
            log(`could not finalise ${entry.readingId}: ${error.message}`);
            continue;
        }
        compactJournal(readJournal().filter((item) => item.readingId !== entry.readingId));
    }

    if (orphaned.length) {
        // The chain write may or may not have happened; only the API knows.
        // Surface them for an operator rather than guessing.
        log(`WARNING: ${orphaned.length} reading(s) were interrupted mid-settlement:`);
        orphaned.forEach((entry) => log(`  ${entry.readingId} started ${entry.startedAt}`));
        log('Check each reading in the API before resubmitting. Energy must not be double-credited.');
    }
}

async function main() {
    const args = process.argv.slice(2);
    const config = loadConfig();
    const client = Client.forTestnet();
    client.setOperator(AccountId.fromString(config.accountId), config.privateKey);

    try {
        if (args.includes('--recover')) {
            await recover(config, client);
            return;
        }

        const fileIndex = args.indexOf('--file');
        let readings = [];
        if (fileIndex !== -1) {
            readings = JSON.parse(fs.readFileSync(args[fileIndex + 1], 'utf8'));
        } else {
            const value = (flag) => {
                const i = args.indexOf(flag);
                return i === -1 ? undefined : args[i + 1];
            };
            const meterId = value('--meter');
            const prosumerId = value('--prosumer');
            const kwh = Number(value('--kwh'));
            if (!meterId || !prosumerId || !Number.isFinite(kwh) || kwh <= 0) {
                throw new Error(
                    'Usage: node gateway/submit.js --meter <id> --prosumer 0.0.1234 --kwh 12.5',
                );
            }
            const intervalEnd = new Date();
            readings = [
                {
                    schemaVersion: 2,
                    readingId: `reading-${randomUUID()}`,
                    meterId,
                    prosumerId,
                    kwhGenerated: Number(kwh.toFixed(2)),
                    readingTimestamp: intervalEnd.toISOString(),
                    intervalStart: new Date(intervalEnd.getTime() - 60 * 60 * 1000).toISOString(),
                    intervalEnd: intervalEnd.toISOString(),
                    intervalConvention: INTERVAL_CONVENTION,
                },
            ];
        }

        for (const reading of readings) {
            await submitReading(config, client, reading);
        }
    } finally {
        client.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[gateway] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { loadConfig, submitReading, recover };