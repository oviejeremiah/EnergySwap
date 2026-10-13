const crypto = require('node:crypto');
const { getPool } = require('./database');

function numeric(value) {
    return Number(value);
}

function mapOffer(row) {
    return {
        id: row.id,
        prosumerId: row.prosumer_id,
        energyAmountKWh: numeric(row.energy_amount_kwh),
        hbarPerKWh: numeric(row.hbar_per_kwh),
        totalHbar: numeric(row.total_hbar),
        timestamp: new Date(row.created_at).toISOString(),
        status: row.status,
        ...(row.settlement_network ? { settlementNetwork: row.settlement_network } : {}),
        ...(row.settlement_asset ? { settlementAsset: row.settlement_asset } : {}),
        ...(row.seller_address ? { sellerAddress: row.seller_address } : {}),
        ...(row.price_per_kwh !== null && row.price_per_kwh !== undefined
            ? { pricePerKWh: numeric(row.price_per_kwh) }
            : {}),
    };
}

function mapTrade(row) {
    return {
        id: row.id,
        offerId: row.offer_id,
        buyerId: row.buyer_id,
        sellerId: row.seller_id,
        transactionId: row.transaction_id,
        energyAmountKWh: numeric(row.energy_amount_kwh).toFixed(8),
        hbarAmount: numeric(row.hbar_amount),
        hbarPerKWh: numeric(row.hbar_per_kwh),
        gasFeeHbar: numeric(row.gas_fee_hbar),
        totalHbarPaid: numeric(row.total_hbar_paid),
        hbarPriceUSD: numeric(row.hbar_price_usd),
        gasFeeUSD: numeric(row.gas_fee_usd).toFixed(6),
        timestamp: new Date(row.created_at).toISOString(),
        status: row.status,
    };
}

function mapReading(row) {
    return {
        readingId: row.reading_id,
        meterId: row.meter_id,
        prosumerId: row.prosumer_id,
        kwhGenerated: numeric(row.kwh_generated),
        ...(row.interval_start ? { intervalStart: new Date(row.interval_start).toISOString() } : {}),
        ...(row.interval_end ? { intervalEnd: new Date(row.interval_end).toISOString() } : {}),
        canonicalReading: row.canonical_reading,
        signature: row.signature,
        ...(row.gateway_public_key ? { gatewayPublicKey: row.gateway_public_key } : {}),
        ...(row.gateway_key_fingerprint ? { gatewayKeyFingerprint: row.gateway_key_fingerprint } : {}),
        ...(row.hcs_topic_id ? { hcsTopicId: row.hcs_topic_id } : {}),
        tokenUnits: numeric(row.token_units),
        status: row.status,
        receivedAt: new Date(row.received_at).toISOString(),
        ...(row.attested_at ? { attestedAt: new Date(row.attested_at).toISOString() } : {}),
        ...(row.hcs_consensus_timestamp
            ? { hcsConsensusTimestamp: new Date(row.hcs_consensus_timestamp).toISOString() }
            : {}),
        ...(row.credited_at ? { creditedAt: new Date(row.credited_at).toISOString() } : {}),
        ...(row.hcs_transaction_id ? { hcsTransactionId: row.hcs_transaction_id } : {}),
        ...(row.hts_transaction_id ? { htsTransactionId: row.hts_transaction_id } : {}),
        ...(row.error ? { error: row.error } : {}),
    };
}

async function createOffer(offer, targetPool = getPool()) {
    // seller_address and price_per_kwh are NOT NULL after migration 003. They
    // mirror prosumer_id / hbar_per_kwh on Hedera testnet, which is exactly how
    // that migration backfilled existing rows.
    const result = await targetPool.query(
        `INSERT INTO offers (id, prosumer_id, energy_amount_kwh, hbar_per_kwh, total_hbar, created_at, status,
                             settlement_network, settlement_asset, seller_address, price_per_kwh)
         VALUES ($1, $2, $3, $4, $5, $6, 'available',
                 $7, $8, $9, $10)
         RETURNING *`,
        [
            offer.id,
            offer.prosumerId,
            offer.energyAmountKWh,
            offer.hbarPerKWh,
            offer.totalHbar,
            offer.timestamp,
            offer.settlementNetwork || 'hedera-testnet',
            offer.settlementAsset || 'HBAR',
            offer.sellerAddress || offer.prosumerId,
            offer.pricePerKWh ?? offer.hbarPerKWh,
        ],
    );
    return mapOffer(result.rows[0]);
}

async function listOffers({ availableOnly = false } = {}, targetPool = getPool()) {
    const result = await targetPool.query(
        `SELECT * FROM offers ${availableOnly ? "WHERE status = 'available'" : ''} ORDER BY created_at DESC`,
    );
    return result.rows.map(mapOffer);
}

async function getOffer(offerId, targetPool = getPool()) {
    const result = await targetPool.query('SELECT * FROM offers WHERE id = $1', [offerId]);
    return result.rows[0] ? mapOffer(result.rows[0]) : null;
}

async function listTrades({ completedOnly = false } = {}, targetPool = getPool()) {
    const result = await targetPool.query(
        `SELECT * FROM trades ${completedOnly ? "WHERE status = 'completed'" : ''} ORDER BY created_at`,
    );
    return result.rows.map(mapTrade);
}

async function findTradeByTransactionId(transactionId, targetPool = getPool()) {
    const result = await targetPool.query('SELECT * FROM trades WHERE transaction_id = $1', [transactionId]);
    return result.rows[0] ? mapTrade(result.rows[0]) : null;
}

async function recordTrade(trade, targetPool = getPool()) {
    const client = await targetPool.connect();
    try {
        await client.query('BEGIN');
        let prior = await client.query('SELECT * FROM trades WHERE transaction_id = $1', [trade.transactionId]);
        if (prior.rows[0]) {
            await client.query('COMMIT');
            return { kind: 'duplicate', trade: mapTrade(prior.rows[0]) };
        }

        const offerResult = await client.query('SELECT * FROM offers WHERE id = $1 FOR UPDATE', [trade.offerId]);
        const offer = offerResult.rows[0];
        if (!offer) {
            await client.query('ROLLBACK');
            return { kind: 'offer_unavailable' };
        }

        prior = await client.query('SELECT * FROM trades WHERE transaction_id = $1', [trade.transactionId]);
        if (prior.rows[0]) {
            await client.query('COMMIT');
            return { kind: 'duplicate', trade: mapTrade(prior.rows[0]) };
        }

        const remaining = numeric(offer.energy_amount_kwh) - Number(trade.energyAmountKWh);
        const status =
            offer.status !== 'available' || remaining < -1e-8 ? 'reconciliation_required' : 'completed';
        if (status === 'completed') {
            const safeRemaining = Math.max(0, remaining);
            await client.query(
                `UPDATE offers
                 SET energy_amount_kwh = $2,
                     total_hbar = $3,
                     status = $4
                 WHERE id = $1`,
                [
                    trade.offerId,
                    safeRemaining.toFixed(8),
                    (safeRemaining * numeric(offer.hbar_per_kwh)).toFixed(8),
                    safeRemaining <= 1e-8 ? 'completed' : 'available',
                ],
            );
        }

        // Migration 003 added buyer_address, seller_address, payment_amount and
        // payment_fee as NOT NULL with no default, but this INSERT still listed
        // only the original fourteen columns. Every insert therefore failed with
        // SQLSTATE 23502 - which meant the money moved, the row did not, and the
        // buyer was told the trade could not be recorded.
        //
        // The values are supplied explicitly rather than via column defaults, so
        // a caller that omits one gets a clear error here instead of an opaque
        // constraint violation after the payment has already happened.
        const settlementFields = {
            buyerAddress: trade.buyerId,
            sellerAddress: trade.sellerId,
            paymentAmount: trade.hbarAmount,
            paymentFee: trade.gasFeeHbar,
        };
        for (const [field, value] of Object.entries(settlementFields)) {
            if (value === null || value === undefined) {
                await client.query('ROLLBACK');
                throw new Error(
                    `Cannot record trade ${trade.id}: ${field} is required but was not supplied.`,
                );
            }
        }

        const inserted = await client.query(
            `INSERT INTO trades (
                id, offer_id, buyer_id, seller_id, transaction_id, energy_amount_kwh,
                hbar_amount, hbar_per_kwh, gas_fee_hbar, total_hbar_paid,
                hbar_price_usd, gas_fee_usd, created_at, status,
                buyer_address, seller_address, payment_amount, payment_fee
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18
            ) RETURNING *`,
            [
                trade.id,
                trade.offerId,
                trade.buyerId,
                trade.sellerId,
                trade.transactionId,
                trade.energyAmountKWh,
                trade.hbarAmount,
                trade.hbarPerKWh,
                trade.gasFeeHbar,
                trade.totalHbarPaid,
                trade.hbarPriceUSD,
                trade.gasFeeUSD,
                trade.timestamp,
                status,
                settlementFields.buyerAddress,
                settlementFields.sellerAddress,
                settlementFields.paymentAmount,
                settlementFields.paymentFee,
            ],
        );
        await client.query('COMMIT');
        return {
            kind: status === 'completed' ? 'recorded' : 'reconciliation_required',
            trade: mapTrade(inserted.rows[0]),
        };
    } catch (error) {
        await client.query('ROLLBACK');
        // Unique violation on trades. Match the SQLSTATE rather than the
        // constraint name: migration 003 dropped `trades_transaction_id_key` in
        // favour of `trades_settlement_network_transaction_id_key`, so the old
        // name could never match and this branch was dead - a duplicate trade
        // surfaced as a 500 instead of the idempotent "already recorded".
        if (error.code === '23505') {
            // Re-read to discriminate a genuine duplicate from a different row
            // that merely collided on the same constraint.
            const prior = await targetPool.query(
                `SELECT * FROM trades
                 WHERE transaction_id = $1
                   AND settlement_network = COALESCE($2, 'hedera-testnet')`,
                [trade.transactionId, trade.settlementNetwork ?? null],
            );
            if (prior.rows[0]) return { kind: 'duplicate', trade: mapTrade(prior.rows[0]) };
        }
        throw error;
    } finally {
        client.release();
    }
}

async function reserveMeterReading(reading, targetPool = getPool()) {
    const client = await targetPool.connect();
    try {
        await client.query('BEGIN');
        const inserted = await client.query(
            `INSERT INTO meter_readings (
                reading_id, meter_id, prosumer_id, kwh_generated, reading_timestamp,
                canonical_reading, signature, token_units, status, received_at,
                interval_start, interval_end, hcs_topic_id, gateway_public_key,
                gateway_key_fingerprint
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (reading_id) DO NOTHING
            RETURNING *`,
            [
                reading.readingId,
                reading.meterId,
                reading.prosumerId,
                reading.kwhGenerated,
                reading.intervalEnd,
                reading.canonicalReading,
                reading.signature,
                reading.tokenUnits,
                reading.status,
                reading.receivedAt,
                reading.intervalStart,
                reading.intervalEnd,
                reading.hcsTopicId,
                reading.gatewayPublicKey,
                reading.gatewayKeyFingerprint,
            ],
        );
        if (inserted.rows[0]) {
            await client.query('COMMIT');
            return { created: true, reading: mapReading(inserted.rows[0]) };
        }
        const existing = await client.query(
            `SELECT *, (reading_id = $1) AS same_reading_id
             FROM meter_readings
             WHERE reading_id = $1 OR (meter_id = $2 AND interval_start = $3 AND interval_end = $4)
             LIMIT 1`,
            [reading.readingId, reading.meterId, reading.intervalStart, reading.intervalEnd],
        );
        await client.query('COMMIT');
        if (!existing.rows[0]) throw new Error('Reading reservation conflict was reported but no existing row was found.');
        return {
            created: false,
            conflict: existing.rows[0].same_reading_id ? 'reading_id' : 'meter_interval',
            reading: mapReading(existing.rows[0]),
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

const READING_UPDATE_COLUMNS = Object.freeze({
    status: 'status',
    creditedAt: 'credited_at',
    hcsTransactionId: 'hcs_transaction_id',
    htsTransactionId: 'hts_transaction_id',
    attestedAt: 'attested_at',
    hcsConsensusTimestamp: 'hcs_consensus_timestamp',
    error: 'error',
});

async function updateMeterReading(readingId, updates, targetPool = getPool()) {
    const entries = Object.entries(updates).filter(([key]) => READING_UPDATE_COLUMNS[key]);
    if (entries.length === 0) throw new Error('At least one supported meter-reading update is required.');
    const assignments = entries.map(([key], index) => `${READING_UPDATE_COLUMNS[key]} = $${index + 2}`);
    const values = entries.map(([, value]) => value);
    const result = await targetPool.query(
        `UPDATE meter_readings SET ${assignments.join(', ')} WHERE reading_id = $1 RETURNING *`,
        [readingId, ...values],
    );
    if (!result.rows[0]) throw new Error(`Meter reading ${readingId} does not exist.`);
    return mapReading(result.rows[0]);
}

async function getMeterReading(readingId, targetPool = getPool()) {
    const result = await targetPool.query('SELECT * FROM meter_readings WHERE reading_id = $1', [readingId]);
    return result.rows[0] ? mapReading(result.rows[0]) : null;
}

async function checkDatabase(targetPool = getPool()) {
    await targetPool.query('SELECT 1');
}

// ─── IDENTITY BINDINGS ──────────────────────────────────────────────────────
//
// A row here caches an on-chain fact: that a Hedera account published an HCS
// attestation naming an EVM address. The row is not the proof — the mirror node
// is. Treat these as read-through helpers, and never authorise on a row alone.

const mapBinding = (row) =>
    row
        ? {
              id: row.id,
              evmAddress: row.evm_address,
              evmChainId: row.evm_chain_id,
              hederaAccountId: row.hedera_account_id,
              topicId: row.topic_id,
              sequenceNumber: row.sequence_number === null ? null : Number(row.sequence_number),
              consensusTimestamp: row.consensus_timestamp,
              createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          }
        : null;

const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HEDERA_ID_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Record a verified binding.
 *
 * Re-binding the same Hedera account replaces the previous identity rather than
 * failing: switching sign-in wallets is legitimate, and the UNIQUE constraint
 * exists to prevent *simultaneous* identities, not successive ones.
 *
 * @param {{evmAddress: string, evmChainId?: number, hederaAccountId: string,
 *          topicId: string, sequenceNumber?: number|null,
 *          consensusTimestamp?: string|null}} binding
 */
async function saveIdentityBinding(binding, targetPool = getPool()) {
    const evmAddress = String(binding.evmAddress || '').trim().toLowerCase();
    const hederaAccountId = String(binding.hederaAccountId || '').trim();
    const topicId = String(binding.topicId || '').trim();

    if (!EVM_ADDRESS_PATTERN.test(evmAddress)) throw new Error('evmAddress must be a 20-byte hex EVM address.');
    if (!HEDERA_ID_PATTERN.test(hederaAccountId)) throw new Error('hederaAccountId must be a Hedera account ID.');
    if (!HEDERA_ID_PATTERN.test(topicId)) throw new Error('topicId must be a Hedera account ID.');

    // Displacement has to be its own statement, inside a transaction.
    //
    // An earlier version used a data-modifying CTE - `WITH displaced AS
    // (DELETE ...) INSERT ...` - believing the DELETE would run first. It does
    // not: PostgreSQL gives every CTE in a statement the same snapshot, so the
    // unique index on evm_address still saw the row being deleted and the
    // INSERT failed with 23505. The prior binding survived and the statement
    // aborted, so a user who had bound a wallet to account A could not move to
    // account B at all - while a new EVM claiming an already-bound Hedera
    // account still displaced the old identity through ON CONFLICT.
    //
    // A transaction is what makes this safe: without it, a failed INSERT would
    // leave the user with no binding at all, which is worse than either state.
    const client = await targetPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM identity_bindings WHERE evm_address = $1 AND hedera_account_id <> $2', [
            evmAddress,
            hederaAccountId,
        ]);
        const result = await client.query(
            `INSERT INTO identity_bindings
                (evm_address, evm_chain_id, hedera_account_id, topic_id, sequence_number, consensus_timestamp)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (hedera_account_id) DO UPDATE
                SET evm_address = EXCLUDED.evm_address,
                    evm_chain_id = EXCLUDED.evm_chain_id,
                    topic_id = EXCLUDED.topic_id,
                    sequence_number = EXCLUDED.sequence_number,
                    consensus_timestamp = EXCLUDED.consensus_timestamp,
                    created_at = now()
             RETURNING *`,
            [
                evmAddress,
                Number(binding.evmChainId) || 1,
                hederaAccountId,
                topicId,
                binding.sequenceNumber ?? null,
                binding.consensusTimestamp ?? null,
            ],
        );
        await client.query('COMMIT');
        return mapBinding(result.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/** Find the binding for an EVM sign-in wallet, if any. */
async function getIdentityBindingByEvm(evmAddress, targetPool = getPool()) {
    const address = String(evmAddress || '').trim().toLowerCase();
    if (!EVM_ADDRESS_PATTERN.test(address)) return null;
    const result = await targetPool.query('SELECT * FROM identity_bindings WHERE evm_address = $1', [address]);
    return mapBinding(result.rows[0]);
}

/** Find the binding for a Hedera settlement account, if any. */
async function getIdentityBindingByHedera(hederaAccountId, targetPool = getPool()) {
    const accountId = String(hederaAccountId || '').trim();
    if (!HEDERA_ID_PATTERN.test(accountId)) return null;
    const result = await targetPool.query('SELECT * FROM identity_bindings WHERE hedera_account_id = $1', [accountId]);
    return mapBinding(result.rows[0]);
}

/** Remove a binding. Used when a user unlinks their sign-in wallet. */
async function deleteIdentityBinding(evmAddress, targetPool = getPool()) {
    const address = String(evmAddress || '').trim().toLowerCase();
    if (!EVM_ADDRESS_PATTERN.test(address)) return false;
    const result = await targetPool.query('DELETE FROM identity_bindings WHERE evm_address = $1', [address]);
    return result.rowCount > 0;
}

async function importLegacyData(data, targetPool = getPool()) {
    const client = await targetPool.connect();
    const imported = { offers: 0, trades: 0, meterReadings: 0 };
    try {
        await client.query('BEGIN');
        for (const offer of Array.isArray(data.offers) ? data.offers : []) {
            const result = await client.query(
                `INSERT INTO offers (id, prosumer_id, energy_amount_kwh, hbar_per_kwh, total_hbar, created_at, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    String(offer.id),
                    String(offer.prosumerId),
                    Number(offer.energyAmountKWh),
                    Number(offer.hbarPerKWh),
                    Number(offer.totalHbar),
                    offer.timestamp,
                    offer.status === 'completed' ? 'completed' : 'available',
                ],
            );
            imported.offers += result.rowCount;
        }
        for (const trade of Array.isArray(data.trades) ? data.trades : []) {
            const result = await client.query(
                `INSERT INTO trades (
                    id, offer_id, buyer_id, seller_id, transaction_id, energy_amount_kwh,
                    hbar_amount, hbar_per_kwh, gas_fee_hbar, total_hbar_paid,
                    hbar_price_usd, gas_fee_usd, created_at, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT DO NOTHING`,
                [
                    String(trade.id || crypto.randomUUID()),
                    String(trade.offerId),
                    String(trade.buyerId),
                    String(trade.sellerId),
                    String(trade.transactionId),
                    Number(trade.energyAmountKWh),
                    Number(trade.hbarAmount),
                    Number(trade.hbarPerKWh),
                    Number(trade.gasFeeHbar || 0),
                    Number(trade.totalHbarPaid || trade.hbarAmount),
                    Number(trade.hbarPriceUSD || 0),
                    Number(trade.gasFeeUSD || 0),
                    trade.timestamp,
                    trade.status === 'reconciliation_required' ? 'reconciliation_required' : 'completed',
                ],
            );
            imported.trades += result.rowCount;
        }
        for (const reading of Array.isArray(data.meterReadings) ? data.meterReadings : []) {
            const result = await client.query(
                `INSERT INTO meter_readings (
                    reading_id, meter_id, prosumer_id, kwh_generated, reading_timestamp,
                    canonical_reading, signature, token_units, status, received_at,
                    credited_at, hcs_transaction_id, hts_transaction_id, error
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT DO NOTHING`,
                [
                    String(reading.readingId),
                    String(reading.meterId),
                    String(reading.prosumerId),
                    Number(reading.kwhGenerated),
                    reading.readingTimestamp,
                    String(reading.canonicalReading),
                    String(reading.signature),
                    Number(reading.tokenUnits),
                    reading.status === 'credited' ? 'credited' : 'reconciliation_required',
                    reading.receivedAt || new Date().toISOString(),
                    reading.creditedAt || null,
                    reading.hcsTransactionId || null,
                    reading.htsTransactionId || null,
                    reading.error || 'Imported from legacy JSON; reconcile before retry.',
                ],
            );
            imported.meterReadings += result.rowCount;
        }
        await client.query('COMMIT');
        return imported;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    checkDatabase,
    createOffer,
    findTradeByTransactionId,
    getOffer,
    getMeterReading,
    importLegacyData,
    listOffers,
    listTrades,
    recordTrade,
    reserveMeterReading,
    updateMeterReading,
    saveIdentityBinding,
    getIdentityBindingByEvm,
    getIdentityBindingByHedera,
    deleteIdentityBinding,
};
