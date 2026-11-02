const test = require('node:test');
const assert = require('node:assert/strict');

const { htsCreditError } = require('../server');

// The endpoint that calls this decides whether a meter reading is marked
// `credited` - the status that means energy has been released. It is reachable
// without authentication, so the rule has to be strict about what counts as
// proof of a token credit.
//
// Records are in the normalised shape mirror-node.js produces. The separation
// that matters: HBAR legs arrive in `transfers` and token legs in
// `tokenTransfers`, and a leg with no token id is never normalised into
// `tokenTransfers` at all. That separation is what makes a plain HBAR payment
// structurally unable to read as a token credit.
//
// The previous version of these tests built the SDK's TransactionRecord, with
// `amount.toTinybars()` and `tokenId.toString()` wrappers. That shape is gone
// because the SDK query which produced it cannot run in this platform: it
// demands an operator the API deliberately does not hold.
const TOKEN = '0.0.6241546';
const PROSUMER = '0.0.6242449';

const tokenRecord = (legs) => ({
    tokenTransfers: legs.map(([accountId, amount]) => ({ accountId, tokenId: TOKEN, amount: String(amount) })),
    transfers: [],
});

const hbarRecord = (legs) => ({
    tokenTransfers: [],
    transfers: legs.map(([accountId, amountTinybars]) => ({ accountId, amountTinybars: String(amountTinybars) })),
});

test('accepts a credit of the expected energy tokens', () => {
    const result = htsCreditError(
        tokenRecord([
            ['0.0.1234', -1575],
            [PROSUMER, 1575],
        ]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.equal(result, null);
});

test('rejects a plain HBAR payment of the same magnitude', () => {
    // The attack this guards against: HBAR transfer legs carry no token id and
    // are scaled in tinybar, so an amount-only match accepted an ordinary
    // payment as proof that energy tokens had been transferred.
    const result = htsCreditError(
        hbarRecord([
            ['0.0.1234', -1575],
            [PROSUMER, 1575],
        ]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.match(result, /HBAR, not in energy tokens/);
});

test('rejects a credit of the wrong amount', () => {
    const result = htsCreditError(
        tokenRecord([
            ['0.0.1234', -999],
            [PROSUMER, 999],
        ]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.match(result, /different amount/);
});

test('rejects a credit short by a single token unit', () => {
    // Integer comparison, not a range check: 1574 is not 1575.
    const result = htsCreditError(
        tokenRecord([
            ['0.0.1234', -1574],
            [PROSUMER, 1574],
        ]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.match(result, /different amount/);
});

test('rejects a credit of zero units', () => {
    const result = htsCreditError(tokenRecord([[PROSUMER, 0]]), PROSUMER, 1575, TOKEN);
    assert.match(result, /does not credit the prosumer/);
});

test('rejects a credit in a different token', () => {
    const result = htsCreditError(
        {
            tokenTransfers: [{ accountId: PROSUMER, tokenId: '0.0.999999', amount: '1575' }],
            transfers: [],
        },
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.match(result, /does not credit the prosumer/);
});

test('rejects a credit to somebody else', () => {
    const result = htsCreditError(
        tokenRecord([
            ['0.0.1234', -1575],
            ['0.0.55555', 1575],
        ]),
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.match(result, /does not credit the prosumer/);
});

test('rejects a prosumuer paying out rather than receiving', () => {
    const result = htsCreditError(tokenRecord([[PROSUMER, -1575]]), PROSUMER, 1575, TOKEN);
    assert.match(result, /does not credit the prosumer/);
});

test('rejects an empty record', () => {
    const result = htsCreditError(tokenRecord([]), PROSUMER, 1575, TOKEN);
    assert.match(result, /does not credit the prosumer/);
});

test('fails closed on a malformed record rather than throwing', () => {
    for (const bad of [null, {}, { tokenTransfers: null }, { tokenTransfers: [] }, undefined]) {
        assert.ok(htsCreditError(bad, PROSUMER, 1575, TOKEN), `expected a refusal for ${JSON.stringify(bad)}`);
    }
});

test('refuses when no energy token is configured', () => {
    // Without a configured token there is no way to tell a credit of the right
    // instrument from a credit of the wrong one, so nothing may be released.
    const result = htsCreditError(tokenRecord([[PROSUMER, 1575]]), PROSUMER, 1575, '');
    assert.match(result, /not configured/);
});

test('a leg with no token id is never presented as a token leg', () => {
    // The normaliser drops such legs entirely. If one ever appeared in
    // tokenTransfers with an empty tokenId, the equality check against the
    // configured token would reject it - but it must never satisfy it.
    const result = htsCreditError(
        { tokenTransfers: [{ accountId: PROSUMER, tokenId: null, amount: '1575' }], transfers: [] },
        PROSUMER,
        1575,
        TOKEN,
    );
    assert.match(result, /does not credit the prosumer/);
});