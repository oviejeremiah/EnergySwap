// EnergySwap · server.js  ─ Complete News Engine v3
// ═══════════════════════════════════════════════════════════════
//  SUPPORTED NEWS APIs (add keys to .env to activate)
//
//  FREE — No key required:
//    CryptoCompare   https://min-api.cryptocompare.com
//    Dev.to          https://dev.to/api
//    Hashnode        https://gql.hashnode.com  (GraphQL)
//    Reddit JSON     https://www.reddit.com/r/<sub>.json
//
//  FREE — Key required (free tier available):
//    NEWS_API_KEY        https://newsapi.org/register          (100/day)
//    GNEWS_API_KEY       https://gnews.io/                     (100/day)
//    THENEWS_API_KEY     https://www.thenewsapi.com/register   (100/day)
//    MEDIASTACK_KEY      https://mediastack.com/               (500/month, HTTP only)
//    CURRENTS_API_KEY    https://currentsapi.services/         (600/day)
//
//  Cache TTL: 8 min.  Refresh: background job every 8 min.
// ═══════════════════════════════════════════════════════════════

if (require.main === module) require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const https = require('https');
const http = require('http');
const { randomUUID } = require('node:crypto');
const { getHbarPrice } = require('./priceService');
const { loadConfig } = require('./config');
const database = require('./database');
const repository = require('./repository');
const {
    AccountId,
    Client,
    PrivateKey,
    TopicMessageSubmitTransaction,
    TransactionId,
    TransactionRecordQuery,
    TransferTransaction,
} = require('@hashgraph/sdk');
const {
    canonicalizeReading,
    getGatewayKeyFingerprint,
    isReadingFresh,
    normalizeReading,
    verifyMeterReading,
} = require('./oracle-attestation');

let config = loadConfig();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
app.locals.repository = repository;
app.locals.config = config;
app.locals.createHederaClient = () => Client.forTestnet();
app.locals.submitHcsMessage = async (client, topicId, message) => {
    const transaction = await new TopicMessageSubmitTransaction()
        .setTopicId(topicId)
        .setMessage(message)
        .execute(client);
    await transaction.getReceipt(client);
    return transaction;
};
app.locals.creditEnergyTokens = async (client, operatorId, prosumerAccountId, tokenId, tokenUnits, readingId) => {
    const transaction = await new TransferTransaction()
        .addTokenTransfer(tokenId, operatorId, -tokenUnits)
        .addTokenTransfer(tokenId, prosumerAccountId, tokenUnits)
        .setTransactionMemo(`EnergySwap meter ${readingId}`)
        .execute(client);
    await transaction.getReceipt(client);
    return transaction;
};
app.locals.getHcsConsensusTimestamp = async (client, transactionId) => {
    const record = await new TransactionRecordQuery().setTransactionId(transactionId).execute(client);
    return record.consensusTimestamp?.toDate().toISOString() || null;
};

const writeRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again shortly.' },
});

app.use(helmet());
app.use(
    cors({
        origin(origin, callback) {
            callback(null, !origin || config.corsOrigins.includes(origin));
        },
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type'],
        maxAge: 600,
    }),
);
app.use(express.json({ limit: '32kb', strict: true }));
app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if (!req.is('application/json')) {
        return res.status(415).json({ success: false, message: 'Content-Type must be application/json.' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ success: false, message: 'Request body must be a JSON object.' });
    }
    return next();
});
app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    const startedAt = Date.now();
    res.on('finish', () => {
        console.log(
            JSON.stringify({
                event: 'http_request',
                requestId: req.requestId,
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs: Date.now() - startedAt,
            }),
        );
    });
    next();
});
app.get('/health/live', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => {
    try {
        await app.locals.repository.checkDatabase();
        res.status(200).json({ status: 'ready', network: app.locals.config.hederaNetwork });
    } catch (error) {
        console.error('[Health] Database readiness check failed:', error.message, 'requestId:', _req.requestId);
        res.status(503).json({ status: 'not_ready' });
    }
});
app.get('/api/oracle/gateway', (_req, res) => {
    if (!app.locals.config.meterOraclePublicKey) {
        return res.status(503).json({ success: false, message: 'Meter gateway is not configured.' });
    }
    return res.json({
        schemaVersion: 2,
        algorithm: 'Ed25519',
        publicKey: app.locals.config.meterOraclePublicKey.replace(/\\n/g, '\n'),
        keyFingerprint: getGatewayKeyFingerprint(app.locals.config.meterOraclePublicKey),
        trustModel: 'Configured gateway attests the meter identity, prosumer attribution, interval, and generated energy.',
    });
});

// ── ENV KEYS ──────────────────────────────────────────────────────
const KEY = {
    newsapi: process.env.NEWS_API_KEY || '',
    gnews: process.env.GNEWS_API_KEY || '',
    thenews: process.env.THENEWS_API_KEY || '',
    mediastack: process.env.MEDIASTACK_KEY || '',
    currents: process.env.CURRENTS_API_KEY || '',
};

function logNewsKeyStatus() {
    console.log('\n[News] API key status:');
    Object.entries(KEY).forEach(([k, v]) =>
        console.log(
            `  ${v ? '✓' : '✗'} ${k.padEnd(12)} ${v ? '(configured)' : '(not set — add to .env for extra coverage)'}`,
        ),
    );
    console.log('  ✓ CryptoCompare, Dev.to, Hashnode, Reddit — free, no key needed\n');
}

// ═══════════════════════════════════════════════════════════════════
//  OFFER ROUTES
// ═══════════════════════════════════════════════════════════════════
app.post('/api/post-offer', writeRateLimiter, async (req, res) => {
    try {
        const { prosumerId, energyAmountKWh, hbarPerKWh } = req.body;
        if (typeof prosumerId !== 'string' || !prosumerId.trim() || energyAmountKWh === undefined || hbarPerKWh === undefined)
            return res
                .status(400)
                .json({ success: false, message: 'Missing required fields: prosumerId, energyAmountKWh, hbarPerKWh.' });
        try {
            AccountId.fromString(prosumerId.trim());
        } catch {
            return res.status(400).json({ success: false, message: 'prosumerId must be a valid Hedera account ID.' });
        }
        const kwh = Number(energyAmountKWh);
        const rate = Number(hbarPerKWh);
        if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 1_000_000)
            return res.status(400).json({ success: false, message: 'energyAmountKWh must be a positive number.' });
        if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000)
            return res.status(400).json({ success: false, message: 'hbarPerKWh must be a positive number.' });
        const offer = {
            id: `offer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            prosumerId: prosumerId.trim(),
            energyAmountKWh: kwh,
            hbarPerKWh: rate,
            totalHbar: parseFloat((kwh * rate).toFixed(6)),
            timestamp: new Date().toISOString(),
            status: 'available',
        };
        const savedOffer = await app.locals.repository.createOffer(offer);
        console.log('[Offer] Posted:', offer.id, 'by', prosumerId);
        res.status(201).json({ success: true, message: 'Offer posted successfully!', offer: savedOffer });
    } catch (e) {
        console.error('[Offer] Error:', e.message, 'requestId:', req.requestId);
        res.status(500).json({ success: false, message: 'Failed to post offer.' });
    }
});

app.get('/api/offers', async (req, res) => {
    try {
        res.json({ success: true, offers: await app.locals.repository.listOffers({ availableOnly: true }) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Failed to fetch offers.', error: e.message });
    }
});

app.get('/api/all-offers', async (req, res) => {
    try {
        res.json({ success: true, offers: await app.locals.repository.listOffers() });
    } catch (e) {
        console.error('[Offer] List failed:', e.message);
        res.status(500).json({ success: false, message: 'Failed to fetch all offers.' });
    }
});

app.post('/api/oracle/readings', writeRateLimiter, async (req, res) => {
    if (!app.locals.config.meterOraclePublicKey)
        return res.status(503).json({ success: false, message: 'Meter oracle verification is not configured.' });
    if (
        !app.locals.config.operatorId ||
        !app.locals.config.operatorKey ||
        !app.locals.config.hcsTopicId ||
        !app.locals.config.energyTokenId
    )
        return res
            .status(503)
            .json({ success: false, message: 'Hedera operator, HCS topic, and HTS token configuration are required.' });

    let reading;
    try {
        reading = normalizeReading(req.body?.reading);
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
    const signature = req.body?.signature;
    if (!verifyMeterReading(reading, signature, app.locals.config.meterOraclePublicKey))
        return res.status(401).json({ success: false, message: 'Meter reading signature is invalid.' });

    let prosumerAccountId;
    try {
        prosumerAccountId = AccountId.fromString(reading.prosumerId);
    } catch {
        return res.status(400).json({ success: false, message: 'prosumerId must be a valid Hedera account ID.' });
    }

    const tokenUnits = Math.round(reading.kwhGenerated * 100);
    if (!Number.isSafeInteger(tokenUnits) || tokenUnits <= 0)
        return res.status(400).json({ success: false, message: 'Reading exceeds supported HTS credit precision.' });

    try {
        const canonicalReading = canonicalizeReading(reading);
        const gatewayPublicKey = app.locals.config.meterOraclePublicKey.replace(/\\n/g, '\n');
        const gatewayKeyFingerprint = getGatewayKeyFingerprint(gatewayPublicKey);
        const existing = await app.locals.repository.getMeterReading(reading.readingId);
        if (existing) {
            if (existing.canonicalReading !== canonicalReading)
                return res
                    .status(409)
                    .json({ success: false, message: 'readingId is already bound to a different signed reading.' });
            if (existing.status === 'credited')
                return res.status(200).json({ success: true, duplicate: true, reading: existing });
            return res.status(409).json({
                success: false,
                message: 'This reading is already pending chain reconciliation; it will not be credited again automatically.',
                reading: { readingId: existing.readingId, status: existing.status },
            });
        }
        if (!isReadingFresh(reading))
            return res
                .status(400)
                .json({ success: false, message: 'Reading timestamp must be within five minutes of server time.' });

        const reservation = await app.locals.repository.reserveMeterReading({
            ...reading,
            canonicalReading,
            signature,
            tokenUnits,
            status: 'hcs_pending',
            receivedAt: new Date().toISOString(),
            hcsTopicId: app.locals.config.hcsTopicId,
            gatewayPublicKey,
            gatewayKeyFingerprint,
        });
        if (!reservation.created) {
            if (reservation.conflict === 'meter_interval') {
                return res.status(409).json({
                    success: false,
                    message: 'This meter interval already has an attestation and cannot be submitted again.',
                    existingReadingId: reservation.reading.readingId,
                    status: reservation.reading.status,
                });
            }
            if (reservation.reading.canonicalReading !== canonicalReading)
                return res
                    .status(409)
                    .json({ success: false, message: 'readingId is already bound to a different signed reading.' });
            if (reservation.reading.status === 'credited')
                return res.status(200).json({ success: true, duplicate: true, reading: reservation.reading });
            return res.status(409).json({
                success: false,
                message: 'This reading is already pending chain reconciliation; it will not be credited again automatically.',
                reading: { readingId: reservation.reading.readingId, status: reservation.reading.status },
            });
        }

        const client = app.locals.createHederaClient();
        let record = reservation.reading;
        try {
            const operatorId = AccountId.fromString(app.locals.config.operatorId);
            client.setOperator(operatorId, PrivateKey.fromString(app.locals.config.operatorKey));

            const hcsMessage = JSON.stringify({
                ...reading,
                signature,
                gatewayPublicKey,
                gatewayKeyFingerprint,
                network: app.locals.config.hederaNetwork,
                tokenId: app.locals.config.energyTokenId,
            });
            if (Buffer.byteLength(hcsMessage, 'utf8') > 1024) {
                record = await app.locals.repository.updateMeterReading(reading.readingId, {
                    status: 'rejected',
                    error: 'Attestation exceeds the HCS message size limit.',
                });
                return res.status(400).json({ success: false, message: record.error });
            }

            const hcsSubmit = await app.locals.submitHcsMessage(
                client,
                app.locals.config.hcsTopicId,
                hcsMessage,
            );
            record = await app.locals.repository.updateMeterReading(reading.readingId, {
                hcsTransactionId: hcsSubmit.transactionId.toString(),
                attestedAt: new Date().toISOString(),
                status: 'attested_pending_credit',
                error: null,
            });

            try {
                const consensusTimestamp = await app.locals.getHcsConsensusTimestamp(client, hcsSubmit.transactionId);
                if (consensusTimestamp) {
                    record = await app.locals.repository.updateMeterReading(reading.readingId, {
                        hcsConsensusTimestamp: consensusTimestamp,
                    });
                }
            } catch (error) {
                console.warn('[Oracle] HCS transaction is confirmed, but consensus timestamp lookup failed:', error.message);
            }

            record = await app.locals.repository.updateMeterReading(reading.readingId, {
                status: 'credit_pending',
            });
            const htsTransfer = await app.locals.creditEnergyTokens(
                client,
                operatorId,
                prosumerAccountId,
                app.locals.config.energyTokenId,
                tokenUnits,
                reading.readingId,
            );
            record = await app.locals.repository.updateMeterReading(reading.readingId, {
                htsTransactionId: htsTransfer.transactionId.toString(),
                status: 'credited',
                creditedAt: new Date().toISOString(),
                error: null,
            });
            return res.status(201).json({ success: true, reading: record });
        } catch (error) {
            console.error('[Oracle] Attestation/credit failed:', error.message);
            try {
                await app.locals.repository.updateMeterReading(reading.readingId, {
                    error: 'Chain operation failed; this reading requires reconciliation before retry.',
                });
            } catch (persistenceError) {
                console.error('[Oracle] Could not persist chain failure state:', persistenceError.message);
            }
            return res.status(502).json({
                success: false,
                message: 'Chain operation failed; this reading requires reconciliation before retry.',
                readingId: reading.readingId,
                status: record.status,
            });
        } finally {
            client.close();
        }
    } catch (error) {
        console.error('[Oracle] Reading persistence failed:', error.message);
        res.status(500).json({ success: false, message: 'Could not persist meter reading state.' });
    }
});

app.get('/api/oracle/readings/:readingId', async (req, res) => {
    try {
        const reading = await app.locals.repository.getMeterReading(req.params.readingId);
        if (!reading) return res.status(404).json({ success: false, message: 'Reading evidence not found.' });
        if (!reading.intervalStart || !reading.intervalEnd || !reading.gatewayPublicKey || !reading.hcsTopicId) {
            return res.status(410).json({
                success: false,
                message: 'This legacy reading predates signed interval evidence; use its recorded transaction IDs for review.',
                evidence: {
                    readingId: reading.readingId,
                    status: reading.status,
                    hcsTransactionId: reading.hcsTransactionId || null,
                },
            });
        }
        return res.json({
            evidence: {
                reading: {
                    schemaVersion: 2,
                    readingId: reading.readingId,
                    meterId: reading.meterId,
                    prosumerId: reading.prosumerId,
                    intervalStart: reading.intervalStart,
                    intervalEnd: reading.intervalEnd,
                    intervalConvention: '[start,end)',
                    kwhGenerated: reading.kwhGenerated,
                },
                canonicalReading: reading.canonicalReading,
                signature: reading.signature,
                gateway: {
                    algorithm: 'Ed25519',
                    publicKey: reading.gatewayPublicKey,
                    keyFingerprint: reading.gatewayKeyFingerprint,
                },
                network: app.locals.config.hederaNetwork,
                status: reading.status,
                receivedAt: reading.receivedAt,
                attestedAt: reading.attestedAt || null,
                hcs: {
                    topicId: reading.hcsTopicId,
                    transactionId: reading.hcsTransactionId || null,
                    consensusTimestamp: reading.hcsConsensusTimestamp || null,
                    topicUrl: `https://hashscan.io/testnet/topic/${encodeURIComponent(reading.hcsTopicId)}`,
                    transactionUrl: reading.hcsTransactionId
                        ? `https://hashscan.io/testnet/transaction/${encodeURIComponent(reading.hcsTransactionId)}`
                        : null,
                },
                htsTransactionId: reading.htsTransactionId || null,
                creditedAt: reading.creditedAt || null,
            },
        });
    } catch (error) {
        console.error('[Oracle] Evidence lookup failed:', error.message, 'requestId:', req.requestId);
        return res.status(500).json({ success: false, message: 'Could not retrieve reading evidence.' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  TRADE ROUTES
// ═══════════════════════════════════════════════════════════════════
app.post('/api/record-trade', writeRateLimiter, async (req, res) => {
    const { offerId, energyAmountKWh, consumerAccountId, transactionId } = req.body;
    if (
        typeof offerId !== 'string' ||
        !offerId ||
        energyAmountKWh === undefined ||
        typeof consumerAccountId !== 'string' ||
        !consumerAccountId ||
        typeof transactionId !== 'string' ||
        !transactionId
    )
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    let parsedTransactionId;
    try {
        AccountId.fromString(consumerAccountId);
        parsedTransactionId = TransactionId.fromString(transactionId);
    } catch {
        return res.status(400).json({ success: false, message: 'Invalid Hedera account or transaction ID.' });
    }

    let previous;
    try {
        previous = await app.locals.repository.findTradeByTransactionId(transactionId);
    } catch (error) {
        console.error('[Trade] Duplicate check failed:', error.message, 'requestId:', req.requestId);
        return res.status(503).json({ success: false, message: 'Trade storage is unavailable.' });
    }
    if (previous) {
        if (previous.status !== 'completed')
            return res.status(409).json({
                success: false,
                message: 'This confirmed payment requires operator reconciliation before completion.',
                transactionId,
            });
        return res.json({
            success: true,
            message: 'Trade already recorded.',
            kwhTraded: previous.energyAmountKWh,
            hbarPaid: previous.hbarAmount,
            gasFeeHbar: previous.gasFeeHbar,
            gasFeeUSD: previous.gasFeeUSD,
            totalHbarPaid: previous.totalHbarPaid,
            trade: previous,
        });
    }

    let client;
    try {
        if (!app.locals.config.operatorId || !app.locals.config.operatorKey)
            return res.status(503).json({
                success: false,
                message: 'Backend operator credentials are required to verify the confirmed transaction.',
            });
        const offer = await app.locals.repository.getOffer(offerId);
        if (!offer)
            return res.status(404).json({ success: false, message: 'Offer not found or no longer available.' });
        const requestedKwh = Number(energyAmountKWh);
        if (!Number.isFinite(requestedKwh) || requestedKwh <= 0 || requestedKwh > 1_000_000)
            return res.status(400).json({ success: false, message: 'energyAmountKWh must be a positive number.' });
        const kwhTraded = Number(requestedKwh.toFixed(8));
        const hbarAmount = Number((kwhTraded * offer.hbarPerKWh).toFixed(8));
        if (hbarAmount <= 0)
            return res
                .status(400)
                .json({ success: false, message: 'Trade amount is below the supported HBAR precision.' });

        client = app.locals.createHederaClient();
        client.setOperator(
            AccountId.fromString(app.locals.config.operatorId),
            PrivateKey.fromString(app.locals.config.operatorKey),
        );
        const transactionRecord = await new TransactionRecordQuery()
            .setTransactionId(parsedTransactionId)
            .execute(client);
        if (transactionRecord.receipt?.status?.toString() !== 'SUCCESS')
            return res.status(400).json({ success: false, message: 'Hedera transaction did not succeed.' });
        if (transactionRecord.transactionId.accountId?.toString() !== consumerAccountId)
            return res.status(400).json({ success: false, message: 'The consumer must be the transaction fee payer.' });
        if (transactionRecord.transactionMemo !== `EnergySwap ${offer.id}`)
            return res
                .status(400)
                .json({ success: false, message: 'Transaction memo does not match the selected offer.' });

        const expectedTinybars = BigInt(Math.round(hbarAmount * 100_000_000));
        const sellerTransfer = transactionRecord.transfers.find((t) => t.accountId.toString() === offer.prosumerId);
        const buyerTransfer = transactionRecord.transfers.find((t) => t.accountId.toString() === consumerAccountId);
        const feeTinybars = BigInt(transactionRecord.transactionFee.toTinybars().toString());
        if (!sellerTransfer || BigInt(sellerTransfer.amount.toTinybars().toString()) !== expectedTinybars)
            return res.status(400).json({
                success: false,
                message: 'Confirmed transaction does not pay the posted offer amount to the prosumer.',
            });
        if (!buyerTransfer || -BigInt(buyerTransfer.amount.toTinybars().toString()) !== expectedTinybars + feeTinybars)
            return res.status(400).json({
                success: false,
                message: 'Confirmed transaction does not charge the consumer for the offer and network fee.',
            });

        const gasFeeHbar = Number(feeTinybars) / 100_000_000;
        const totalHbarPaid = Number((hbarAmount + gasFeeHbar).toFixed(8));
        const hbarPrice = await getHbarPrice();
        const trade = {
            id: `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            offerId,
            buyerId: consumerAccountId,
            sellerId: offer.prosumerId,
            transactionId,
            energyAmountKWh: kwhTraded.toFixed(8),
            hbarAmount,
            hbarPerKWh: offer.hbarPerKWh,
            gasFeeHbar,
            totalHbarPaid,
            hbarPriceUSD: hbarPrice,
            gasFeeUSD: (gasFeeHbar * hbarPrice).toFixed(6),
            timestamp: new Date().toISOString(),
        };
        const recorded = await app.locals.repository.recordTrade(trade);
        if (recorded.kind === 'duplicate' && recorded.trade.status === 'completed') {
            return res.json({
                success: true,
                message: 'Trade already recorded.',
                kwhTraded: recorded.trade.energyAmountKWh,
                hbarPaid: recorded.trade.hbarAmount,
                gasFeeHbar: recorded.trade.gasFeeHbar,
                gasFeeUSD: recorded.trade.gasFeeUSD,
                totalHbarPaid: recorded.trade.totalHbarPaid,
                trade: recorded.trade,
            });
        }
        if (recorded.kind !== 'recorded')
            return res.status(409).json({
                success: false,
                message: 'The confirmed payment is recorded for operator reconciliation; offer capacity was not changed.',
                transactionId,
                status: recorded.trade?.status || recorded.kind,
            });
        console.log('[Trade] Executed:', recorded.trade.id);
        return res.status(201).json({
            success: true,
            message: 'Confirmed trade recorded.',
            kwhTraded: recorded.trade.energyAmountKWh,
            hbarPaid: hbarAmount,
            gasFeeHbar,
            gasFeeUSD: recorded.trade.gasFeeUSD,
            totalHbarPaid,
            trade: recorded.trade,
        });
    } catch (e) {
        console.error('[Trade] Error:', e.message, 'requestId:', req.requestId);
        res.status(500).json({ success: false, message: 'Failed to record the confirmed trade.' });
    } finally {
        if (client) client.close();
    }
});

app.get('/api/trades', async (req, res) => {
    try {
        res.json({ success: true, trades: await app.locals.repository.listTrades({ completedOnly: true }) });
    } catch (e) {
        console.error('[Trade] List failed:', e.message);
        res.status(500).json({ success: false, message: 'Failed to fetch trades.' });
    }
});

app.get('/api/hbar-price', async (req, res) => {
    try {
        res.json({ success: true, priceUSD: await getHbarPrice() });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  HTTP FETCH ENGINE
// ═══════════════════════════════════════════════════════════════════

function rawFetch(url, timeoutMs, _depth) {
    timeoutMs = timeoutMs || 10000;
    _depth = _depth || 0;
    if (_depth > 4) return Promise.resolve({ status: 0, text: '' });

    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return resolve({ status: 0, text: '' });
        }

        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: (parsed.pathname || '/') + (parsed.search || ''),
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json, application/rss+xml, application/xml, text/xml, */*',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache',
                Connection: 'close',
            },
        };

        const req = lib.request(options, (r) => {
            // Follow redirects
            if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
                const next = r.headers.location.startsWith('http')
                    ? r.headers.location
                    : `${parsed.origin}${r.headers.location}`;
                return rawFetch(next, timeoutMs, _depth + 1).then(resolve);
            }
            let body = '';
            r.setEncoding('utf8');
            r.on('data', (c) => {
                if (body.length < 3_000_000) body += c;
            });
            r.on('end', () => resolve({ status: r.statusCode, text: body }));
        });

        req.on('error', (e) => {
            console.warn(`    [HTTP ERR] ${e.code || e.message}  ${redactUrl(url).slice(0, 80)}`);
            resolve({ status: 0, text: '' });
        });
        req.setTimeout(timeoutMs, () => {
            console.warn(`    [TIMEOUT ${timeoutMs}ms]  ${redactUrl(url).slice(0, 80)}`);
            req.destroy();
            resolve({ status: 0, text: '' });
        });
        req.end();
    });
}

function redactUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`;
    } catch {
        return '[invalid-url]';
    }
}

async function getJSON(url, label) {
    process.stdout.write(`  → [${label}] `);
    const r = await rawFetch(url);
    if (r.status === 0) {
        console.log(`NETWORK ERROR`);
        return null;
    }
    if (r.status !== 200) {
        console.log(`HTTP ${r.status}`);
        return null;
    }
    try {
        const d = JSON.parse(r.text);
        console.log(`HTTP 200 OK`);
        return d;
    } catch (e) {
        console.log(`JSON parse failed: ${e.message.slice(0, 60)}`);
        return null;
    }
}

async function postJSON(url, label, body) {
    process.stdout.write(`  → [${label}] `);
    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            console.log('Bad URL');
            return resolve(null);
        }
        const payload = JSON.stringify(body);
        const options = {
            hostname: parsed.hostname,
            port: 443,
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const req = https.request(options, (r) => {
            let data = '';
            r.setEncoding('utf8');
            r.on('data', (c) => (data += c));
            r.on('end', () => {
                try {
                    console.log(`HTTP ${r.statusCode}`);
                    resolve(r.statusCode === 200 ? JSON.parse(data) : null);
                } catch {
                    console.log(`JSON parse failed`);
                    resolve(null);
                }
            });
        });
        req.on('error', (e) => {
            console.log(`ERROR: ${e.message}`);
            resolve(null);
        });
        req.setTimeout(10000, () => {
            req.destroy();
            console.log('TIMEOUT');
            resolve(null);
        });
        req.write(payload);
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════════════
//  RSS PARSER (no dependencies)
// ═══════════════════════════════════════════════════════════════════
function parseRSS(xml, source) {
    if (!xml || xml.length < 100) return [];
    const items = [];
    const isAtom = /<feed[\s>]/i.test(xml);
    const tag = isAtom ? 'entry' : 'item';
    const re = new RegExp(`<${tag}[\\s>]([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const pick = (chunk, ...tags) => {
        for (const t of tags) {
            const cdata = chunk.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i'));
            if (cdata) return cdata[1].trim();
            const plain = chunk.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i'));
            if (plain) return plain[1].replace(/<[^>]+>/g, ' ').trim();
        }
        return '';
    };
    const pickUrl = (chunk) => {
        const ah = chunk.match(/<link[^>]+href="([^"]+)"/i);
        if (ah) return ah[1];
        const rl = chunk.match(/<link[^>]*>\s*([^<\s][^<]*)/i);
        if (rl) return rl[1].trim();
        return '';
    };
    let m;
    while ((m = re.exec(xml)) !== null) {
        const raw = m[1];
        const title = pick(raw, 'title');
        const desc = pick(raw, 'description', 'summary', 'content:encoded', 'content', 'media:description');
        const link = pickUrl(raw);
        const date = pick(raw, 'pubDate', 'published', 'updated', 'dc:date');
        if (title && title.length > 4) {
            items.push({ title: ct(title, 90), description: ct(desc, 160), url: link, pubDate: date, source });
        }
        if (items.length >= 10) break;
    }
    return items;
}

async function getRSS(url, label) {
    process.stdout.write(`  → [${label}] `);
    const r = await rawFetch(url, 10000);
    if (r.status === 0) {
        console.log(`NETWORK ERROR`);
        return [];
    }
    if (r.status !== 200) {
        console.log(`HTTP ${r.status}`);
        return [];
    }
    const items = parseRSS(r.text, label);
    console.log(`HTTP 200 — ${items.length} RSS items`);
    return items;
}

// ═══════════════════════════════════════════════════════════════════
//  TEXT / DATE UTILS
// ═══════════════════════════════════════════════════════════════════
function ct(s, n) {
    if (!s) return '';
    s = String(s)
        .replace(/(<([^>]+)>)/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return n && s.length > n ? s.slice(0, n - 3) + '...' : s;
}
function fmtD(ts) {
    if (!ts) return 'Latest';
    try {
        const d = new Date(isNaN(Number(ts)) ? ts : Number(ts) * 1000);
        return isNaN(d) ? 'Latest' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    } catch {
        return 'Latest';
    }
}

// ── Tag helpers ───────────────────────────────────────────────────
function tagCrypto(t = '', c = '') {
    const s = (t + c).toLowerCase();
    if (/hedera|hbar/.test(s)) return 'Hedera';
    if (/bitcoin|\bbtc\b/.test(s)) return 'Bitcoin';
    if (/ethereum|\beth\b/.test(s)) return 'Ethereum';
    if (/solana|\bsol\b/.test(s)) return 'Solana';
    if (/\bxrp\b|ripple/.test(s)) return 'XRP';
    if (/defi|decentrali/.test(s)) return 'DeFi';
    if (/layer.?2|rollup|arbitrum|base\b/.test(s)) return 'Layer 2';
    if (/nft/.test(s)) return 'NFT';
    if (/regulat|sec\b|legal/.test(s)) return 'Regulation';
    if (/ai\b|artificial intel/.test(s)) return 'AI+Crypto';
    return 'Crypto';
}
function tagEnergy(t = '') {
    const s = t.toLowerCase();
    if (/solar|photovolt|\bpv\b/.test(s)) return 'Solar';
    if (/wind|turbine|offshore/.test(s)) return 'Wind';
    if (/hydrogen/.test(s)) return 'Hydrogen';
    if (/battery|storage/.test(s)) return 'Storage';
    if (/grid|smart meter/.test(s)) return 'SmartGrid';
    if (/nuclear/.test(s)) return 'Nuclear';
    if (/carbon|emission|net.?zero|co2/.test(s)) return 'Carbon';
    if (/p2p|prosumer/.test(s)) return 'P2P';
    if (/oil|gas|fossil/.test(s)) return 'Fossil';
    return 'Energy';
}
function tagTech(t = '') {
    const s = t.toLowerCase();
    if (/\bai\b|artificial intel|openai|chatgpt|llm|anthropic|gemini|machine learn|deep learn/.test(s)) return 'AI';
    if (/quantum/.test(s)) return 'Quantum';
    if (/nvidia|chip|gpu|semiconductor/.test(s)) return 'Hardware';
    if (/iot|smart meter|sensor/.test(s)) return 'IoT';
    if (/robot|automat/.test(s)) return 'Robotics';
    if (/cyber|security|hack|breach/.test(s)) return 'Security';
    if (/cloud|data cent/.test(s)) return 'Cloud';
    if (/regulat|policy|\blaw\b/.test(s)) return 'Regulation';
    if (/blockchain|crypto|web3/.test(s)) return 'Blockchain';
    return 'Tech';
}
function tagForex(t = '') {
    const s = t.toLowerCase();
    if (/gold|xau|\bxau/.test(s)) return 'Gold';
    if (/silver|xag/.test(s)) return 'Silver';
    if (/oil|brent|crude|wti/.test(s)) return 'Oil';
    if (/\beuro\b|\beur\b/.test(s)) return 'EUR';
    if (/pound|sterling|\bgbp\b/.test(s)) return 'GBP';
    if (/\byen\b|\bjpy\b|japan/.test(s)) return 'JPY';
    if (/yuan|rmb|\bcny\b/.test(s)) return 'CNY';
    if (/dollar|\busd\b|\bfed\b|federal reserve/.test(s)) return 'USD';
    if (/rate|inflation|interest|cpi/.test(s)) return 'Rates';
    if (/ecb|bank of england|bank of japan|central bank/.test(s)) return 'Central Banks';
    if (/bitcoin|crypto/.test(s)) return 'Crypto';
    return 'Markets';
}

// ═══════════════════════════════════════════════════════════════════
//  CURATED FALLBACK CONTENT
// ═══════════════════════════════════════════════════════════════════
const CURATED = {
    blockchain: [
        {
            headline: 'Hedera Hashgraph Processes 10 Billion Transactions — Fastest Public DLT',
            summary:
                'Hedera continues to demonstrate enterprise-grade throughput with near-zero fees, cementing its position as the leading platform for tokenised assets, P2P energy trading and real-world asset tokenisation.',
            tag: 'Hedera',
            url: 'https://hedera.com/blog',
            source: 'Hedera',
            publishedAt: 'Latest',
        },
        {
            headline: 'Bitcoin ETFs Attract Record $2bn Weekly Inflow From Institutional Buyers',
            summary:
                'Spot Bitcoin ETF products continue to see massive institutional demand, with total AUM crossing $60bn as mainstream adoption accelerates globally.',
            tag: 'Bitcoin',
            url: 'https://www.coindesk.com',
            source: 'CoinDesk',
            publishedAt: 'Latest',
        },
        {
            headline: 'Ethereum Layer 2 Networks Now Process More Transactions Than Mainnet',
            summary:
                'Rollup-based L2 networks including Arbitrum and Base collectively exceed Ethereum mainnet throughput, reducing fees to fractions of a cent for DeFi users.',
            tag: 'Ethereum',
            url: 'https://ethereum.org',
            source: 'Ethereum Foundation',
            publishedAt: 'Latest',
        },
        {
            headline: 'DeFi Total Value Locked Crosses $200bn as Real-World Asset Tokenisation Grows',
            summary:
                'Decentralised finance protocols are seeing record capital inflows, with tokenised bonds, real estate and energy credits driving the next growth wave.',
            tag: 'DeFi',
            url: 'https://defillama.com',
            source: 'DefiLlama',
            publishedAt: 'Latest',
        },
        {
            headline: 'Solana Processes 65,000 TPS in Stress Test — Challenges Ethereum Dominance',
            summary:
                'Solana network upgrades have dramatically improved reliability, attracting major DeFi protocols and NFT platforms previously built exclusively on Ethereum.',
            tag: 'Solana',
            url: 'https://solana.com',
            source: 'Solana Foundation',
            publishedAt: 'Latest',
        },
        {
            headline: 'Ripple Wins SEC Case — XRP Classified as Non-Security in Secondary Markets',
            summary:
                'The landmark ruling provides regulatory clarity for dozens of altcoins, opening the door for XRP ETF applications with major industry implications.',
            tag: 'Regulation',
            url: 'https://ripple.com',
            source: 'Ripple',
            publishedAt: 'Latest',
        },
    ],
    energy: [
        {
            headline: 'Global Solar Capacity Surpasses 1.5 Terawatts as Installation Costs Hit Record Lows',
            summary:
                'Solar installation costs have dropped 89% over the past decade, making it the cheapest electricity source in history. New capacity broke records for the fourth consecutive year.',
            tag: 'Solar',
            url: 'https://www.iea.org',
            source: 'IEA',
            publishedAt: 'Latest',
        },
        {
            headline: 'P2P Energy Trading Platforms Drive Prosumer Revolution Across UK Grid',
            summary:
                'Peer-to-peer energy marketplaces are enabling solar panel owners to sell surplus electricity directly to neighbours, reducing bills by up to 30%.',
            tag: 'P2P',
            url: 'https://www.ofgem.gov.uk',
            source: 'Ofgem',
            publishedAt: 'Latest',
        },
        {
            headline: 'Battery Storage Costs Fall 70% in Five Years — 24/7 Renewable Power Now Viable',
            summary:
                'Grid-scale lithium-ion battery storage has become economically viable for most markets, solving the intermittency problem that limited renewable energy expansion.',
            tag: 'Storage',
            url: 'https://www.irena.org',
            source: 'IRENA',
            publishedAt: 'Latest',
        },
        {
            headline: 'Hedera Carbon Credit Tokenisation Project Goes Live With 50 Energy Firms',
            summary:
                'Blockchain platforms including Hedera are issuing verifiable carbon credits tied to renewable energy generation, creating transparent audit trails on-chain.',
            tag: 'Blockchain',
            url: 'https://hedera.com',
            source: 'Hedera',
            publishedAt: 'Latest',
        },
        {
            headline: 'Smart Grid AI Reduces Energy Waste by 30% in Amsterdam, Seoul and Singapore',
            summary:
                'AI-driven smart grid systems dynamically balancing supply and demand are showing dramatic efficiency improvements across major cities worldwide.',
            tag: 'SmartGrid',
            url: 'https://www.energy.gov',
            source: 'Dept. of Energy',
            publishedAt: 'Latest',
        },
        {
            headline: 'Offshore Wind Investment Hits Record £100bn as North Sea Becomes Green Hub',
            summary:
                "European governments are accelerating offshore wind deployment to meet 2030 climate targets, with the North Sea emerging as the world's largest renewable energy zone.",
            tag: 'Wind',
            url: 'https://www.windeurope.org',
            source: 'WindEurope',
            publishedAt: 'Latest',
        },
    ],
    tech: [
        {
            headline: 'AI Data Centre Power Demand to Rival Aviation Industry by 2030 — IEA Warns',
            summary:
                'Data centres powering large language models are projected to consume 4% of global electricity by 2030, making clean energy a critical priority for the AI industry.',
            tag: 'AI+Energy',
            url: 'https://www.iea.org',
            source: 'IEA',
            publishedAt: 'Latest',
        },
        {
            headline: 'Google DeepMind AI Predicts Electricity Grid Demand 36 Hours Ahead With 95% Accuracy',
            summary:
                'A neural forecasting model reduces grid balancing costs by 13% by accurately predicting renewable supply and consumer demand at substation level.',
            tag: 'AI',
            url: 'https://deepmind.google',
            source: 'DeepMind',
            publishedAt: 'Latest',
        },
        {
            headline: 'EU AI Act Now Enforced — Fintech and Energy Trading Platforms Must Comply',
            summary:
                "The world's first comprehensive AI regulation classifies algorithmic trading and energy pricing as high-risk, requiring human oversight and explainability.",
            tag: 'Regulation',
            url: 'https://digital-strategy.ec.europa.eu',
            source: 'EU Commission',
            publishedAt: 'Latest',
        },
        {
            headline: 'Smart Meters and IoT Enable Automatic Energy Arbitrage for Households',
            summary:
                'Home automation systems connecting with P2P platforms now automatically buy cheap off-peak electricity and sell solar surplus at peak prices.',
            tag: 'IoT',
            url: 'https://www.smartenergy.com',
            source: 'SmartEnergy',
            publishedAt: 'Latest',
        },
        {
            headline: 'Nvidia Next-Gen GPU Delivers 4× AI Performance at 30% Lower Energy Consumption',
            summary:
                'The new architecture addresses sustainability concerns around AI infrastructure while dramatically cutting training costs for smaller organisations.',
            tag: 'Hardware',
            url: 'https://www.nvidia.com',
            source: 'Nvidia',
            publishedAt: 'Latest',
        },
        {
            headline: 'OpenAI, Anthropic and Google Pledge 100% Renewable Data Centres by 2030',
            summary:
                'Major AI labs committed to powering all data centres with clean energy, driving enormous investment in solar, wind and next-generation nuclear capacity.',
            tag: 'AI',
            url: 'https://openai.com',
            source: 'OpenAI',
            publishedAt: 'Latest',
        },
    ],
    forex: [
        {
            headline: 'Federal Reserve Holds Rates Steady — Dollar Index Retreats From 3-Month High',
            summary:
                'The Fed signalled caution on rate cuts amid sticky inflation, causing DXY to pull back as traders repriced expectations. Gold surged on dollar weakness.',
            tag: 'USD',
            url: 'https://www.federalreserve.gov',
            source: 'Federal Reserve',
            publishedAt: 'Latest',
        },
        {
            headline: 'Gold Breaks All-Time High Above $3,100/oz as Central Bank Buying Accelerates',
            summary:
                'Spot gold surged to record levels driven by geopolitical uncertainty, central bank accumulation and falling real yields weakening the US dollar outlook.',
            tag: 'Gold',
            url: 'https://www.gold.org',
            source: 'World Gold Council',
            publishedAt: 'Latest',
        },
        {
            headline: 'ECB Signals Further Rate Cuts — EUR/USD Rises Toward 1.12',
            summary:
                'ECB President Lagarde confirmed disinflation is on track, boosting the euro against the dollar and reducing pressure on eurozone sovereign bond spreads.',
            tag: 'EUR',
            url: 'https://www.ecb.europa.eu',
            source: 'ECB',
            publishedAt: 'Latest',
        },
        {
            headline: 'Bank of England Cuts Base Rate as UK Inflation Falls to 2.3%',
            summary:
                'The MPC voted to cut rates, providing relief to UK mortgage holders. GBP/USD fell initially before recovering as markets priced a shallower easing cycle.',
            tag: 'GBP',
            url: 'https://www.bankofengland.co.uk',
            source: 'Bank of England',
            publishedAt: 'Latest',
        },
        {
            headline: 'Silver Surges 18% YTD — Solar Panel Demand Creates Structural Supply Deficit',
            summary:
                'Silver is outperforming gold as industrial demand from solar panel manufacturing accelerates, with analysts forecasting a multi-year supply deficit.',
            tag: 'Silver',
            url: 'https://www.silverinstitute.org',
            source: 'Silver Institute',
            publishedAt: 'Latest',
        },
        {
            headline: 'Bank of Japan Intervenes as Yen Weakens Past 155 — USD/JPY Spikes',
            summary:
                'Japan conducted yen-buying FX operations, warning of excessive one-sided market movements after USD/JPY surged through key psychological resistance.',
            tag: 'JPY',
            url: 'https://www.boj.or.jp',
            source: 'Bank of Japan',
            publishedAt: 'Latest',
        },
        {
            headline: 'BRICS Payment System Bypassing SWIFT Gains Traction — USD Reserve Status at Risk',
            summary:
                'A multilateral cross-border payment infrastructure settling in local currencies is gaining traction, with long-term implications for dollar hegemony in global trade.',
            tag: 'DXY',
            url: 'https://www.bis.org',
            source: 'BIS',
            publishedAt: 'Latest',
        },
    ],
};

// ═══════════════════════════════════════════════════════════════════
//  NEWS FETCH FUNCTIONS — per tab
//  Each function returns an array of { headline, summary, tag, url, source, publishedAt }
//  or null if all sources fail (caller will use CURATED)
// ═══════════════════════════════════════════════════════════════════

// ── HELPER: normalise article array ──────────────────────────────
function normalise(items) {
    return items.filter((i) => i && (i.headline || i.title) && (i.url || i.link)).slice(0, 7);
}

// ─────────────────────────────────────────────────────────────────
//  BLOCKCHAIN / CRYPTO NEWS
//  Sources: CryptoCompare → NewsAPI → GNews → TheNewsAPI → Dev.to
//           → Hashnode → Reddit → RSS (CoinDesk, CoinTelegraph)
// ─────────────────────────────────────────────────────────────────
async function fetchBlockchain() {
    console.log('\n[Blockchain] Fetching news...');

    // 1. CryptoCompare — free, no key, purpose-built crypto news
    {
        const d = await getJSON(
            'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=Blockchain,Cryptocurrency,Hedera',
            'CryptoCompare',
        );
        if (d?.Data?.length >= 3) {
            return d.Data.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.body, 160),
                tag: tagCrypto(a.title, a.categories),
                url: a.url,
                source: a.source_info?.name || 'CryptoCompare',
                publishedAt: fmtD(a.published_on),
            }));
        }
    }

    // 2. NewsAPI.org
    if (KEY.newsapi) {
        const d = await getJSON(
            `https://newsapi.org/v2/everything?q=blockchain+cryptocurrency+hedera&language=en&sortBy=publishedAt&pageSize=7&apiKey=${KEY.newsapi}`,
            'NewsAPI',
        );
        if (d?.articles?.length >= 3) {
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description || a.content, 160),
                tag: tagCrypto(a.title),
                url: a.url,
                source: a.source?.name || 'NewsAPI',
                publishedAt: fmtD(a.publishedAt),
            }));
        }
    }

    // 3. GNews
    if (KEY.gnews) {
        const d = await getJSON(
            `https://gnews.io/api/v4/search?q=blockchain+crypto&lang=en&max=7&token=${KEY.gnews}`,
            'GNews',
        );
        if (d?.articles?.length >= 3) {
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagCrypto(a.title),
                url: a.url,
                source: a.source?.name || 'GNews',
                publishedAt: fmtD(a.publishedAt),
            }));
        }
    }

    // 4. TheNewsAPI
    if (KEY.thenews) {
        const d = await getJSON(
            `https://api.thenewsapi.com/v1/news/all?api_token=${KEY.thenews}&search=blockchain+cryptocurrency&language=en&sort=published_at&limit=7`,
            'TheNewsAPI',
        );
        if (d?.data?.length >= 3) {
            return d.data.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagCrypto(a.title),
                url: a.url,
                source: a.source || 'TheNewsAPI',
                publishedAt: fmtD(a.published_at),
            }));
        }
    }

    // 5. Dev.to (free, no key — great developer/blockchain content)
    {
        const d = await getJSON('https://dev.to/api/articles?tag=blockchain&per_page=7&top=1', 'Dev.to/blockchain');
        if (d?.length >= 3) {
            return d.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description || `by ${a.user?.name} — ${a.readable_publish_date}`, 160),
                tag: tagCrypto(a.title),
                url: a.canonical_url || a.url,
                source: 'Dev.to',
                publishedAt: fmtD(a.published_at),
            }));
        }
    }

    // 6. Hashnode (GraphQL, free, no key)
    {
        const d = await postJSON('https://gql.hashnode.com', 'Hashnode', {
            query: `{ feed(first:7,filter:{type:FOLLOWING}) { edges { node { title brief url publication { title } updatedAt } } } }`,
        });
        const nodes = d?.data?.feed?.edges?.map((e) => e.node) || [];
        if (nodes.length >= 3) {
            return nodes.map((n) => ({
                headline: ct(n.title, 90),
                summary: ct(n.brief, 160),
                tag: 'Blockchain',
                url: n.url || 'https://hashnode.com',
                source: n.publication?.title || 'Hashnode',
                publishedAt: fmtD(n.updatedAt),
            }));
        }
    }

    // 7. Currents API
    if (KEY.currents) {
        const d = await getJSON(
            `https://api.currentsapi.services/v1/search?keywords=blockchain+cryptocurrency&language=en&apiKey=${KEY.currents}`,
            'Currents',
        );
        if (d?.news?.length >= 3) {
            return d.news.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagCrypto(a.title),
                url: a.url,
                source: a.author || 'Currents',
                publishedAt: fmtD(a.published),
            }));
        }
    }

    // 8. Reddit r/CryptoCurrency (free JSON API)
    {
        const d = await getJSON('https://www.reddit.com/r/CryptoCurrency/hot.json?limit=7', 'Reddit/Crypto');
        const posts = d?.data?.children?.map((c) => c.data) || [];
        if (posts.length >= 3) {
            return posts
                .filter((p) => p.score > 50)
                .slice(0, 7)
                .map((p) => ({
                    headline: ct(p.title, 90),
                    summary: ct(p.selftext || `${p.score} upvotes · r/CryptoCurrency`, 160),
                    tag: tagCrypto(p.title),
                    url: `https://reddit.com${p.permalink}`,
                    source: 'Reddit',
                    publishedAt: fmtD(p.created_utc),
                }));
        }
    }

    // 9. RSS fallbacks
    for (const [url, label] of [
        ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk'],
        ['https://cointelegraph.com/rss', 'CoinTelegraph'],
        ['https://decrypt.co/feed', 'Decrypt'],
        ['https://bitcoinmagazine.com/.rss/full/', 'Bitcoin Magazine'],
        ['https://cryptonews.com/news/feed/', 'CryptoNews'],
        ['https://news.bitcoin.com/feed/', 'Bitcoin.com'],
    ]) {
        const items = await getRSS(url, label);
        if (items.length >= 3)
            return items.slice(0, 7).map((i) => ({
                headline: i.title,
                summary: i.description || 'Latest crypto news.',
                tag: tagCrypto(i.title),
                url: i.url,
                source: i.source,
                publishedAt: fmtD(i.pubDate),
            }));
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────
//  ENERGY NEWS
//  Sources: NewsAPI → GNews → TheNewsAPI → Mediastack → Dev.to
//           → Currents → Reddit → RSS (CleanTechnica, PV Magazine…)
// ─────────────────────────────────────────────────────────────────
async function fetchEnergy() {
    console.log('\n[Energy] Fetching news...');

    if (KEY.newsapi) {
        const d = await getJSON(
            `https://newsapi.org/v2/everything?q=renewable+energy+solar+wind+grid&language=en&sortBy=publishedAt&pageSize=7&apiKey=${KEY.newsapi}`,
            'NewsAPI',
        );
        if (d?.articles?.length >= 3)
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description || a.content, 160),
                tag: tagEnergy(a.title),
                url: a.url,
                source: a.source?.name || 'NewsAPI',
                publishedAt: fmtD(a.publishedAt),
            }));
    }

    if (KEY.gnews) {
        const d = await getJSON(
            `https://gnews.io/api/v4/search?q=renewable+energy+solar&lang=en&max=7&token=${KEY.gnews}`,
            'GNews',
        );
        if (d?.articles?.length >= 3)
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagEnergy(a.title),
                url: a.url,
                source: a.source?.name || 'GNews',
                publishedAt: fmtD(a.publishedAt),
            }));
    }

    if (KEY.thenews) {
        const d = await getJSON(
            `https://api.thenewsapi.com/v1/news/all?api_token=${KEY.thenews}&search=renewable+energy+solar&language=en&sort=published_at&limit=7`,
            'TheNewsAPI',
        );
        if (d?.data?.length >= 3)
            return d.data.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagEnergy(a.title),
                url: a.url,
                source: a.source || 'TheNewsAPI',
                publishedAt: fmtD(a.published_at),
            }));
    }

    // Mediastack (HTTP only on free plan)
    if (KEY.mediastack) {
        const d = await getJSON(
            `http://api.mediastack.com/v1/news?access_key=${KEY.mediastack}&keywords=renewable+energy,solar,wind&languages=en&limit=7`,
            'Mediastack',
        );
        if (d?.data?.length >= 3)
            return d.data.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagEnergy(a.title),
                url: a.url,
                source: a.source || 'Mediastack',
                publishedAt: fmtD(a.published_at),
            }));
    }

    {
        const d = await getJSON(
            'https://dev.to/api/articles?tag=sustainability&per_page=7&top=1',
            'Dev.to/sustainability',
        );
        if (d?.length >= 3)
            return d.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description || `by ${a.user?.name}`, 160),
                tag: tagEnergy(a.title),
                url: a.canonical_url || a.url,
                source: 'Dev.to',
                publishedAt: fmtD(a.published_at),
            }));
    }

    if (KEY.currents) {
        const d = await getJSON(
            `https://api.currentsapi.services/v1/search?keywords=renewable+energy+solar+wind&language=en&apiKey=${KEY.currents}`,
            'Currents',
        );
        if (d?.news?.length >= 3)
            return d.news.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagEnergy(a.title),
                url: a.url,
                source: a.author || 'Currents',
                publishedAt: fmtD(a.published),
            }));
    }

    {
        const d = await getJSON('https://www.reddit.com/r/RenewableEnergy/hot.json?limit=7', 'Reddit/RenewableEnergy');
        const posts = d?.data?.children?.map((c) => c.data) || [];
        if (posts.length >= 3)
            return posts
                .filter((p) => p.score > 10)
                .slice(0, 7)
                .map((p) => ({
                    headline: ct(p.title, 90),
                    summary: ct(p.selftext || `${p.score} upvotes · r/RenewableEnergy`, 160),
                    tag: tagEnergy(p.title),
                    url: `https://reddit.com${p.permalink}`,
                    source: 'Reddit',
                    publishedAt: fmtD(p.created_utc),
                }));
    }

    for (const [url, label] of [
        ['https://cleantechnica.com/feed/', (label = 'CleanTechnica')],
        ['https://www.pv-magazine.com/feed/', (label = 'PV Magazine')],
        ['https://renewablesnow.com/news/feed/', (label = 'Renewables Now')],
        ['https://www.rechargenews.com/rss', (label = 'Recharge News')],
        ['https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', (label = 'BBC Science')],
        ['https://www.theguardian.com/environment/energy/rss', (label = 'Guardian Energy')],
    ]) {
        const all = await getRSS(url, label);
        const filtered = all.filter((i) => {
            const t = (i.title + i.description).toLowerCase();
            return /energy|solar|wind|renewable|grid|batter|climate|carbon|hydrogen/.test(t);
        });
        const use = filtered.length >= 3 ? filtered : all;
        if (use.length >= 3)
            return use.slice(0, 7).map((i) => ({
                headline: i.title,
                summary: i.description || 'Latest energy news.',
                tag: tagEnergy(i.title),
                url: i.url,
                source: i.source,
                publishedAt: fmtD(i.pubDate),
            }));
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────
//  TECH & AI NEWS
//  Sources: NewsAPI → GNews → TheNewsAPI → Dev.to (AI/ML tags)
//           → Hashnode → Reddit r/MachineLearning → RSS
// ─────────────────────────────────────────────────────────────────
async function fetchTech() {
    console.log('\n[Tech] Fetching news...');

    if (KEY.newsapi) {
        const d = await getJSON(
            `https://newsapi.org/v2/everything?q=artificial+intelligence+machine+learning+tech&language=en&sortBy=publishedAt&pageSize=7&apiKey=${KEY.newsapi}`,
            'NewsAPI',
        );
        if (d?.articles?.length >= 3)
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description || a.content, 160),
                tag: tagTech(a.title),
                url: a.url,
                source: a.source?.name || 'NewsAPI',
                publishedAt: fmtD(a.publishedAt),
            }));
    }

    if (KEY.gnews) {
        const d = await getJSON(
            `https://gnews.io/api/v4/search?q=artificial+intelligence+technology&lang=en&max=7&token=${KEY.gnews}`,
            'GNews',
        );
        if (d?.articles?.length >= 3)
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagTech(a.title),
                url: a.url,
                source: a.source?.name || 'GNews',
                publishedAt: fmtD(a.publishedAt),
            }));
    }

    if (KEY.thenews) {
        const d = await getJSON(
            `https://api.thenewsapi.com/v1/news/all?api_token=${KEY.thenews}&search=artificial+intelligence+technology&language=en&sort=published_at&limit=7`,
            'TheNewsAPI',
        );
        if (d?.data?.length >= 3)
            return d.data.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagTech(a.title),
                url: a.url,
                source: a.source || 'TheNewsAPI',
                publishedAt: fmtD(a.published_at),
            }));
    }

    // Dev.to — excellent for AI/tech developer content
    for (const tag of ['ai', 'machinelearning', 'deeplearning', 'technology']) {
        const d = await getJSON(`https://dev.to/api/articles?tag=${tag}&per_page=7&top=1`, `Dev.to/${tag}`);
        if (d?.length >= 3)
            return d.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description || `by ${a.user?.name}`, 160),
                tag: tagTech(a.title),
                url: a.canonical_url || a.url,
                source: 'Dev.to',
                publishedAt: fmtD(a.published_at),
            }));
    }

    if (KEY.currents) {
        const d = await getJSON(
            `https://api.currentsapi.services/v1/latest-news?language=en&category=technology&apiKey=${KEY.currents}`,
            'Currents',
        );
        if (d?.news?.length >= 3)
            return d.news.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagTech(a.title),
                url: a.url,
                source: a.author || 'Currents',
                publishedAt: fmtD(a.published),
            }));
    }

    {
        const d = await getJSON('https://www.reddit.com/r/MachineLearning/hot.json?limit=7', 'Reddit/MachineLearning');
        const posts = d?.data?.children?.map((c) => c.data) || [];
        if (posts.length >= 3)
            return posts.slice(0, 7).map((p) => ({
                headline: ct(p.title, 90),
                summary: ct(p.selftext || `${p.score} upvotes · r/MachineLearning`, 160),
                tag: tagTech(p.title),
                url: `https://reddit.com${p.permalink}`,
                source: 'Reddit',
                publishedAt: fmtD(p.created_utc),
            }));
    }

    for (const [url, label] of [
        ['https://techcrunch.com/feed/', 'TechCrunch'],
        ['https://feeds.arstechnica.com/arstechnica/technology-lab', 'Ars Technica'],
        ['https://www.wired.com/feed/rss', 'Wired'],
        ['https://www.technologyreview.com/feed/', 'MIT Tech Review'],
        ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech'],
        ['https://feeds.feedburner.com/venturebeat/SZYF', 'VentureBeat'],
    ]) {
        const items = await getRSS(url, label);
        if (items.length >= 3)
            return items.slice(0, 7).map((i) => ({
                headline: i.title,
                summary: i.description || 'Latest tech news.',
                tag: tagTech(i.title),
                url: i.url,
                source: i.source,
                publishedAt: fmtD(i.pubDate),
            }));
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────
//  FOREX, GOLD & MARKETS NEWS
//  Sources: NewsAPI → GNews → TheNewsAPI → Mediastack → Currents
//           → CryptoCompare macro → Reddit r/Forex → RSS
//           (FXStreet, ForexFactory, TradingEconomics, Kitco, DailyFX)
// ─────────────────────────────────────────────────────────────────
async function fetchForex() {
    console.log('\n[Forex] Fetching news...');

    if (KEY.newsapi) {
        const d = await getJSON(
            `https://newsapi.org/v2/everything?q=gold+dollar+forex+interest+rate+Fed+inflation&language=en&sortBy=publishedAt&pageSize=7&apiKey=${KEY.newsapi}`,
            'NewsAPI',
        );
        if (d?.articles?.length >= 3)
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description || a.content, 160),
                tag: tagForex(a.title),
                url: a.url,
                source: a.source?.name || 'NewsAPI',
                publishedAt: fmtD(a.publishedAt),
            }));
    }

    if (KEY.gnews) {
        const d = await getJSON(
            `https://gnews.io/api/v4/search?q=gold+forex+dollar+interest+rate&lang=en&max=7&token=${KEY.gnews}`,
            'GNews',
        );
        if (d?.articles?.length >= 3)
            return d.articles.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagForex(a.title),
                url: a.url,
                source: a.source?.name || 'GNews',
                publishedAt: fmtD(a.publishedAt),
            }));
    }

    if (KEY.thenews) {
        const d = await getJSON(
            `https://api.thenewsapi.com/v1/news/all?api_token=${KEY.thenews}&search=forex+gold+dollar+interest+rates&language=en&sort=published_at&limit=7`,
            'TheNewsAPI',
        );
        if (d?.data?.length >= 3)
            return d.data.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagForex(a.title),
                url: a.url,
                source: a.source || 'TheNewsAPI',
                publishedAt: fmtD(a.published_at),
            }));
    }

    if (KEY.mediastack) {
        const d = await getJSON(
            `http://api.mediastack.com/v1/news?access_key=${KEY.mediastack}&keywords=forex,gold,dollar,interest+rates&languages=en&limit=7`,
            'Mediastack',
        );
        if (d?.data?.length >= 3)
            return d.data.map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagForex(a.title),
                url: a.url,
                source: a.source || 'Mediastack',
                publishedAt: fmtD(a.published_at),
            }));
    }

    if (KEY.currents) {
        const d = await getJSON(
            `https://api.currentsapi.services/v1/search?keywords=gold+dollar+forex+interest+rate&language=en&apiKey=${KEY.currents}`,
            'Currents',
        );
        if (d?.news?.length >= 3)
            return d.news.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.description, 160),
                tag: tagForex(a.title),
                url: a.url,
                source: a.author || 'Currents',
                publishedAt: fmtD(a.published),
            }));
    }

    // CryptoCompare macro (free, no key — includes market/macro news)
    {
        const d = await getJSON(
            'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=Market,Trading,Regulation',
            'CryptoCompare-macro',
        );
        if (d?.Data?.length >= 3) {
            const items = d.Data.filter((a) => {
                const t = a.title.toLowerCase();
                return /gold|silver|dollar|fed|rate|inflation|euro|pound|yen|forex|oil|commodity|central bank/.test(t);
            });
            const use = items.length >= 3 ? items : d.Data;
            return use.slice(0, 7).map((a) => ({
                headline: ct(a.title, 90),
                summary: ct(a.body, 160),
                tag: tagForex(a.title),
                url: a.url,
                source: a.source_info?.name || 'CryptoCompare',
                publishedAt: fmtD(a.published_on),
            }));
        }
    }

    // Reddit r/Forex (free)
    {
        const d = await getJSON('https://www.reddit.com/r/Forex/hot.json?limit=7', 'Reddit/Forex');
        const posts = d?.data?.children?.map((c) => c.data) || [];
        if (posts.length >= 3)
            return posts
                .filter((p) => p.score > 5)
                .slice(0, 7)
                .map((p) => ({
                    headline: ct(p.title, 90),
                    summary: ct(p.selftext || `${p.score} upvotes · r/Forex`, 160),
                    tag: tagForex(p.title),
                    url: `https://reddit.com${p.permalink}`,
                    source: 'Reddit r/Forex',
                    publishedAt: fmtD(p.created_utc),
                }));
    }

    // RSS — dedicated forex/markets sources
    for (const [url, label] of [
        // FXStreet — major forex news outlet
        ['https://www.fxstreet.com/feed?type=news', 'FXStreet'],
        // DailyFX — forex analysis
        ['https://www.dailyfx.com/feeds/all', 'DailyFX'],
        // ForexLive
        ['https://www.forexlive.com/feed/news', 'ForexLive'],
        // Kitco — gold/precious metals
        ['https://www.kitco.com/news/rss/gold_news.rss', 'Kitco Gold'],
        // Investing.com forex RSS
        ['https://www.investing.com/rss/news_285.rss', 'Investing.com'],
        // MarketWatch
        ['https://feeds.marketwatch.com/marketwatch/marketpulse/', 'MarketWatch'],
        // Yahoo Finance markets
        ['https://finance.yahoo.com/news/rssindex', 'Yahoo Finance'],
        // Reuters business
        ['https://feeds.reuters.com/reuters/businessNews', 'Reuters'],
    ]) {
        const all = await getRSS(url, label);
        if (all.length === 0) continue;
        const filtered = all.filter((i) => {
            const t = (i.title + i.description).toLowerCase();
            return /gold|silver|dollar|fed|rate|inflation|euro|pound|yen|forex|oil|commodity|central bank|treasury|interest|gdp|cpi/.test(
                t,
            );
        });
        const use = filtered.length >= 3 ? filtered : all;
        if (use.length >= 3)
            return use.slice(0, 7).map((i) => ({
                headline: i.title,
                summary: i.description || 'Latest forex and markets news.',
                tag: tagForex(i.title),
                url: i.url,
                source: i.source,
                publishedAt: fmtD(i.pubDate),
            }));
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════
//  SERVER-SIDE CACHE — 8 minute TTL, background refresh
// ═══════════════════════════════════════════════════════════════════
const CACHE_TTL = 8 * 60 * 1000;
const CACHE = {
    blockchain: { items: null, at: 0 },
    energy: { items: null, at: 0 },
    tech: { items: null, at: 0 },
    forex: { items: null, at: 0 },
};
const FETCHERS = { blockchain: fetchBlockchain, energy: fetchEnergy, tech: fetchTech, forex: fetchForex };
const TABS = ['blockchain', 'energy', 'tech', 'forex'];

async function refreshTab(tab) {
    try {
        const items = await FETCHERS[tab]();
        if (items && items.length > 0) {
            CACHE[tab] = { items, at: Date.now() };
            console.log(`[Cache] ✓ ${tab} — ${items.length} items (${items[0].source})`);
        } else {
            console.log(`[Cache] ✗ ${tab} — all sources empty, serving curated to clients`);
        }
    } catch (e) {
        console.warn(`[Cache] ✗ ${tab} — error: ${e.message}`);
    }
}

async function refreshAll() {
    console.log('\n════════ News Cache Refresh ════════');
    for (let i = 0; i < TABS.length; i++) setTimeout(() => refreshTab(TABS[i]), i * 7000);
}

// ═══════════════════════════════════════════════════════════════════
//  NEWS ENDPOINT
// ═══════════════════════════════════════════════════════════════════
app.get('/api/news', async (req, res) => {
    const tab = req.query.tab || 'blockchain';
    if (!TABS.includes(tab)) return res.status(400).json({ success: false, message: `Unknown tab: ${tab}` });

    const cache = CACHE[tab];
    const now = Date.now();

    if (cache.items && now - cache.at < CACHE_TTL) {
        console.log(
            `[News] ${tab} from cache (${Math.round((now - cache.at) / 1000)}s old, ${cache.items.length} items)`,
        );
        return res.json({ success: true, items: cache.items, source: 'cache' });
    }

    console.log(`[News] ${tab} cache miss — fetching live`);
    try {
        const items = await FETCHERS[tab]();
        if (items && items.length > 0) {
            CACHE[tab] = { items, at: Date.now() };
            return res.json({ success: true, items, source: 'live' });
        }
    } catch (e) {
        console.error(`[News] fetch error: ${e.message}`);
    }

    return res.json({ success: true, items: CURATED[tab], source: 'curated' });
});

// ── Debug endpoint: show cache status and key config ─────────────
app.get('/api/news/status', (req, res) => {
    const now = Date.now();
    res.json({
        keys: Object.fromEntries(Object.entries(KEY).map(([k, v]) => [k, v ? '✓ configured' : '✗ not set'])),
        cache: Object.fromEntries(
            TABS.map((t) => [
                t,
                {
                    hasItems: !!CACHE[t].items,
                    itemCount: CACHE[t].items?.length || 0,
                    ageSeconds: CACHE[t].at ? Math.round((now - CACHE[t].at) / 1000) : null,
                    source: CACHE[t].items?.[0]?.source || null,
                },
            ]),
        ),
    });
});

// ═══════════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════════
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') {
        return res.status(413).json({ success: false, message: 'Request body exceeds the 32 KB limit.' });
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({ success: false, message: 'Request body must be valid JSON.' });
    }
    console.error('[HTTP] Unhandled request error:', error.message);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
});

app.use((_req, res) => res.status(404).json({ success: false, message: 'Not found.' }));

async function start() {
    config = loadConfig();
    app.locals.config = config;
    const startupConfig = config;
    if (!startupConfig.databaseUrl) throw new Error('DATABASE_URL must be configured before starting the backend.');
    await database.migrate();
    await repository.checkDatabase();
    logNewsKeyStatus();
    const server = app.listen(startupConfig.port, () => {
        console.log(`[Startup] EnergySwap API listening on port ${startupConfig.port} (${startupConfig.hederaNetwork}).`);
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 35000;

    const refreshTimer = setInterval(refreshAll, CACHE_TTL);
    const warmupTimer = setTimeout(refreshAll, 6000);
    const shutdown = async (signal) => {
        console.log(`[Shutdown] Received ${signal}; stopping HTTP server and database pool.`);
        clearInterval(refreshTimer);
        clearTimeout(warmupTimer);
        const forceExit = setTimeout(() => {
            console.error('[Shutdown] Graceful shutdown timed out.');
            process.exit(1);
        }, 10000);
        forceExit.unref();
        server.close(async (error) => {
            try {
                await database.closePool();
                clearTimeout(forceExit);
                if (error) {
                    console.error('[Shutdown] HTTP server close failed:', error.message);
                    process.exitCode = 1;
                }
            } catch (closeError) {
                console.error('[Shutdown] Database pool close failed:', closeError.message);
                process.exitCode = 1;
            }
        });
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
    return server;
}

if (require.main === module) {
    start().catch(async (error) => {
        console.error('[Startup] Backend failed to start:', error.message);
        try {
            await database.closePool();
        } catch (closeError) {
            console.error('[Startup] Could not close database pool:', closeError.message);
        }
        process.exitCode = 1;
    });
}

module.exports = { app, start };
