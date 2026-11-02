// EnergySwap · main.js
// Web3-native: Wallet Address IS the User Identity

// Loaded on demand — see loadHederaConnector below.
let _hederaModule = null;

/**
 * Import the Hedera connector only when a settlement account is actually wanted.
 *
 * Importing it eagerly is not harmless. The package configures WalletConnect's
 * explorer chain scope to `hedera:testnet` as a side effect of module evaluation.
 * With a static import that ran before any user interaction, the WalletConnect
 * wallet catalogue resolved Hedera wallets only — so the identity modal rendered
 * an empty container, because identity pairs over EVM chains.
 *
 * @returns {Promise<typeof import('@hashgraph/hedera-wallet-connect')>}
 */
const loadHederaConnector = async () => {
    if (!_hederaModule) _hederaModule = await import('@hashgraph/hedera-wallet-connect');
    return _hederaModule;
};
import { Client, Hbar, LedgerId, TransactionId, TransferTransaction } from '@hiero-ledger/sdk';
import 'websocket-polyfill';
import { connectViaWalletConnect, watchSession } from './wallet-connect.js';
import { isHederaAccount as isHederaAccountId, applyTradeGate, applySelectedOfferGate, isWithinOffer } from './trade-gate.js';
import { proveAccountControl, defaultClientFor, resolvePlatformNetwork } from './wallet-signature.js';
import { describeApiError } from './api-error.js';
import { hashPackInstallMessage } from './status-message.js';
import { findAvailableExtension } from './extension-detect.js';

if (typeof window.global === 'undefined') {
    window.global = window;
}
import process from 'process';
if (typeof window.process === 'undefined') {
    window.process = /** @type {any} */ (process);
}
import { Buffer } from 'buffer/';
if (typeof window.Buffer === 'undefined') {
    window.Buffer = /** @type {any} */ (Buffer);
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3000';

// index.html is not processed by Vite, so its inline script cannot read
// import.meta.env. Publish the resolved base for it to pick up. Set at module
// scope so it exists before the inline script's DOMContentLoaded handler runs.
window.__ENERGYSWAP_API_BASE__ = BACKEND_URL;
const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '3bb8070d3c128e28471c850ee21f3978';

const appMetadata = {
    name: 'Hedera P2P EnergySwap',
    description: 'An MSc Project dApp',
    icons: ['https://www.hashpack.app/img/logo.svg'],
    url: window.location.origin,
};

// ────────────────────────── STATE ─────────────────────────────
let dAppConnector = null;
let isInitialized = false;
let connectedAccountId = null;
let selectedRole = null; // 'prosumer' | 'consumer'

// — Identity vs settlement —
// Two deliberately separate things:
//
//   identitySession  Any EVM wallet (extension or phone). Proves who the user
//                    is. Should hold no HBAR — that is the whole point, so a
//                    compromised login wallet yields nothing.
//   connectedAccountId  The Hedera account that actually settles. Needed only
//                    to post an offer or buy energy.
//
// A user may hold only the first, only the second, or both. Neither implies
// the other, and neither is treated as proof of the other.
let identitySession = null;
let stopWatchingIdentity = null;
let offers = [];
let selectedOffer = null;
let hbarPriceUSD = null;
const NETWORK_FEE_ESTIMATE_HBAR = 0.0001;

// ───────────────────────── DOM REFS ───────────────────────────
let accountInfoDiv,
    accountIdSpan,
    consumerView,
    prosumerView,
    offerList,
    offerTemplate,
    tradeInfoDiv,
    hbarInput,
    kwhReceiveInput,
    confirmTradeBtn,
    recentTradesList,
    statusDiv,
    walletBalanceDisplay,
    roleSelectionScreen,
    dashboardScreen,
    roleBadge;

// ────────────────────────── STATUS ────────────────────────────
// `persistent` keeps the box open instead of hiding it after 6 s. Messages
// that contain an action the user must take (e.g. installing HashPack) need
// this: the auto-hide covered only the message, NOT the reason it appeared,
// and a zero-size message that still fills the DOM is worse than none.
const setStatus = (message, isError = false, persistent = false) => {
    [statusDiv, document.getElementById('role-status')].forEach((el) => {
        if (!el) return;
        el.innerHTML = message;
        el.className = `status-box show ${isError ? 'error' : 'success'}`;
        if (persistent) return;
        setTimeout(() => {
            if (el) el.className = 'status-box';
        }, 6000);
    });
};

// ──────────────────────── HBAR PRICE ──────────────────────────
const fetchHbarPrice = async () => {
    try {
        const res = await fetch(`${BACKEND_URL}/api/hbar-price`);
        const data = await res.json();
        if (data.success) {
            hbarPriceUSD = Number(data.priceUSD);
            window.currentHbarPriceUSD = hbarPriceUSD;
            const el = document.getElementById('hbar-price');
            if (el) el.textContent = `$${hbarPriceUSD.toFixed(4)}`;
            const marketRate = document.getElementById('hbar-usd-market-rate');
            if (marketRate) marketRate.textContent = `$${hbarPriceUSD.toFixed(4)}`;
            window.dispatchEvent(new CustomEvent('hbar-price-updated', { detail: { priceUSD: hbarPriceUSD } }));
            updateOfferEstimate();
            updateTradeCard();
            if (selectedOffer) {
                const rate = document.getElementById('tc-rate');
                if (rate)
                    rate.textContent = `${Number(selectedOffer.hbarPerKWh).toFixed(4)} HBAR / kWh ($${(selectedOffer.hbarPerKWh * hbarPriceUSD).toFixed(4)} / kWh)`;
            }
            if (offerList) {
                offerList.querySelectorAll('.offer-item').forEach((item, index) => {
                    const offer = offers[index];
                    const price = item.querySelector('.price');
                    if (offer && price)
                        price.textContent = `${Number(offer.hbarPerKWh).toFixed(4)} HBAR/kWh ($${(offer.hbarPerKWh * hbarPriceUSD).toFixed(4)}/kWh)`;
                });
            }
        }
    } catch (e) {
        console.warn('Could not fetch HBAR price:', e.message);
    }
};

// ──────────────────────── STATS BAR ───────────────────────────
/**
 * Write a value into an element by id.
 *
 * `extraClass` marks the value as an explicit "not available yet" state so it
 * renders muted, rather than showing a bare placeholder glyph that reads like a
 * broken page.
 */
const setEl = (id, val, extraClass) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.classList.toggle('is-empty', Boolean(extraClass));
};

const updateStats = (offersData, tradesData) => {
    setEl('stat-offers', offersData ? offersData.length : 0);
    setEl('stat-trades', tradesData ? tradesData.length : 0);
    if (tradesData && tradesData.length > 0) {
        const totalKwh = tradesData.reduce((s, t) => s + parseFloat(t.energyAmountKWh || 0), 0);
        const totalHbar = tradesData.reduce((s, t) => s + parseFloat(t.totalHbarPaid ?? t.hbarAmount ?? 0), 0);
        setEl('stat-kwh', totalKwh.toFixed(2));
        setEl('stat-hbar', totalHbar.toFixed(2));
    }
};

// ─────────────────────── IDENTITY BAR ─────────────────────────
//
// Shows the two wallets as the separate things they are. The settlement
// address gets a HashScan link because it is a real Hedera account; the
// identity address does not, because an EVM address has nothing on Hedera to
// look up and linking it there would be misleading.

const shortAddress = (value) =>
    typeof value === 'string' && value.length > 12
        ? `${value.slice(0, 6)}…${value.slice(-4)}`
        : value;

const updateIdentityBars = () => {
    const hasHedera = isHederaAccount(connectedAccountId);
    const hasIdentity = Boolean(identitySession?.address);

    // Writes an address field, or an explicit reason when there is nothing to
    // show. A bare placeholder glyph is avoided everywhere: it reads as a
    // rendering fault rather than as "this is intentionally absent", and it
    // leaves the user guessing which of the two wallets is missing.
    const setAddr = (el, value, missingText) => {
        if (!el) return;
        const empty = !value;
        el.textContent = empty ? missingText : value;
        el.classList.toggle('is-empty', empty);
        el.classList.toggle('is-hidden', value === null);
    };

    if (!hasHedera && !hasIdentity) {
        // Signed in with neither wallet: say so rather than leaving stale values.
        for (const id of ['consumer-wallet-display', 'prosumer-wallet-display', 'prosumer-id-display']) {
            setAddr(document.getElementById(id), null, 'Not connected');
        }
        setAddr(document.getElementById('account-id'), null, 'No wallet connected');
        return;
    }

    // Settlement address. Only meaningful once a Hedera account exists; an
    // EVM-only signer has none, and saying which is missing beats a placeholder.
    const settlementText = hasHedera ? connectedAccountId : 'No Hedera account connected';
    setAddr(document.getElementById('consumer-wallet-display'), hasHedera ? connectedAccountId : null, settlementText);
    setAddr(document.getElementById('prosumer-wallet-display'), hasHedera ? connectedAccountId : null, settlementText);
    setAddr(document.getElementById('prosumer-id-display'), hasHedera ? connectedAccountId : null, settlementText);
    setAddr(accountIdSpan, hasHedera ? connectedAccountId : null, settlementText);

    const consumerLink = document.getElementById('consumer-hashscan-link');
    const prosumerLink = document.getElementById('prosumer-hashscan-link');
    if (consumerLink) consumerLink.classList.toggle('is-hidden', !hasHedera);
    if (prosumerLink) prosumerLink.classList.toggle('is-hidden', !hasHedera);
    if (hasHedera) {
        if (consumerLink) consumerLink.href = `https://hashscan.io/testnet/account/${connectedAccountId}`;
        if (prosumerLink) prosumerLink.href = `https://hashscan.io/testnet/account/${connectedAccountId}`;
    }

    const identityAddr = document.getElementById('identity-wallet-display');
    if (identityAddr) identityAddr.textContent = hasIdentity ? identitySession.address : 'Not connected';

    // Header chip: the sign-in wallet sits on its own line beneath the settlement
    // address so both are visible at once and it is obvious they are different
    // wallets. No HashScan link here — an EVM address has no Hedera account.
    const headerIdentity = document.getElementById('identity-account-id');
    const headerIdentityLabel = document.getElementById('identity-wallet-label');
    if (headerIdentity) {
        headerIdentity.textContent = hasIdentity ? identitySession.address : 'Not connected';
        headerIdentity.classList.toggle('is-empty', !hasIdentity);
        headerIdentity.classList.toggle('is-hidden', !hasIdentity);
    }
    if (headerIdentityLabel) {
        headerIdentityLabel.textContent = hasIdentity ? `Sign-in · ${identitySession.name}` : 'Sign-in wallet';
        headerIdentityLabel.classList.toggle('is-hidden', !hasIdentity);
    }

    // Role identity bars: mirror the sign-in wallet under the settlement address
    // so it reads the same way in the card as it does in the header.
    for (const id of ['consumer-signin-display', 'prosumer-signin-display']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.textContent = hasIdentity ? `Sign-in · ${identitySession.address}` : 'Sign-in wallet not connected';
        el.classList.toggle('is-hidden', !hasIdentity);
    }

    const roleLabel = document.getElementById('wallet-role-label');
    if (roleLabel) {
        if (!hasHedera) {
            // Signed in but cannot settle. Say exactly that rather than
            // implying a trading role the wallet cannot use.
            roleLabel.textContent = hasIdentity
                ? 'Browsing only — connect a Hedera account to trade'
                : 'No trading wallet connected';
        } else {
            roleLabel.textContent =
                selectedRole === 'prosumer' ? 'Prosumer' : 'Consumer';
        }
        roleLabel.title = hasIdentity
            ? `Identity: ${identitySession.name} ${shortAddress(identitySession.address)}`
            : '';
    }
};

// ─────────────────────── CHART ENGINE ─────────────────────────
const chartAnimations = {};

function generateCandles(tradesData, days) {
    const buckets = days.map((d) => ({ ...d, candles: [] }));
    tradesData.forEach((trade) => {
        const tradeDate = new Date(trade.timestamp).toLocaleDateString('en-GB');
        const bucket = buckets.find((b) => b.date === tradeDate);
        if (bucket)
            bucket.candles.push({
                kwh: parseFloat(trade.energyAmountKWh || 0),
                hbar: parseFloat(trade.hbarAmount || 0),
                hbarPerKwh: parseFloat(trade.hbarAmount || 0) / Math.max(parseFloat(trade.energyAmountKWh || 1), 0.001),
            });
    });
    return buckets.map((b, i) => {
        if (b.candles.length === 0) {
            const prev = i > 0 ? buckets[i - 1] : null;
            const base = prev?.ohlc?.close || 1.5;
            const drift = (Math.random() - 0.5) * 0.08;
            const open = base,
                close = Math.max(0.01, base + drift);
            return {
                open,
                high: Math.max(open, close) + Math.random() * 0.05,
                low: Math.min(open, close) - Math.random() * 0.05,
                close,
                vol: 0,
                label: b.label,
                hasData: false,
            };
        }
        const prices = b.candles.map((c) => c.hbarPerKwh).filter((p) => p > 0);
        const open = prices[0];
        const close = prices[prices.length - 1];
        const high = Math.max(...prices) * (1 + Math.random() * 0.04);
        const low = Math.min(...prices) * (1 - Math.random() * 0.04);
        const vol = b.candles.reduce((s, c) => s + c.kwh, 0);
        return { open, high, low, close, vol, label: b.label, hasData: true };
    });
}

function drawCandleChart(canvasId, candles, summaryIds) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width || 320;
    const H = rect.height || 120;

    canvas.width = Math.max(1, W * dpr);
    canvas.height = Math.max(1, H * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);

    const PAD_L = 10,
        PAD_R = 48,
        PAD_T = 12,
        PAD_B = 26;
    const CHART_H = (H - PAD_T - PAD_B) * 0.72,
        VOL_H = (H - PAD_T - PAD_B) * 0.2;
    const CHART_Y = PAD_T,
        VOL_Y = CHART_Y + CHART_H + 8;
    const chartW = W - PAD_L - PAD_R;

    const prices = candles.flatMap((c) => [c.high, c.low]).filter(Boolean);
    const minP = prices.length ? Math.min(...prices) * 0.96 : 0.01;
    const maxP = prices.length ? Math.max(...prices) * 1.04 : 0.02;
    const pRange = Math.max(maxP - minP, 0.001);
    const maxVol = Math.max(...candles.map((c) => c.vol), 1);
    const toY = (p) => CHART_Y + CHART_H * (1 - (p - minP) / pRange);
    const cW = Math.max(14, chartW / candles.length);
    const bodyW = Math.max(6, Math.min(18, cW * 0.55));

    ctx.fillStyle = '#06131f';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(148,163,184,0.22)';
    ctx.lineWidth = 1;
    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(148,163,184,0.8)';
    for (let i = 0; i <= 4; i++) {
        const y = CHART_Y + (CHART_H / 4) * i;
        ctx.beginPath();
        ctx.moveTo(PAD_L, y);
        ctx.lineTo(W - PAD_R, y);
        ctx.stroke();
        const label = (maxP - (pRange / 4) * i).toFixed(2);
        ctx.fillText(label, W - PAD_R + 4, y + 3);
    }

    const period = Math.min(9, candles.length);
    const maPoints = candles.map((_, i) => {
        if (i < period - 1) return null;
        return candles.slice(i - period + 1, i + 1).reduce((s, c) => s + (c.close || 0), 0) / period;
    });
    ctx.strokeStyle = 'rgba(250,204,21,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let maS = false;
    maPoints.forEach((val, i) => {
        if (!val) return;
        const x = PAD_L + i * cW + cW / 2,
            y = toY(val);
        if (!maS) {
            ctx.moveTo(x, y);
            maS = true;
        } else ctx.lineTo(x, y);
    });
    ctx.stroke();

    candles.forEach((c, i) => {
        const x = PAD_L + i * cW;
        const xm = x + cW / 2;
        const isUp = (c.close || 0) >= (c.open || 0);
        const bodyColor = c.hasData ? (isUp ? '#22c55e' : '#ef4444') : '#cbd5e1';
        const wickColor = c.hasData ? (isUp ? '#4ade80' : '#f87171') : '#e2e8f0';

        ctx.strokeStyle = wickColor;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(xm, toY(c.high));
        ctx.lineTo(xm, toY(c.low));
        ctx.stroke();

        const openVal = c.open || c.close || 0;
        const closeVal = c.close || c.open || 0;
        const bodyTop = toY(Math.max(openVal, closeVal));
        const bodyBottom = toY(Math.min(openVal, closeVal));
        const bodyHeight = Math.max(4, bodyBottom - bodyTop);

        ctx.fillStyle = bodyColor;
        ctx.fillRect(x + (cW - bodyW) / 2, bodyTop, bodyW, bodyHeight);

        ctx.fillStyle = 'rgba(226,232,240,0.8)';
        ctx.font = c.hasData ? 'bold 8px monospace' : '8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(c.label, xm, H - PAD_B + 14);
        ctx.textAlign = 'left';
    });

    candles.forEach((c, i) => {
        if (!c.vol) return;
        const x = PAD_L + i * cW;
        const isUp = (c.close || 0) >= (c.open || 0);
        const bH = (c.vol / maxVol) * VOL_H;
        ctx.fillStyle = isUp ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.28)';
        ctx.fillRect(x + (cW - bodyW) / 2, VOL_Y + VOL_H - bH, bodyW, bH);
    });

    const lastClose = candles[candles.length - 1].close;
    if (lastClose) {
        const py = toY(lastClose);
        ctx.strokeStyle = 'rgba(34,197,94,0.85)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(PAD_L, py);
        ctx.lineTo(W - PAD_R, py);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#22c55e';
        ctx.fillRect(W - PAD_R + 2, py - 9, PAD_R - 4, 18);
        ctx.fillStyle = '#03110a';
        ctx.font = 'bold 8px monospace';
        ctx.fillText(lastClose.toFixed(2), W - PAD_R + 6, py + 3);
    }

    if (summaryIds) {
        const totalTrades = candles.filter((c) => c.hasData).length;
        const totalKwh = candles.reduce((s, c) => s + (c.vol || 0), 0);
        const totalHbar = candles.reduce((s, c) => s + (c.hasData ? (c.close || 0) * (c.vol || 0) : 0), 0);
        const st = document.getElementById(summaryIds.trades),
            sk = document.getElementById(summaryIds.kwh),
            sh = document.getElementById(summaryIds.hbar);
        if (st) st.textContent = totalTrades;
        if (sk) sk.textContent = totalKwh.toFixed(2);
        if (sh) sh.textContent = totalHbar.toFixed(2);
    }
}

/**
 * True when the OS asks for reduced motion.
 *
 * CSS `@media (prefers-reduced-motion: reduce)` already freezes the stylesheet
 * animations, but it cannot stop JavaScript that redraws a canvas on a timer.
 * Every JS-driven loop must check this itself (WCAG 2.3.3).
 */
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const renderChart = (tradesData) => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push({ label: d.toLocaleDateString('en-GB', { weekday: 'short' }), date: d.toLocaleDateString('en-GB') });
    }
    const candles = generateCandles(tradesData || [], days);
    drawCandleChart('chart-canvas-consumer', candles, {
        trades: 'summary-trades',
        kwh: 'summary-kwh',
        hbar: 'summary-hbar',
    });
    drawCandleChart('chart-canvas-prosumer', candles, {
        trades: 'summary-trades-p',
        kwh: 'summary-kwh-p',
        hbar: 'summary-hbar-p',
    });
    clearInterval(chartAnimations.interval);
    chartAnimations.candles = candles;
    // The random price drift is decorative motion: skip the redraw loop
    // entirely under reduced motion. The chart above still renders once.
    if (prefersReducedMotion()) return;
    chartAnimations.interval = setInterval(() => {
        const last = chartAnimations.candles[chartAnimations.candles.length - 1];
        if (last && last.hasData) {
            const drift = (Math.random() - 0.5) * last.close * 0.01;
            last.close = Math.max(0.001, last.close + drift);
            last.high = Math.max(last.high, last.close);
            last.low = Math.min(last.low, last.close);
        }
        drawCandleChart('chart-canvas-consumer', chartAnimations.candles, null);
        drawCandleChart('chart-canvas-prosumer', chartAnimations.candles, null);
    }, 2000);
};

// ──────────────────────── NAVIGATION ──────────────────────────
const showRoleSelection = () => {
    if (roleSelectionScreen) roleSelectionScreen.classList.remove('hidden');
    if (dashboardScreen) dashboardScreen.classList.add('hidden');
    if (accountInfoDiv) accountInfoDiv.classList.add('hidden');
    selectedRole = null;
    connectedAccountId = null;
};

/**
 * True when the connected address is a canonical Hedera account ID.
 *
 * EnergySwap settles in HBAR, so only Hedera accounts may post or purchase.
 * The API enforces this too (isHederaAccountId in server.js); doing it here
 * lets the UI explain the rule immediately instead of surfacing a raw 400
 * after the user has filled in the whole form.
 *
 * The rule itself lives in trade-gate.js so it can be tested without a browser;
 * this alias keeps every existing call site unchanged.
 */
const isHederaAccount = isHederaAccountId;

/** User-facing explanation shown when a non-Hedera wallet connects. */
const NON_HEDERA_MESSAGE =
    `Your wallet address is not a Hedera account. EnergySwap settles in HBAR on the Hedera network, ` +
    `so you can browse the marketplace but cannot post offers or buy energy yet. ` +
    `Swap your ETH, BTC or other token into HBAR and connect with a Hedera account (for example 0.0.1234) to trade.`;

const showDashboard = () => {
    // Entry requires an identity: either a Hedera account (which settles) or an
    // any-wallet identity session (which does not). An EVM-only user gets in
    // and can browse; the trading forms stay locked until a Hedera account is
    // connected. Bouncing them out here would make the whole marketplace
    // invisible to exactly the users the multichain upgrade is for.
    if (!isHederaAccount(connectedAccountId) && !identitySession) {
        setStatus(NON_HEDERA_MESSAGE, true);
        selectedRole = null;
        showRoleSelection();
        return;
    }

    if (roleSelectionScreen) roleSelectionScreen.classList.add('hidden');
    if (dashboardScreen) dashboardScreen.classList.remove('hidden');

    if (selectedRole === 'prosumer') {
        if (consumerView) consumerView.classList.add('hidden');
        if (prosumerView) prosumerView.classList.remove('hidden');
        if (roleBadge) {
            roleBadge.textContent = 'PROSUMER';
            roleBadge.className = 'role-chip prosumer';
            roleBadge.title = '';
        }
        setTimeout(() => {
            if (typeof initMcCanvas !== 'undefined') initMcCanvas('prosumer');
        }, 100);
    } else if (selectedRole === 'consumer') {
        if (prosumerView) prosumerView.classList.add('hidden');
        if (consumerView) consumerView.classList.remove('hidden');
        if (roleBadge) {
            roleBadge.textContent = 'CONSUMER';
            roleBadge.className = 'role-chip consumer';
            roleBadge.title = '';
        }
        setTimeout(() => {
            if (typeof initMcCanvas !== 'undefined') initMcCanvas('consumer');
        }, 100);
    }

    updateIdentityBars();

    if (accountInfoDiv) accountInfoDiv.classList.remove('hidden');
};

/**
 * Enable or disable the controls that require a Hedera settlement account.
 *
 * Signing in with any wallet grants browsing only. Posting an offer and
 * executing a trade both settle HBAR, so they need a Hedera account. Without
 * this the buttons looked live to a WalletConnect-only user and then failed on
 * click, which reads as a broken app rather than a deliberate rule.
 */
const updateTradeGate = () => {
    return applyTradeGate(
        {
            postButton: document.querySelector('#offer-form button[type="submit"]'),
            tradeButton: confirmTradeBtn,
        },
        { connectedAccountId, selectedOffer },
    );
};

// ──────────────────────── UI UPDATE ───────────────────────────
const updateUI = async () => {
    // Two independent ways to be "in": a Hedera settlement account, or an
    // any-wallet identity. Either is enough to see the marketplace; only the
    // first unlocks trading.
    const canEnter = Boolean(selectedRole) && (Boolean(connectedAccountId) || Boolean(identitySession));

    if (canEnter) {
        showDashboard();

        if (isHederaAccount(connectedAccountId)) {
            setStatus(`Connected as ${selectedRole.toUpperCase()}: ${connectedAccountId}`, false);
        } else {
            setStatus(
                `Signed in as ${selectedRole} with ${identitySession.name} ` +
                    `(${shortAddress(identitySession.address)}). Browsing only — connect a ` +
                    `Hedera account with HBAR to post or buy energy.`,
                false,
            );
        }

        await fetchAndRenderOffers();
        await fetchAndRenderTrades();
        if (selectedRole === 'prosumer') await fetchAndRenderMyOffers();
        updateTradeGate();
    } else {
        showRoleSelection();
        updateStats([], []);
    }
};

// — WALLETCONNECT (DAppConnector) —
let _wcInitPromise = null;

const initializeWalletConnect = async () => {
    if (_wcInitPromise) return _wcInitPromise;

    // WORKAROUND (third-party): @walletconnect/modal injects its overlay as
    // `<div id="wcm-modal" role="alertdialog" aria-modal="true">` with no
    // accessible name, which fails the axe "aria-dialog-name" rule and costs 4
    // Lighthouse accessibility points. The node is created by the library at
    // runtime, so it cannot be labelled in markup. Watch for it and give it a
    // name once it exists. Safe to delete when WalletConnect fixes this
    // upstream — it only sets an ARIA attribute and touches no behaviour.
    const wcmNameObserver = new MutationObserver(() => {
        const modal = document.getElementById('wcm-modal');
        if (modal && !modal.getAttribute('aria-label')) {
            modal.setAttribute('aria-label', 'Hedera wallet connection');
        }
    });
    wcmNameObserver.observe(document.documentElement, { childList: true, subtree: true });

    _wcInitPromise = (async () => {
        if (isInitialized && dAppConnector) return;
        isInitialized = true;
        try {
            const { DAppConnector, HederaJsonRpcMethod, HederaSessionEvent, HederaChainId } =
                await loadHederaConnector();
            dAppConnector = new DAppConnector(
                appMetadata,
                LedgerId.TESTNET,
                WALLETCONNECT_PROJECT_ID,
                Object.values(HederaJsonRpcMethod),
                [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
                [HederaChainId.Testnet],
            );
            await dAppConnector.init({ logger: 'silent' });

            // Listen for wallet-side disconnect
            dAppConnector.walletConnectClient.on('session_delete', () => {
                connectedAccountId = null;
                selectedRole = null;
                showRoleSelection();
                setStatus('Wallet disconnected.', false);
            });

            // Restore existing session if present
            if (dAppConnector.signers.length > 0) {
                connectedAccountId = dAppConnector.signers[0].getAccountId().toString();
            }

            // Only fall back to the role screen if the user has not connected
            // anything yet. Loading the Hedera connector is now asynchronous, so
            // this can land *after* an any-wallet sign-in and would otherwise
            // bounce the user back out of a dashboard they just entered.
            if (!connectedAccountId && !identitySession) {
                showRoleSelection();
            }
        } catch (error) {
            console.error('WalletConnect init error:', error);
            setStatus(`Wallet setup error: ${error.message}`, true);
            isInitialized = false;
            dAppConnector = null;
            _wcInitPromise = null;
            connectedAccountId = null;
            showRoleSelection();
        }
    })();
    return _wcInitPromise;
};

// — ANY-WALLET IDENTITY (extension or phone) —
//
// This is the sign-in path, and it is separate from the Hedera settlement path
// above on purpose. Connecting here proves control of a key; it does not prove
// control of any Hedera account and moves no funds.

/** Message when the user rejects the wallet prompt — not a real failure. */
const isUserRejection = (error) =>
    error && (error.code === 4001 || /rejected|denied|cancell?ed/i.test(error.message || ''));

/**
 * Wire a freshly connected session into the UI.
 *
 * Kept separate from connecting so every transport (WalletConnect today) gets
 * identical session handling: change tracking, disconnect, status text.
 */
const adoptIdentitySession = (session) => {
    identitySession = session;
    // The role is claimed here, on success, rather than before connecting.
    // Connecting is asynchronous, and anything that resets the UI while the
    // attempt is in flight — the lazily loaded Hedera connector calls
    // showRoleSelection() when it finishes — would clear a role set too early
    // and leave the user stranded on the role screen with a live session.
    selectedRole = 'browsing';

    stopWatchingIdentity?.();
    stopWatchingIdentity = watchSession(identitySession, {
        onAccountsChanged: (address) => {
            if (!address) {
                identitySession = null;
                showRoleSelection();
                return;
            }
            identitySession.address = address;
            updateUI();
        },
        onDisconnect: () => {
            identitySession = null;
            showRoleSelection();
            setStatus('Wallet disconnected.', false);
        },
    });

    const short = `${identitySession.address.slice(0, 6)}…${identitySession.address.slice(-4)}`;
    setStatus(
        `Signed in with ${identitySession.name} (${short}). ` +
            `This wallet only identifies you — it never holds your HBAR. ` +
            `Connect a Hedera account to post or buy energy.`,
        false,
    );
    updateUI();
};

/**
 * Sign in with any wallet, via WalletConnect.
 *
 * Both the desktop and the phone entry points come through here. WalletConnect
 * presents the wallet list on desktop (MetaMask, Trust, Coinbase, Rabby…) and
 * a scannable barcode on a phone, so one transport covers every wallet the user
 * might have instead of branching on what happens to be injected in the browser.
 */

/** Tear down the identity session, leaving any Hedera session untouched. */
const disconnectIdentity = async () => {
    stopWatchingIdentity?.();
    stopWatchingIdentity = null;
    try {
        await identitySession?.disconnect();
    } catch (error) {
        console.error('Identity disconnect error:', error);
    }
    identitySession = null;
    updateUI();
};

const connectWithRole = async (role) => {
    if (connectingRole) return;
    connectingRole = true;
    try {
        selectedRole = role;
        // Feedback BEFORE anything slow starts. The first click used to be
        // silent for the whole WalletConnect init (module import + relay
        // handshake), which read as a dead button and pushed users into a
        // second click whose "Connecting..." message then appeared instantly.
        setStatus('Preparing Hedera connection...', false, true);
        await initializeWalletConnect();

        // If already connected from a previous session, just re-render
        if (connectedAccountId) {
            updateUI();
            return;
        }

        let installedExtension = dAppConnector?.extensions.find((extension) => extension.available);
        if (!installedExtension) {
            // The discovery ping is one-shot (200 ms after the connector was
            // constructed) and can lose the race against WalletConnect init
            // when HashPack's MV3 service worker is asleep. Rather than wrongly
            // telling an installed wallet to install itself, poll briefly and
            // keep re-pinging until it announces — or give up honestly.
            setStatus('Looking for a Hedera wallet extension...', false, true);
            const waitStart = performance.now();
            installedExtension = await findAvailableExtension({
                connector: dAppConnector,
                timeoutMs: 4000,
                intervalMs: 400,
            });
            console.info(`[EnergySwap] extension search took ${Math.round(performance.now() - waitStart)} ms); ` +
                `${dAppConnector?.extensions?.length ?? 0} extension(s) seen after it`);
        }
        if (!installedExtension) {
            selectedRole = null;
            setStatus(hashPackInstallMessage(), true, true);
            return;
        }

        setStatus(`Connecting to ${installedExtension.name || 'Hedera wallet'}...`, false);
        try {
            await dAppConnector.connectExtension(installedExtension.id);

            // Use the account returned by the installed wallet extension.
            if (dAppConnector.signers.length > 0) {
                connectedAccountId = dAppConnector.signers[0].getAccountId().toString();
                updateUI();
            } else {
                setStatus('Wallet connection was not completed.', true);
                selectedRole = null;
            }
        } catch (error) {
            setStatus(`Failed to connect wallet: ${error.message}`, true);
            selectedRole = null;
        }
    } finally {
        connectingRole = false;
    }
};

/** Prevents an impatient second click from opening the wallet prompt twice. */
let connectingRole = false;

const disconnectWallet = async () => {
    if (dAppConnector) {
        try {
            await dAppConnector.disconnectAll();
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    }
    connectedAccountId = null;
    selectedRole = null;
    showRoleSelection();
    setStatus('Wallet disconnected. Please select your role to reconnect.', false);
};

// ─────────────────────── FETCH OFFERS ─────────────────────────
const fetchAndRenderOffers = async () => {
    try {
        let response = await fetch(`${BACKEND_URL}/api/offers`);
        let data = await response.json();

        if (!response.ok || !Array.isArray(data.offers)) {
            const fallbackResponse = await fetch(`${BACKEND_URL}/api/all-offers`);
            const fallbackData = await fallbackResponse.json();
            if (!fallbackResponse.ok || !Array.isArray(fallbackData.offers)) {
                throw new Error('No valid offers response received.');
            }
            data = fallbackData;
        }

        offers = (data.offers || [])
            .filter((offer) => offer && offer.status === 'available')
            .sort((a, b) => {
                const timeA = new Date(a.timestamp || 0).getTime();
                const timeB = new Date(b.timestamp || 0).getTime();
                return timeB - timeA;
            });

        updateStats(offers, null);

        if (offerList) {
            offerList.innerHTML = '';
            if (offers.length === 0) {
                offerList.innerHTML = `<li><div class="empty-state"><p>No offers available right now.</p></div></li>`;
                return;
            }
            offers.forEach((offer) => {
                if (offerTemplate) {
                    const clone = document.importNode(offerTemplate.content, true);
                    clone.querySelector('.kwh').textContent = Number(offer.energyAmountKWh).toFixed(2);
                    clone.querySelector('.price').textContent =
                        `${Number(offer.hbarPerKWh).toFixed(4)} HBAR/kWh ($${(offer.hbarPerKWh * (hbarPriceUSD || 0)).toFixed(4)}/kWh)`;
                    clone.querySelector('.prosumer-id').textContent = offer.prosumerId || 'Unknown';

                    const timestamp = offer.timestamp ? new Date(offer.timestamp) : null;
                    const formattedTime = timestamp && !Number.isNaN(timestamp.getTime())
                        ? timestamp.toLocaleString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                          })
                        : 'Unknown';
                    clone.querySelector('.posted-at').textContent = formattedTime;

                    const selectBtn = clone.querySelector('.select-offer-btn');
                    selectBtn.dataset.offerId = offer.id.toString();
                    if (offer.prosumerId === connectedAccountId) {
                        selectBtn.disabled = true;
                        selectBtn.textContent = 'Your Offer';
                    }
                    offerList.appendChild(clone);
                }
            });
        }
    } catch (error) {
        setStatus(`Could not load offers: ${error.message}`, true);
    }
};

// ──────────────── FETCH MY OFFERS (PROSUMER) ──────────────────
const fetchAndRenderMyOffers = async () => {
    const myOfferList = document.getElementById('my-offer-list');
    if (!myOfferList || !connectedAccountId) return;
    try {
        const response = await fetch(`${BACKEND_URL}/api/all-offers`);
        if (!response.ok) throw new Error(`Network error: ${response.statusText}`);
        const data = await response.json();
        const myOffers = (data.offers || []).filter((o) => o.prosumerId === connectedAccountId);

        myOfferList.innerHTML = '';
        if (myOffers.length === 0) {
            myOfferList.innerHTML = `<li><div class="empty-state"><p>You have not posted any offers yet.</p></div></li>`;
            return;
        }
        [...myOffers].reverse().forEach((offer) => {
            const li = document.createElement('li');
            const date = new Date(offer.timestamp).toLocaleString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
            const isAvailable = offer.status === 'available';
            li.innerHTML = `
                <div class="my-offer ${offer.status}">
                    <div>
                        <div class="my-offer-kwh ${offer.status}">${Number(offer.energyAmountKWh).toFixed(2)} kWh</div>
                        <div class="my-offer-meta">${offer.hbarPerKWh} HBAR/kWh &mdash; Total: ${offer.totalHbar}——</div>
                        <div class="my-offer-date">Posted: ${date}</div>
                    </div>
                    <span class="status-pill ${offer.status}">${isAvailable ? 'Available' : 'Sold'}</span>
                </div>`;
            myOfferList.appendChild(li);
        });
    } catch (error) {
        console.error('Could not fetch my offers:', error);
        if (myOfferList)
            myOfferList.innerHTML = `<li><div class="empty-state"><p>Could not load your offers.</p></div></li>`;
    }
};

// ─────────────────────── FETCH TRADES ─────────────────────────
const fetchAndRenderTrades = async () => {
    try {
        const response = await fetch(`${BACKEND_URL}/api/trades`);
        if (!response.ok) throw new Error(`Network error: ${response.statusText}`);
        const data = await response.json();
        const trades = data.trades || [];
        updateStats(offers, trades);
        renderChart(trades);

        if (recentTradesList) {
            recentTradesList.innerHTML = '';
            if (trades.length === 0) {
                recentTradesList.innerHTML = `<li><div class="empty-state"><p>No trades yet.</p></div></li>`;
                return;
            }
            [...trades].reverse().forEach((trade) => {
                const li = document.createElement('li');
                li.innerHTML = `
                    <div class="trade-item">
                        <span class="trade-badge">Completed</span>
                        <div class="trade-detail">
                            <strong>${trade.energyAmountKWh} kWh</strong> traded; seller received
                            <strong>${trade.hbarAmount} HBAR</strong>; consumer paid
                            <strong>${trade.totalHbarPaid ?? trade.hbarAmount} HBAR</strong> including ${trade.gasFeeHbar || 0} HBAR network fee
                        </div>
                        <a class="trade-link" href="https://hashscan.io/testnet/account/${trade.buyerId}" target="_blank">View on HashScan</a>
                    </div>`;
                recentTradesList.appendChild(li);
            });
        }
    } catch (error) {
        console.error('Could not fetch trades:', error);
    }
};

// ───────────────────── TRADE CARD LOGIC ───────────────────────
const updateTradeCard = () => {
    const kwh = parseFloat(kwhReceiveInput?.value) || 0;
    if (!selectedOffer || kwh <= 0) {
        if (hbarInput) hbarInput.value = '';
        const totalEl = document.getElementById('tc-total');
        if (totalEl) {
            totalEl.textContent = 'Select an offer';
            totalEl.classList.add('is-empty');
        }
        return;
    }
    const hbar = kwh * selectedOffer.hbarPerKWh;
    const estimatedTotal = hbar + NETWORK_FEE_ESTIMATE_HBAR;
    if (hbarInput) hbarInput.value = estimatedTotal.toFixed(8);
    const totalEl = document.getElementById('tc-total');
    if (totalEl)
        totalEl.textContent = `${estimatedTotal.toFixed(8)} HBAR estimated, including ~${NETWORK_FEE_ESTIMATE_HBAR.toFixed(4)} HBAR network fee ($${(estimatedTotal * (hbarPriceUSD || 0)).toFixed(4)})`;
};

const selectOffer = (offerId) => {
    selectedOffer = offers.find((o) => o.id.toString() === offerId.toString());
    if (!selectedOffer) return;

    document.querySelectorAll('.offer-item').forEach((item) => item.classList.remove('selected'));
    const btn = offerList?.querySelector(`button[data-offer-id="${offerId}"]`);
    if (btn) btn.closest('.offer-item')?.classList.add('selected');

    if (confirmTradeBtn) {
        // Respect the settlement gate: selecting an offer must not re-enable a
        // button that cannot work without a Hedera account.
        applySelectedOfferGate({ tradeButton: confirmTradeBtn }, { connectedAccountId });
    }

    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    setEl('tc-offer-id', `#${selectedOffer.id}`);
    setEl(
        'tc-rate',
        `${Number(selectedOffer.hbarPerKWh).toFixed(4)} HBAR / kWh ($${(selectedOffer.hbarPerKWh * (hbarPriceUSD || 0)).toFixed(4)} / kWh)`,
    );
    setEl(
        'tc-prosumer',
        selectedOffer ? selectedOffer.prosumerId : 'No offer selected',
        selectedOffer ? '' : 'is-empty',
    );
    setEl('tc-available', `${selectedOffer.energyAmountKWh} kWh`);
    setEl('tc-total', 'Enter an amount', 'is-empty');

    if (kwhReceiveInput) {
        kwhReceiveInput.max = selectedOffer.energyAmountKWh;
        kwhReceiveInput.value = '';
    }
    if (hbarInput) hbarInput.value = '';

    if (tradeInfoDiv)
        tradeInfoDiv.textContent = `Trading with ${selectedOffer.prosumerId} at ${selectedOffer.hbarPerKWh} HBAR/kWh.`;
    updateTradeCard();
};

// ────────────────────── EXECUTE TRADE ─────────────────────────
const executeTrade = async () => {
    const energyAmountKWh = parseFloat(kwhReceiveInput?.value);
    if (!isWithinOffer(energyAmountKWh, selectedOffer)) {
        setStatus('Please select an offer and enter a kWh amount within the available energy.', true);
        return;
    }
    if (!isHederaAccount(connectedAccountId)) {
        setStatus(
            'Trading settles in HBAR on Hedera, so it needs a Hedera account. ' +
                'Connect one from the role screen to post an offer or buy energy.',
            true,
        );
        return;
    }
    if (confirmTradeBtn) {
        confirmTradeBtn.disabled = true;
        confirmTradeBtn.textContent = 'Processing...';
    }
    setStatus('Review and sign the HBAR transfer in your wallet. Your account pays the network fee.', false);

    // Built for the network the platform is actually on, not a hardcoded one.
    // Testnet today; mainnet after migration, with no change here.
    const client = defaultClientFor(await resolvePlatformNetwork({ baseUrl: BACKEND_URL }));
    let confirmedTransactionId = null;
    try {
        const signer = dAppConnector?.signers.find((item) => item.getAccountId().toString() === connectedAccountId);
        if (!signer) throw new Error('The connected consumer wallet signer is unavailable.');

        const sellerHbar = Number((energyAmountKWh * selectedOffer.hbarPerKWh).toFixed(8));
        const transaction = new TransferTransaction()
            .addHbarTransfer(connectedAccountId, new Hbar(-sellerHbar))
            .addHbarTransfer(selectedOffer.prosumerId, new Hbar(sellerHbar))
            .setTransactionId(TransactionId.generate(connectedAccountId))
            .setTransactionMemo(`EnergySwap ${selectedOffer.id}`);
        const signedTransaction = await signer.signTransaction(transaction);
        const transactionResponse = await signedTransaction.execute(client);
        const receipt = await transactionResponse.getReceipt(client);
        if (receipt.status.toString() !== 'SUCCESS')
            throw new Error(`Hedera transaction failed: ${receipt.status.toString()}`);
        confirmedTransactionId = transactionResponse.transactionId.toString();

        const response = await fetch(`${BACKEND_URL}/api/record-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                offerId: selectedOffer.id,
                energyAmountKWh,
                consumerAccountId: connectedAccountId,
                transactionId: confirmedTransactionId,
            }),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(err.error || err.message || 'Trade failed.');
        }
        const result = await response.json();
        setStatus(
            `Bought ${result.kwhTraded} kWh. Seller received ${result.hbarPaid} HBAR; total charged ${result.totalHbarPaid} HBAR including ${result.gasFeeHbar} HBAR network fee ($${result.gasFeeUSD}).`,
            false,
        );
        selectedOffer = null;
        if (hbarInput) hbarInput.value = '';
        if (kwhReceiveInput) kwhReceiveInput.value = '';
        if (tradeInfoDiv) tradeInfoDiv.textContent = 'Select an offer to begin.';
        await fetchAndRenderOffers();
        await fetchAndRenderTrades();
    } catch (error) {
        if (confirmedTransactionId) {
            selectedOffer = null;
            if (hbarInput) hbarInput.value = '';
            if (kwhReceiveInput) kwhReceiveInput.value = '';
            setStatus(
                `HBAR payment confirmed, but trade recording failed. Do not pay again. Transaction: ${confirmedTransactionId}. ${error.message}`,
                true,
            );
        } else {
            setStatus(`Trade Failed: ${error.message}`, true);
        }
    } finally {
        client.close();
        if (confirmTradeBtn) {
            confirmTradeBtn.disabled = true;
            confirmTradeBtn.textContent = 'Select an Offer';
        }
    }
};

// ─────────────────────── NEWS SIDEBAR ─────────────────────────
let currentNewsTab = 'blockchain';
let newsCache = { blockchain: null, energy: null, tech: null, forex: null };

const NEWS_FALLBACK = {
    blockchain: [
        {
            headline: 'Hedera Hashgraph Hits 10 Billion Transactions — Fastest Public DLT',
            summary:
                'Hedera demonstrates enterprise-grade throughput with near-zero fees, cementing its position as the leading platform for tokenised assets and P2P energy trading.',
            tag: 'Hedera',
            url: 'https://hedera.com',
            source: 'Hedera',
            publishedAt: 'Latest',
        },
        {
            headline: 'Bitcoin ETFs Attract Record $2bn Weekly Inflow From Institutional Buyers',
            summary:
                'Spot Bitcoin ETF products continue to see massive institutional demand, with total AUM across all products crossing $60bn as mainstream adoption accelerates.',
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
                'Decentralised finance protocols are seeing record capital inflows from institutional players, with tokenised bonds and energy credits driving the next growth wave.',
            tag: 'DeFi',
            url: 'https://defillama.com',
            source: 'DefiLlama',
            publishedAt: 'Latest',
        },
        {
            headline: 'Ripple Wins SEC Case — XRP Classified as Non-Security in Secondary Markets',
            summary:
                'The landmark ruling provides regulatory clarity for dozens of altcoins and opens the door for XRP ETF applications.',
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
                'Solar installation costs have dropped 89% over the past decade, making it the cheapest electricity source in history.',
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
                'Grid-scale lithium-ion battery storage has become economically viable for most markets, solving the intermittency problem.',
            tag: 'Storage',
            url: 'https://www.irena.org',
            source: 'IRENA',
            publishedAt: 'Latest',
        },
        {
            headline: 'Hedera Carbon Credit Tokenisation Project Goes Live With 50 Energy Firms',
            summary:
                'Blockchain platforms including Hedera are issuing verifiable carbon credits tied directly to renewable energy generation.',
            tag: 'Blockchain',
            url: 'https://hedera.com',
            source: 'Hedera',
            publishedAt: 'Latest',
        },
        {
            headline: 'Smart Grid AI Reduces Energy Waste by 30% in Amsterdam, Seoul and Singapore',
            summary:
                'AI-driven smart grid systems dynamically balancing supply and demand are showing dramatic efficiency improvements.',
            tag: 'SmartGrid',
            url: 'https://www.energy.gov',
            source: 'Dept. of Energy',
            publishedAt: 'Latest',
        },
    ],
    tech: [
        {
            headline: 'AI Data Centre Power Demand to Rival Aviation Industry by 2030 — IEA Warns',
            summary:
                'Data centres powering large language models are projected to consume 4% of global electricity by 2030, making clean energy critical.',
            tag: 'AI+Energy',
            url: 'https://www.iea.org',
            source: 'IEA',
            publishedAt: 'Latest',
        },
        {
            headline: 'Google DeepMind AI Predicts Electricity Grid Demand 36 Hours Ahead With 95% Accuracy',
            summary:
                'A neural forecasting model reduces grid balancing costs by 13% by accurately predicting renewable supply and consumer demand.',
            tag: 'AI',
            url: 'https://deepmind.google',
            source: 'DeepMind',
            publishedAt: 'Latest',
        },
        {
            headline: 'EU AI Act Now Enforced — Fintech and Energy Trading Platforms Must Comply',
            summary:
                'The worlds first comprehensive AI regulation classifies algorithmic trading and energy pricing as high-risk, requiring human oversight.',
            tag: 'Regulation',
            url: 'https://digital-strategy.ec.europa.eu',
            source: 'EU Commission',
            publishedAt: 'Latest',
        },
        {
            headline: 'Smart Meters and IoT Enable Automatic Energy Arbitrage for Households',
            summary:
                'Home automation systems connecting with P2P energy platforms now automatically buy cheap off-peak electricity and sell solar surplus.',
            tag: 'IoT',
            url: 'https://www.smartenergy.com',
            source: 'SmartEnergy',
            publishedAt: 'Latest',
        },
    ],
    forex: [
        {
            headline: 'Federal Reserve Holds Rates Steady — Dollar Index Retreats From 3-Month High',
            summary:
                'The Fed signalled caution on rate cuts amid sticky inflation, causing DXY to pull back as traders repriced expectations.',
            tag: 'USD',
            url: 'https://www.federalreserve.gov',
            source: 'Federal Reserve',
            publishedAt: 'Latest',
        },
        {
            headline: 'Gold Breaks All-Time High Above $3,100/oz as Central Bank Buying Accelerates',
            summary:
                'Spot gold surged to record levels driven by geopolitical uncertainty, central bank accumulation, and falling real yields.',
            tag: 'Gold',
            url: 'https://www.gold.org',
            source: 'World Gold Council',
            publishedAt: 'Latest',
        },
        {
            headline: 'Bank of England Cuts Base Rate as UK Inflation Falls to 2.3% — GBP Reacts',
            summary:
                'The MPC voted to cut rates, providing relief to UK mortgage holders. GBP/USD fell initially before recovering.',
            tag: 'GBP',
            url: 'https://www.bankofengland.co.uk',
            source: 'Bank of England',
            publishedAt: 'Latest',
        },
        {
            headline: 'Silver Surges 18% YTD — Solar Panel Demand Creates Structural Supply Deficit',
            summary: 'Silver is outperforming gold as industrial demand from solar panel manufacturing accelerates.',
            tag: 'Silver',
            url: 'https://www.silverinstitute.org',
            source: 'Silver Institute',
            publishedAt: 'Latest',
        },
    ],
};

const TAB_COLORS = { blockchain: '#39ff7e', energy: '#34d399', tech: '#60a5fa', forex: '#fbbf24' };
const TAB_LABELS = {
    blockchain: 'Blockchain & Crypto',
    energy: 'Renewable Energy',
    tech: 'Tech & AI',
    forex: 'Forex & Metals',
};

const renderNewsItems = (items, tab) => {
    const feed = document.getElementById('news-feed');
    if (!feed || !items?.length) return;
    const c = TAB_COLORS[tab] || '#39ff7e';
    const lbl = TAB_LABELS[tab] || 'News';
    feed.innerHTML = items
        .map(
            (item) => `
        <a class="news-item" href="${item.url || '#'}" target="_blank" rel="noopener noreferrer">
            <div class="news-cat" style="color:${c}">${lbl}</div>
            <div class="news-headline">${item.headline}</div>
            <div class="news-summary">${item.summary}</div>
            <div class="news-foot">
                <span class="news-tag" style="background:${c}15;color:${c};border-color:${c}35">#${item.tag}</span>
                <span class="news-meta">${item.source || ''}, ${item.publishedAt || 'Latest'}</span>
            </div>
        </a>`,
        )
        .join('');
};

const fetchNews = async (tab) => {
    const feed = document.getElementById('news-feed');
    const btn = document.getElementById('news-refresh-btn');
    if (!feed) return;

    renderNewsItems(NEWS_FALLBACK[tab] || NEWS_FALLBACK.blockchain, tab);
    if (btn) btn.classList.add('spinning');

    try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(`${BACKEND_URL}/api/news?tab=${tab}`, { signal: ctrl.signal });
        clearTimeout(tid);
        if (res.ok) {
            const data = await res.json();
            if (data?.success && Array.isArray(data.items) && data.items.length > 0) {
                newsCache[tab] = data.items;
                renderNewsItems(data.items, tab);
            }
        }
    } catch (_) {
        /* Silent — curated content already showing */
    } finally {
        if (btn) btn.classList.remove('spinning');
    }
};

const initNewsSidebar = () => {
    const tabs = Array.from(document.querySelectorAll('.news-tab'));
    tabs.forEach((tab, index) => {
        // Roving tabindex: the tablist behaves as one stop in the tab order,
        // then Left/Right arrows move between tabs (WAI-ARIA tabs pattern).
        tab.tabIndex = tab.classList.contains('active') ? 0 : -1;
        tab.addEventListener('click', () => selectNewsTab(index));
        tab.addEventListener('keydown', (event) => {
            const keys = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
            if (!(event.key in keys)) return;
            event.preventDefault();
            const move = keys[event.key];
            let next;
            if (move === 'first') next = 0;
            else if (move === 'last') next = tabs.length - 1;
            else next = (index + move + tabs.length) % tabs.length;
            selectNewsTab(next);
            tabs[next].focus();
        });
    });

    function selectNewsTab(index) {
        tabs.forEach((t, i) => {
            const isActive = i === index;
            t.classList.toggle('active', isActive);
            t.setAttribute('aria-selected', isActive ? 'true' : 'false');
            t.tabIndex = isActive ? 0 : -1;
        });
        currentNewsTab = tabs[index].dataset.tab;
        newsCache[currentNewsTab] ? renderNewsItems(newsCache[currentNewsTab], currentNewsTab) : fetchNews(currentNewsTab);
    }

    const btn = document.getElementById('news-refresh-btn');
    if (btn)
        btn.addEventListener('click', () => {
            newsCache[currentNewsTab] = null;
            fetchNews(currentNewsTab);
        });
    fetchNews('blockchain');
    // Auto-refresh every 5 minutes
    setInterval(() => {
        newsCache = { blockchain: null, energy: null, tech: null, forex: null };
        ['blockchain', 'energy', 'tech', 'forex'].forEach((tab, i) => {
            setTimeout(() => fetchNews(tab), i * 8000);
        });
    }, 300000);
};

// ──────────────────────── DOM READY ───────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    accountInfoDiv = document.getElementById('account-info');
    accountIdSpan = document.getElementById('account-id');
    walletBalanceDisplay = document.getElementById('wallet-balance-display');
    consumerView = document.getElementById('consumer-view');
    prosumerView = document.getElementById('prosumer-view');
    offerList = document.getElementById('offer-list');
    offerTemplate = document.getElementById('offer-template');
    tradeInfoDiv = document.getElementById('trade-info');
    hbarInput = document.getElementById('hbar-input');
    kwhReceiveInput = document.getElementById('kwh-receive-input');
    confirmTradeBtn = document.getElementById('confirm-trade-btn');
    recentTradesList = document.getElementById('recent-trades-list');
    statusDiv = document.getElementById('status');
    roleSelectionScreen = document.getElementById('role-selection-screen');
    dashboardScreen = document.getElementById('dashboard-screen');
    roleBadge = document.getElementById('role-badge');

    // Role selection
    const btnP = document.getElementById('btn-connect-prosumer');
    const btnC = document.getElementById('btn-connect-consumer');
    const btnD = document.getElementById('disconnect-btn');
    if (btnP) btnP.addEventListener('click', () => connectWithRole('prosumer'));
    if (btnC) btnC.addEventListener('click', () => connectWithRole('consumer'));

    // Any-wallet sign-in. Extensions get their own button so the user can pick
    // deliberately when several are installed; the phone path always goes
    // through WalletConnect.
    const btnAnyExt = document.getElementById('btn-connect-wallet');
    const btnAnyOff = document.getElementById('btn-disconnect-identity');

    // One entry point for every wallet. The WalletConnect modal owns the wallet
    // list, the barcode and the deep links, so there is no desktop/phone split
    // left for the user to reason about.
    if (btnAnyExt) {
        btnAnyExt.addEventListener('click', async () => {
            setStatus('Opening WalletConnect — choose a wallet to sign in with.', false);
            try {
                adoptIdentitySession(await connectViaWalletConnect());
            } catch (error) {
                identitySession = null;
                // Dismissing the modal is a normal outcome, not a failure, so it
                // must not be dressed up as an error.
                setStatus(
                    isUserRejection(error) ? 'Wallet connection cancelled.' : `Could not connect wallet: ${error.message}`,
                    !isUserRejection(error),
                );
            }
        });
    }

    if (btnAnyOff) btnAnyOff.addEventListener('click', disconnectIdentity);
    if (btnD) btnD.addEventListener('click', disconnectWallet);

    // Offer list delegation
    if (offerList) {
        offerList.addEventListener('click', (e) => {
            if (e.target?.matches('.select-offer-btn')) {
                const id = e.target.dataset.offerId;
                if (id) selectOffer(id);
            }
        });
    }

    if (kwhReceiveInput) kwhReceiveInput.addEventListener('input', updateTradeCard);
    if (confirmTradeBtn) confirmTradeBtn.addEventListener('click', executeTrade);

    // Offer form
    const offerForm = document.getElementById('offer-form');
    if (offerForm) {
        offerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = offerForm.querySelector("button[type='submit']");
            if (submitBtn) submitBtn.disabled = true;
            if (!connectedAccountId) {
                setStatus('Please connect your wallet before creating an offer.', true);
                if (submitBtn) submitBtn.disabled = false;
                return;
            }
            const kwhSellInput = document.getElementById('kwh-sell-input');
            const hbarPerKwhInput = document.getElementById('hbar-per-kwh-input');
            const energyVal = parseFloat(kwhSellInput?.value);
            const hbarPerVal = parseFloat(hbarPerKwhInput?.value);

            if (!energyVal || energyVal <= 0) {
                setStatus('Please enter a valid energy amount (kWh) greater than 0.', true);
                if (submitBtn) submitBtn.disabled = false;
                return;
            }
            if (!hbarPerVal || hbarPerVal <= 0) {
                setStatus('Please enter a valid price (HBAR per kWh) greater than 0.', true);
                if (submitBtn) submitBtn.disabled = false;
                return;
            }

            setStatus('Submitting your offer to Hedera...', false);
            try {
                const response = await fetch(`${BACKEND_URL}/api/post-offer`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prosumerId: connectedAccountId,
                        energyAmountKWh: energyVal,
                        hbarPerKWh: hbarPerVal,
                        // Proof that the caller controls the Hedera account it is
                        // claiming as the producer. Without this, anyone can post
                        // an offer naming any account as the seller.
                        //
                        // Proven by a transaction the account signs and pays for,
                        // carrying a server-issued nonce, which the server reads
                        // back from the network. No private key is handled here,
                        // and the flow is identical on testnet and mainnet.
                        ...(await proveAccountControl({
                            accountId: connectedAccountId,
                            signer: dAppConnector?.signers.find(
                                (item) => item.getAccountId().toString() === connectedAccountId,
                            ),
                            baseUrl: BACKEND_URL,
                        })),
                    }),
                });
                if (!response.ok) throw new Error(await describeApiError(response, 'Failed to post offer'));
                const data = await response.json();
                if (!data.success) throw new Error(data.message);
                setStatus('Offer posted successfully on Hedera.', false);
                offerForm.reset();
                document.getElementById('oc-total-val').textContent = '— HBAR';
                const usdEl = document.getElementById('oc-usd-val');
                usdEl.textContent = 'Awaiting quote';
                usdEl.classList.add('is-empty');
                await fetchAndRenderOffers();
                await fetchAndRenderMyOffers();
            } catch (error) {
                // Kept ON SCREEN (persistent) and logged with the cause chain:
                // this error hides itself after 6 s otherwise, and a user whose
                // wallet paid for a transaction that then failed to record has
                // no evidence of what went wrong left to report.
                console.error('[EnergySwap] offer submission failed:', error, {
                    cause: error?.cause ?? null,
                    accountId: connectedAccountId,
                });
                setStatus(error.message, true, true);
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    // Live estimate calculator for post-offer form
    const kwhSell = document.getElementById('kwh-sell-input');
    const hbarPKwh = document.getElementById('hbar-per-kwh-input');
    if (kwhSell) kwhSell.addEventListener('input', updateOfferEstimate);
    if (hbarPKwh) hbarPKwh.addEventListener('input', updateOfferEstimate);

    // Energy type buttons
    document.querySelectorAll('.oc-type-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.oc-type-btn').forEach((button) => button.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // HBAR price fetch
    fetchHbarPrice();
    setInterval(fetchHbarPrice, 300000);

    // Initialise
    //
    // The Hedera connector is deliberately NOT initialised here. It
    // initialises WalletConnect Core, which is a module-level singleton, and the
    // identity layer needs that same singleton. Initialising both leaves the
    // WalletConnect modal mounted but unable to render its wallet list.
    // connectWithRole() initialises it on demand, when a settlement account is
    // actually wanted.
    initNewsSidebar();
    // Apply the settlement gate on first paint too, so the trading controls are
    // never briefly interactive before a wallet state is known.
    updateTradeGate();
});

function updateOfferEstimate() {
    const kwh = parseFloat(document.getElementById('kwh-sell-input')?.value) || 0;
    const rate = parseFloat(document.getElementById('hbar-per-kwh-input')?.value) || 0;
    const total = kwh * rate;
    const hbarPrice = hbarPriceUSD || 0;
    const totalEl = document.getElementById('oc-total-val');
    const usdEl = document.getElementById('oc-usd-val');
    const usdRateEl = document.getElementById('oc-rate-usd-val');
    if (totalEl) totalEl.textContent = total > 0 ? `${total.toFixed(4)} HBAR` : '— HBAR';
    if (usdEl) {
        const known = total > 0 && hbarPrice > 0;
        usdEl.textContent = known ? `${(total * hbarPrice).toFixed(4)} USD` : 'Awaiting quote';
        usdEl.classList.toggle('is-empty', !known);
    }
    if (usdRateEl) {
        const known = rate > 0 && hbarPrice > 0;
        usdRateEl.textContent = known ? `${(rate * hbarPrice).toFixed(4)} / kWh` : 'Awaiting quote';
        usdRateEl.classList.toggle('is-empty', !known);
    }
}

