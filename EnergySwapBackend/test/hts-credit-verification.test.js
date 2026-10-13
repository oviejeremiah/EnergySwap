const test = require('node:test');
const assert = require('node:assert/strict');

const { htsCreditError } = require('../server');

// The endpoint that calls this decides whether a meter reading is marked
// `credited` - the status that means energy has been released. It is reachable
// without authentication, so the rule has to be strict about what counts as
// proof of a token credit.
const TOKEN = '0.0.6241546';
const PROSUMER = '0.0.6242449';

const tinybars = (n) => ({ toTinybars: () => String(n) });
const account = (id) => ({ toString: () => id });
const token = (id) => ({ toString: () => id });

const leg = (acct, amount, tokenId = null) => ({
    accountId: account(acct),
    amount: tinybars(amount),
    tokenId: tokenId ? token(tokenId) : null,
});

const record = (transfers) => ({ transfers });

test('accepts a credit of the expected energy tokens', () => {
    const result = htsCreditError(
        record([leg('0.0.1234', -1575, TOKEN), leg(PROSUMER, 1575, TOKEN)]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.equal(result, null);
});

test('rejects a plain HBAR payment of the same magnitude', () => {
    // The attack this guards against: HBAR transfer legs carry no tokenId and
    // are scaled in tinybar, so an amount-only match accepted an ordinary
    // payment as proof that energy tokens had been transferred.
    const result = htsCreditError(
        record([leg('0.0.1234', -1575), leg(PROSUMER, 1575)]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.ok(result, 'a bare HBAR payment must not be accepted as a token credit');
    assert.match(result, /HBAR, not in energy tokens/);
});

test('rejects a credit in the wrong token', () => {
    const other = '0.0.9999999';
    const result = htsCreditError(
        record([leg('0.0.1234', -1575, other), leg(PROSUMER, 1575, other)]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.ok(result);
    assert.match(result, /energy tokens/);
});

test('rejects when the prosumumer receives nothing', () => {
    const result = htsCreditError(
        record([leg('0.0.1234', -1575, TOKEN)]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.ok(result);
    assert.match(result, /does not credit the prosumer/);
});

test('rejects a credit of the wrong amount', () => {
    const result = htsCreditError(
        record([leg(PROSUMER, 1, TOKEN)]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.ok(result);
    assert.match(result, /different amount/);
});

test('rejects a negative leg to the prosumumer', () => {
    const result = htsCreditError(
        record([leg(PROSUMER, -1575, TOKEN)]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.ok(result);
});

test('refuses when no energy token is configured', () => {
    // Failing closed: an unconfigured token must not mean "accept anything".
    const result = htsCreditError(record([leg(PROSUMER, 1575, TOKEN)]), PROSUMER, 1575, '');
    assert.ok(result);
    assert.match(result, /not configured/);
});

test('refuses on a missing or malformed record', () => {
    assert.ok(htsCreditError(undefined, PROSUMER, 1575, TOKEN));
    assert.ok(htsCreditError({}, PROSUMER, 1575, TOKEN));
    assert.ok(htsCreditError({ transfers: [] }, PROSUMER, 1575, TOKEN));
});