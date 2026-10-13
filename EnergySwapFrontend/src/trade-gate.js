/**
 * The trade gate.
 *
 * EnergySwap separates identity from settlement: signing in with any EVM wallet
 * proves who you are and moves no funds, while posting an offer and buying
 * energy both settle HBAR and therefore need a Hedera account. That rule is the
 * single thing standing between a browsing user and a button that looks live and
 * then fails on click.
 *
 * It lives here, apart from the DOM wiring in main.js, because it is the part
 * that has already regressed once: `selectOffer` re-enabling the trade button
 * for a user with no Hedera account. Keeping the decision here means it can be
 * tested directly instead of inferred from a rendered page.
 *
 * Nothing in this module reads or writes global state; everything it needs is
 * passed in.
 */

/**
 * True when the value is a canonical Hedera account ID.
 *
 * Strictly digits: the Hedera SDK accepts hex and EVM-shaped strings and
 * silently rewrites them, which is what the API's own guard exists to stop.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export const isHederaAccount = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value.trim());

/**
 * Whether this session may post an offer or execute a trade.
 *
 * @param {unknown} connectedAccountId the Hedera settlement account, if any
 * @returns {boolean}
 */
export const canSettle = (connectedAccountId) => isHederaAccount(connectedAccountId);

/** The strings the gate puts on a control, for both states of the gate. */
const COPY = {
    locked: (title, label) => ({ disabled: true, title, label }),
    unlocked: (label) => ({ disabled: false, title: '', label }),
};

/**
 * The state a gated control should be in.
 *
 * The wording is pinned verbatim: these strings are what a user reads when they
 * cannot trade, and "post" versus "post an offer" is not a distinction worth
 * making them parse.
 *
 * @param {boolean} canTrade
 * @param {'post'|'trade'} which
 */
export const gateState = (canTrade, which) => {
    if (which === 'post') {
        return canTrade
            ? COPY.unlocked('Post Energy Offer to Hedera')
            : COPY.locked('Connect a Hedera account to post an offer', 'Hedera account required to post');
    }
    if (which === 'trade') {
        return canTrade
            ? COPY.unlocked('Execute Trade')
            : COPY.locked('Connect a Hedera account to buy energy', 'Hedera account required to trade');
    }
    throw new Error(`Unknown gated control: ${which}`);
};

/**
 * Apply the gate to the live controls.
 *
 * `tradeButton` is only touched while no offer is selected: once `selectOffer`
 * has run, it owns that button's label and enabled state, and this must not
 * undo its decision.
 *
 * @param {{postButton?: Element|null, tradeButton?: Element|null, document?: Document}} elements
 * @param {{connectedAccountId: unknown, selectedOffer: unknown}} state
 * @returns {boolean} whether trading is currently permitted
 */
export const applyTradeGate = ({ postButton, tradeButton }, { connectedAccountId, selectedOffer }) => {
    const canTrade = canSettle(connectedAccountId);

    if (postButton) {
        const next = gateState(canTrade, 'post');
        postButton.disabled = next.disabled;
        postButton.title = next.title;
        postButton.textContent = next.label;
    }

    if (tradeButton && !selectedOffer) {
        const next = gateState(canTrade, 'trade');
        tradeButton.disabled = next.disabled;
        tradeButton.title = next.title;
        tradeButton.textContent = next.label;
    }

    return canTrade;
};

/**
 * Apply the gate to the trade button once an offer has been selected.
 *
 * Separate from `applyTradeGate` because the two run at different moments and
 * disagree on purpose: after a selection the button belongs to the selection.
 * `selectOffer` re-enabling trading for a user with no Hedera account is a
 * regression this has already suffered once, so the rule lives here rather than
 * being inlined at the call site.
 *
 * @param {{tradeButton?: Element|null}} elements
 * @param {{connectedAccountId: unknown}} state
 * @returns {boolean} whether trading is currently permitted
 */
export const applySelectedOfferGate = ({ tradeButton }, { connectedAccountId }) => {
    const canTrade = canSettle(connectedAccountId);
    if (tradeButton) {
        const next = gateState(canTrade, 'trade');
        tradeButton.disabled = next.disabled;
        tradeButton.title = next.title;
        tradeButton.textContent = next.label;
    }
    return canTrade;
};

/**
 * Whether a kWh amount may be bought from an offer.
 *
 * The API re-checks this against the offer's remaining energy, so this is a
 * courtesy to the user rather than a control - but it is the first place a
 * stale or oversized amount is caught.
 *
 * @param {number} kwh
 * @param {{energyAmountKWh: number}|null|undefined} offer
 */
export const isWithinOffer = (kwh, offer) =>
    Boolean(offer) &&
    Number.isFinite(kwh) &&
    kwh > 0 &&
    kwh <= Number(offer.energyAmountKWh);