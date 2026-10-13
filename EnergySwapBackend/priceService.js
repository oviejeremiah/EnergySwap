const axios = require('axios');

// ─── Upstream ───────────────────────────────────────────────────────────────
// CoinGecko free tier, no API key. Two endpoints are used:
//
//   /simple/price      many coin ids in ONE request (avoids rate limits)
//   /coins/{id}/market_chart  historical series for the timeframe selector
//
// Granularity limits on the free tier shape what the UI may offer:
//   days=1        -> 5-minute buckets (covers only the last 24h)
//   days=2..90    -> hourly
//   days>90       -> daily
// There is no 1-minute or 15-minute source, so those timeframes are not
// exposed. See TIMEFRAMES below.
const SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';
const MARKET_CHART_URL = 'https://api.coingecko.com/api/v3/coins';

// ─── Supported pairs ────────────────────────────────────────────────────────
const SYMBOLS = {
    'HBAR/USD': { id: 'hedera-hashgraph', label: 'Hedera', asset: 'HBAR', decimals: 5 },
    'BTC/USD': { id: 'bitcoin', label: 'Bitcoin', asset: 'BTC', decimals: 2 },
    'ETH/USD': { id: 'ethereum', label: 'Ethereum', asset: 'ETH', decimals: 2 },
    'SOL/USD': { id: 'solana', label: 'Solana', asset: 'SOL', decimals: 2 },
    // Gold has no CoinGecko listing; PAXG is redeemable 1:1 for physical gold
    // and tracks spot closely, so it is used as the XAU/USD proxy.
    'XAU/USD': { id: 'pax-gold', label: 'Gold', asset: 'XAU', decimals: 2, proxy: 'PAX Gold (PAXG)' },
};

const TIMEFRAMES = {
    '5m': { days: 1, bucketMinutes: 5 },
    '1H': { days: 1, bucketMinutes: 60 },
    '4H': { days: 7, bucketMinutes: 240 },
    '1D': { days: 90, bucketMinutes: 1440 },
};

const CACHE_TTL_MS = 300000; // 5 minutes
const OHLC_TTL_MS = 300000;

// The free CoinGecko tier rate-limits hard and returns 429 under even modest
// serial use. Failures are expected, not exceptional, so requests are spaced
// out and backed off. A failed or exhausted call degrades to the last cached
// series for that pair/timeframe rather than surfacing an error to the client.
const OHLC_MIN_GAP_MS = 2500;
let lastOhlcRequestAt = 0;
let backoffUntil = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function politeGet(url, params) {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (Date.now() < backoffUntil) {
            // Under backoff: only the cache can answer.
            const err = new Error('rate limited');
            err.rateLimited = true;
            throw err;
        }
        const since = Date.now() - lastOhlcRequestAt;
        if (since < OHLC_MIN_GAP_MS) await wait(OHLC_MIN_GAP_MS - since);
        lastOhlcRequestAt = Date.now();
        try {
            return await axios.get(url, { params, timeout: 10000 });
        } catch (error) {
            const status = error?.response?.status;
            if (status === 429) {
                backoffUntil = Date.now() + 60000;
                const err = new Error('rate limited');
                err.rateLimited = true;
                throw err;
            }
            if (attempt === 2) throw error;
        }
    }
}

const isSupported = (symbol) => Object.prototype.hasOwnProperty.call(SYMBOLS, symbol);

/** CoinGecko only accepts a known id list; drop anything we do not map. */
function resolveIds(symbols) {
    const ids = new Set();
    symbols.forEach((s) => {
        if (isSupported(s)) ids.add(SYMBOLS[s].id);
    });
    return Array.from(ids);
}

// ─── Spot price cache ───────────────────────────────────────────────────────
let spotCache = new Map(); // symbol -> { price, change24h, at }
let lastSpotFetch = 0;
let spotFetchInFlight = null;

// Last known HBAR price. Seeded with the previous hard-coded default so that
// settlement has a defined fallback if every upstream call fails.
let lastHbarPrice = 0.08;

const staleFallback = (symbols) => {
    const out = {};
    symbols.forEach((s) => {
        const hit = spotCache.get(s);
        if (hit) out[s] = hit;
    });
    return out;
};

async function fetchSpot(symbols) {
    const ids = resolveIds(symbols);
    if (!ids.length) return {};

    if (spotFetchInFlight) return spotFetchInFlight;

    spotFetchInFlight = (async () => {
        try {
            console.log(`[price] fetching spot for ${ids.join(',')} from CoinGecko`);
            const response = await axios.get(SIMPLE_PRICE_URL, {
                params: { ids: ids.join(','), vs_currencies: 'usd', include_24hr_change: 'true' },
                timeout: 10000,
            });
            const now = Date.now();
            const body = response.data || {};

            ids.forEach((id) => {
                const entry = body[id];
                if (!entry) return;
                const symbol = Object.keys(SYMBOLS).find((s) => SYMBOLS[s].id === id);
                if (!symbol) return;
                const price = Number(entry.usd);
                if (!Number.isFinite(price) || price <= 0) return;
                const change = Number(entry.usd_24h_change);
                spotCache.set(symbol, {
                    price,
                    change24h: Number.isFinite(change) ? change : null,
                    at: now,
                });
                if (symbol === 'HBAR/USD') lastHbarPrice = price;
            });

            lastSpotFetch = now;
            return staleFallback(symbols);
        } catch (error) {
            // Never throw: pricing is display data plus a settlement input, and
            // a transient upstream failure must not take down either path.
            console.error('[price] spot fetch failed, serving last known values:', error.message);
            return staleFallback(symbols);
        } finally {
            spotFetchInFlight = null;
        }
    })();

    return spotFetchInFlight;
}

/**
 * Current USD prices for the requested pairs.
 * Returns `{}` entries keyed by symbol; unknown symbols are simply absent.
 * Never throws.
 */
async function getPrices(symbols) {
    const requested = (Array.isArray(symbols) ? symbols : String(symbols || '').split(','))
        .map((s) => String(s).trim().toUpperCase())
        .filter(Boolean);

    const fresh = Date.now() - lastSpotFetch < CACHE_TTL_MS;
    if (fresh && requested.every((s) => spotCache.has(s))) {
        return staleFallback(requested);
    }
    return fetchSpot(requested);
}

// ─── Historical series ──────────────────────────────────────────────────────
const ohlcCache = new Map(); // `${symbol}:${timeframe}` -> { candles, at }

function aggregate(points, bucketMinutes) {
    const bucketMs = bucketMinutes * 60000;
    const buckets = new Map();

    points.forEach(([ts, price]) => {
        if (!Number.isFinite(price)) return;
        const key = Math.floor(ts / bucketMs) * bucketMs;
        const b = buckets.get(key);
        if (!b) buckets.set(key, { t: key, o: price, h: price, l: price, c: price });
        else {
            b.h = Math.max(b.h, price);
            b.l = Math.min(b.l, price);
            b.c = price;
        }
    });

    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

/**
 * OHLC candles for a pair and timeframe.
 * Timeframes outside TIMEFRAMES are rejected rather than silently faked.
 * Never throws.
 */
async function getOhlc(symbol, timeframe) {
    const sym = String(symbol || '').trim().toUpperCase();
    // Timeframes are case-sensitive: '5m' and '5M' are not the same key, and
    // upper-casing here made the minute-based timeframe unreachable.
    const tf = String(timeframe || '').trim();

    if (!isSupported(sym)) {
        return { success: false, message: `Unsupported symbol: ${symbol}` };
    }
    const spec = TIMEFRAMES[tf];
    if (!spec) {
        return { success: false, message: `Unsupported timeframe: ${timeframe}`, available: Object.keys(TIMEFRAMES) };
    }

    const key = `${sym}:${tf}`;
    const cached = ohlcCache.get(key);
    if (cached && Date.now() - cached.at < OHLC_TTL_MS) {
        return { success: true, symbol: sym, timeframe: tf, candles: cached.candles };
    }

    try {
        const response = await politeGet(`${MARKET_CHART_URL}/${SYMBOLS[sym].id}/market_chart`, {
            vs_currency: 'usd',
            days: spec.days,
        });
        const points = response?.data?.prices || [];
        const candles = aggregate(points, spec.bucketMinutes);
        if (!candles.length) {
            return { success: false, message: 'No historical data returned.' };
        }
        ohlcCache.set(key, { candles, at: Date.now() });
        return { success: true, symbol: sym, timeframe: tf, candles };
    } catch (error) {
        // Serve the last good series when one exists. This keeps a rate limit
        // from blanking a chart the user is already looking at.
        const stale = ohlcCache.get(key);
        if (stale) {
            return { success: true, symbol: sym, timeframe: tf, candles: stale.candles, stale: true };
        }
        if (error?.rateLimited) {
            return {
                success: false,
                rateLimited: true,
                message: 'Market data provider is rate limiting requests. Try again shortly.',
            };
        }
        console.error(`[price] ohlc fetch failed for ${key}:`, error.message);
        return { success: false, message: 'Historical data unavailable.' };
    }
}

/**
 * Live HBAR price in USD.
 *
 * This is an input to trade settlement, so the contract is unchanged: always
 * resolves to a positive number and never throws.
 */
async function getHbarPrice() {
    try {
        const prices = await getPrices(['HBAR/USD']);
        const price = prices['HBAR/USD']?.price;
        if (Number.isFinite(price) && price > 0) {
            lastHbarPrice = price;
            return price;
        }
    } catch (error) {
        // Intentionally swallowed - see getHbarPrice contract above.
    }
    return lastHbarPrice;
}

function listSymbols() {
    return Object.entries(SYMBOLS).map(([symbol, meta]) => ({
        symbol,
        id: meta.id,
        label: meta.label,
        asset: meta.asset,
        decimals: meta.decimals,
        proxy: meta.proxy || null,
    }));
}

function listTimeframes() {
    return Object.entries(TIMEFRAMES).map(([timeframe, spec]) => ({ timeframe, days: spec.days }));
}

module.exports = {
    getHbarPrice,
    getPrices,
    getOhlc,
    listSymbols,
    listTimeframes,
};