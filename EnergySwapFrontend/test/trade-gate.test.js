import { describe, it, expect, beforeEach } from 'vitest';
import {
    isHederaAccount,
    canSettle,
    gateState,
    applyTradeGate,
    applySelectedOfferGate,
    isWithinOffer,
} from '../src/trade-gate.js';

// ─────────────────────────────────────────────────────────────────────────────
// updateTradeGate and selectOffer.
//
// This is the logic that gates trading, and it has already regressed once:
// selecting an offer re-enabled a button that could not work without a Hedera
// settlement account. The user saw a live "Execute Trade" button, clicked it,
// and got an error instead - the UI was promising something the app could not do.
//
// The app had no test setup at all when these were written, so these cases were
// unproven. Each one is paired: the same call with a Hedera account must behave
// differently, so a gate that refuses everything still fails the suite.
// ─────────────────────────────────────────────────────────────────────────────

const HEDERA = '0.0.12345';

describe('isHederaAccount', () => {
    it('accepts only canonical Hedera account IDs', () => {
        expect(isHederaAccount(HEDERA)).toBe(true);
        expect(isHederaAccount('  0.0.12345  ')).toBe(true);

        // The Hedera SDK rewrites these instead of rejecting them, which is how
        // a non-Hedera wallet ends up looking like a settlement account.
        expect(isHederaAccount('0x1234')).toBe(false);
        expect(isHederaAccount('0xabc0000000000000000000000000000000001234')).toBe(false);
        expect(isHederaAccount('12345')).toBe(false);
        expect(isHederaAccount('0.0.abc')).toBe(false);
        expect(isHederaAccount('')).toBe(false);
        expect(isHederaAccount(null)).toBe(false);
        expect(isHederaAccount(undefined)).toBe(false);
        expect(isHederaAccount(12345)).toBe(false);
        expect(isHederaAccount({ toString: () => HEDERA })).toBe(false);
    });
});

describe('canSettle', () => {
    it('is false for every identity that cannot move HBAR', () => {
        expect(canSettle(null)).toBe(false);
        expect(canSettle(undefined)).toBe(false);
        expect(canSettle('0xabc0000000000000000000000000000000001234')).toBe(false);
        expect(canSettle('0.0.abc')).toBe(false);
    });

    it('is true for a Hedera settlement account', () => {
        expect(canSettle(HEDERA)).toBe(true);
    });
});

describe('gateState', () => {
    it('locks both controls with an actionable message', () => {
        expect(gateState(false, 'post')).toEqual({
            disabled: true,
            title: 'Connect a Hedera account to post an offer',
            label: 'Hedera account required to post',
        });
        expect(gateState(false, 'trade')).toEqual({
            disabled: true,
            title: 'Connect a Hedera account to buy energy',
            label: 'Hedera account required to trade',
        });
    });

    it('unlocks both controls when a Hedera account is connected', () => {
        expect(gateState(true, 'post')).toEqual({
            disabled: false,
            title: '',
            label: 'Post Energy Offer to Hedera',
        });
        expect(gateState(true, 'trade')).toEqual({
            disabled: false,
            title: '',
            label: 'Execute Trade',
        });
    });

    it('rejects an unknown control rather than guessing', () => {
        expect(() => gateState(true, 'nonsense')).toThrow(/Unknown gated control/);
    });
});

describe('applyTradeGate (updateTradeGate)', () => {
    let postButton;
    let tradeButton;

    beforeEach(() => {
        document.body.innerHTML = `
            <form id="offer-form"><button type="submit">Post Energy Offer to Hedera</button></form>
            <button id="confirm-trade">Execute Trade</button>
        `;
        postButton = document.querySelector('#offer-form button[type="submit"]');
        tradeButton = document.querySelector('#confirm-trade');
    });

    it('disables posting and trading when only an EVM identity is connected', () => {
        const canTrade = applyTradeGate(
            { postButton, tradeButton },
            { connectedAccountId: null, selectedOffer: null },
        );

        expect(canTrade).toBe(false);
        expect(postButton.disabled).toBe(true);
        expect(tradeButton.disabled).toBe(true);
        expect(tradeButton.textContent).toBe('Hedera account required to trade');
        expect(tradeButton.title).toBe('Connect a Hedera account to buy energy');
    });

    it('disables both controls when a non-Hedera wallet address is connected', () => {
        // The regression this exists to prevent is only meaningful if an
        // EVM-shaped address is refused rather than truthy.
        applyTradeGate(
            { postButton, tradeButton },
            { connectedAccountId: '0xabc0000000000000000000000000000000001234', selectedOffer: null },
        );
        expect(postButton.disabled).toBe(true);
        expect(tradeButton.disabled).toBe(true);
    });

    it('enables both controls for a Hedera account', () => {
        const canTrade = applyTradeGate(
            { postButton, tradeButton },
            { connectedAccountId: HEDERA, selectedOffer: null },
        );

        expect(canTrade).toBe(true);
        expect(postButton.disabled).toBe(false);
        expect(postButton.textContent).toBe('Post Energy Offer to Hedera');
        expect(tradeButton.disabled).toBe(false);
        expect(tradeButton.textContent).toBe('Execute Trade');
        expect(tradeButton.title).toBe('');
    });

    it('leaves the trade button alone once an offer is selected', () => {
        // selectOffer owns that button from the moment a selection exists. The
        // gate must not undo its decision, or a selected offer silently loses
        // the amount the user already chose.
        tradeButton.disabled = false;
        tradeButton.textContent = 'Processing...';

        applyTradeGate(
            { postButton, tradeButton },
            { connectedAccountId: null, selectedOffer: { id: 'offer-1', energyAmountKWh: 10 } },
        );

        expect(tradeButton.textContent).toBe('Processing...');
        expect(postButton.disabled).toBe(true, 'the post control is still the gate\'s to own');
    });

    it('tolerates missing elements', () => {
        expect(() =>
            applyTradeGate({}, { connectedAccountId: null, selectedOffer: null }),
        ).not.toThrow();
        expect(applyTradeGate({ postButton: null, tradeButton: null }, { connectedAccountId: HEDERA, selectedOffer: null })).toBe(true);
    });
});

describe('applySelectedOfferGate (selectOffer)', () => {
    let tradeButton;

    beforeEach(() => {
        document.body.innerHTML = '<button id="confirm-trade">Execute Trade</button>';
        tradeButton = document.querySelector('#confirm-trade');
    });

    it('REGRESSION: selecting an offer must not enable trading without a Hedera account', () => {
        // This is the exact bug the gate exists for: a live-looking button for a
        // user who cannot settle.
        const canTrade = applySelectedOfferGate(
            { tradeButton },
            { connectedAccountId: null },
        );

        expect(canTrade).toBe(false);
        expect(tradeButton.disabled).toBe(true);
        expect(tradeButton.textContent).toBe('Hedera account required to trade');
        expect(tradeButton.title).toBe('Connect a Hedera account to buy energy');
    });

    it('REGRESSION: the same applies to an EVM-only identity address', () => {
        applySelectedOfferGate({ tradeButton }, { connectedAccountId: '0xabc0000000000000000000000000000000001234' });
        expect(tradeButton.disabled).toBe(true);
    });

    it('enables the button for a Hedera account, so the gate is not simply always-off', () => {
        const canTrade = applySelectedOfferGate({ tradeButton }, { connectedAccountId: HEDERA });

        expect(canTrade).toBe(true);
        expect(tradeButton.disabled).toBe(false);
        expect(tradeButton.textContent).toBe('Execute Trade');
    });
});

describe('isWithinOffer', () => {
    const offer = { id: 'offer-1', energyAmountKWh: 10 };

    it('accepts an amount up to and including what the offer holds', () => {
        expect(isWithinOffer(10, offer)).toBe(true);
        expect(isWithinOffer(0.5, offer)).toBe(true);
    });

    it('refuses more than the offer holds, and the degenerate amounts', () => {
        // The API re-checks this, so an oversized claim is caught server-side.
        // It still must not be reachable from the UI.
        expect(isWithinOffer(10.00000001, offer)).toBe(false);
        expect(isWithinOffer(0, offer)).toBe(false);
        expect(isWithinOffer(-1, offer)).toBe(false);
        expect(isWithinOffer(Number.NaN, offer)).toBe(false);
    });

    it('refuses everything when no offer is selected', () => {
        expect(isWithinOffer(1, null)).toBe(false);
        expect(isWithinOffer(1, undefined)).toBe(false);
    });
});