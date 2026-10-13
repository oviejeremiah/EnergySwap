const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const request = require('supertest');
const sdk = require('@hashgraph/sdk');

const { app } = require('../server');

// ─────────────────────────────────────────────────────────────────────────────
// The four failure scenarios named for explicit proof:
//
//   1. a trade cannot proceed with an incorrect identity binding
//   2. a trade cannot proceed with insufficient funds
//   3. a trade cannot proceed with a failed signature
//   4. a trade cannot proceed with a replayed request
//
// Every assertion here is a positive control pair: each guard is exercised both
// with the attack and with the honest version of the same request. A guard test
// that only ever sees the failure can pass because the route is broken in some
// unrelated way, so "it was refused" is never asserted without a neighbouring
// "and this identical shape was accepted".
// ─────────────────────────────────────────────────────────────────────────────

const OFFER_ID = 'scenario-offer';
const BUYER = '0.0.6242888';
const SELLER = '0.0.6242999';
const THIRD_PARTY = '0.0.6242777';

const KWH = 10;
const RATE = 0.5;
// 10 kWh x 0.5 HBAR = 5 HBAR = 500_000_000 tinybar.
const PRICE_TINYBARS = 500_000_000;
const FEE_TINYBARS = 100_000; // 0.001 HBAR

const TX_ID = '0.0.999@1.000000901';

// ─── fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a stand-in for a Hedera TransactionRecord.
 *
 * The shapes mirror what server.js actually reads: `receipt.status.toString()`,
 * `transactionId.accountId.toString()`, `transactionMemo`, `transfers[]` with
 * `accountId.toString()` / `amount.toTinybars()`, and `transactionFee`.
 */
function chainRecord({ payer = BUYER, memo = `EnergySwap ${OFFER_ID}`, status = 'SUCCESS', fee = FEE_TINYBARS, transfers }) {
    return {
        receipt: { status: { toString: () => status } },
        transactionId: { accountId: { toString: () => payer } },
        transactionMemo: memo,
        transfers: transfers.map((t) => ({
            accountId: { toString: () => t.account },
            amount: { toTinybars: () => String(t.tinybars) },
            tokenId: t.tokenId ?? null,
        })),
        transactionFee: { toTinybars: () => String(fee) },
    };
}

/** The happy-path record: the consumer pays the offer amount plus the fee. */
function settledTransfer(overrides = {}) {
    const { transfers: overridesFor = [], ...rest } = overrides;
    // One leg per account, exactly as a real Hedera record has. An override
    // replaces that account's leg rather than adding a second one: the route
    // reads legs with `.find()`, so a duplicate would hide the thing under test.
    const legs = new Map([
        [SELLER, PRICE_TINYBARS],
        [BUYER, -(PRICE_TINYBARS + FEE_TINYBARS)],
        [THIRD_PARTY, FEE_TINYBARS],
    ]);
    for (const leg of overridesFor) legs.set(leg.account, leg.tinybars);
    return chainRecord({
        ...rest,
        transfers: [...legs].map(([account, tinybars]) => ({ account, tinybars })),
    });
}

/**
 * An in-memory repository that models the parts of PostgreSQL the trade route
 * depends on: the unique transaction_id, and the offer's remaining energy.
 *
 * A pure stub that ignores transaction identity would make the replay test pass
 * for the wrong reason, so duplicates are detected the way the database does.
 */
function createTradeRepository({ offerKwh = KWH, tradeKwh = KWH, offerStatus = 'available' } = {}) {
    const trades = new Map(); // transaction_id -> trade
    let recordTradeCalls = 0;
    const offer = {
        id: OFFER_ID,
        prosumerId: SELLER,
        energyAmountKWh: offerKwh,
        hbarPerKWh: RATE,
        status: offerStatus,
    };
    return {
        trades,
        get recordTradeCalls() {
            return recordTradeCalls;
        },
        get remainingKwh() {
            return offer.energyAmountKWh;
        },
        async findTradeByTransactionId(transactionId) {
            return trades.get(transactionId) || null;
        },
        async getOffer(id) {
            return id === OFFER_ID ? { ...offer } : null;
        },
        async recordTrade(trade) {
            recordTradeCalls += 1;
            // PostgreSQL's unique index on (settlement_network, transaction_id).
            if (trades.has(trade.transactionId)) {
                return { kind: 'duplicate', trade: trades.get(trade.transactionId) };
            }
            offer.energyAmountKWh = Number((offer.energyAmountKWh - Number(trade.energyAmountKWh)).toFixed(8));
            const stored = { ...trade, status: 'completed' };
            trades.set(trade.transactionId, stored);
            return { kind: 'recorded', trade: stored };
        },
        async listTrades() {
            return [...trades.values()];
        },
    };
}

/** Swap the repository and the chain's answer for the duration of `fn`. */
async function withScenario({ record = settledTransfer(), repository = createTradeRepository(), config, fetchStub }, fn) {
    const prior = {
        repository: app.locals.repository,
        config: app.locals.config,
        createHederaClient: app.locals.createHederaClient,
        execute: sdk.TransactionRecordQuery.prototype.execute,
        fetch: global.fetch,
    };
    sdk.TransactionRecordQuery.prototype.execute = async () => record;
    // A client with no operator is enough: execute() above short-circuits the
    // network entirely, and this proves the route never signs anything.
    app.locals.createHederaClient = () => ({ close() {} });
    app.locals.repository = repository;
    if (config) app.locals.config = { ...prior.config, ...config };
    if (fetchStub) global.fetch = fetchStub;
    try {
        return await fn({ repository });
    } finally {
        sdk.TransactionRecordQuery.prototype.execute = prior.execute;
        app.locals.createHederaClient = prior.createHederaClient;
        app.locals.repository = prior.repository;
        app.locals.config = prior.config;
        global.fetch = prior.fetch;
    }
}

const postTrade = (body = {}) =>
    request(app).post('/api/record-trade').send({
        offerId: OFFER_ID,
        energyAmountKWh: KWH,
        consumerAccountId: BUYER,
        transactionId: TX_ID,
        ...body,
    });

// ─── scenario 2: insufficient funds ──────────────────────────────────────────

test('an honest payment is recorded (positive control for the money-path guards)', async () => {
    const repository = createTradeRepository();
    await withScenario({ repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(response.body.success, true);
        assert.equal(repository.remainingKwh, 0, 'the offer must be debited by exactly the traded energy');
        assert.equal(response.body.hbarPaid, 5);
    });
});

test('a payment that cannot cover the amount plus the network fee is refused', async () => {
    // The buyer covered the offer but not the fee. On Hedera this shape cannot
    // actually reach consensus, so this is the server refusing to record it on
    // the strength of the record alone.
    const record = chainRecord({
        transfers: [
            { account: SELLER, tinybars: PRICE_TINYBARS },
            { account: BUYER, tinybars: -PRICE_TINYBARS },
            { account: THIRD_PARTY, tinybars: FEE_TINYBARS },
        ],
    });
    const repository = createTradeRepository();
    await withScenario({ record, repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 400);
        assert.match(response.body.message, /does not charge the consumer for the offer and network fee/);
        assert.equal(repository.recordTradeCalls, 0, 'nothing may be recorded');
        assert.equal(repository.remainingKwh, KWH, 'the offer must not be debited');
    });
});

test('a payment materially short of the posted amount is refused', async () => {
    // The buyer only had a fifth of what the offer costs. This is the shape a
    // genuinely underfunded account produces.
    const record = chainRecord({
        transfers: [
            { account: SELLER, tinybars: 100_000_000 },
            { account: BUYER, tinybars: -(100_000_000 + FEE_TINYBARS) },
            { account: THIRD_PARTY, tinybars: FEE_TINYBARS },
        ],
    });
    const repository = createTradeRepository();
    await withScenario({ record, repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 400);
        assert.match(response.body.message, /does not pay the posted offer amount to the prosumer/);
        assert.equal(repository.recordTradeCalls, 0);
    });
});

test('an overpayment is refused rather than silently accepted', async () => {
    const record = settledTransfer({
        transfers: [{ account: BUYER, tinybars: -(PRICE_TINYBARS + FEE_TINYBARS + 5_000_000) }],
    });
    const repository = createTradeRepository();
    await withScenario({ record, repository }, async () => {
        // An exact match is required in both directions: a buyer who overpays
        // has paid the wrong amount and the trade is not what they agreed to.
        const response = await postTrade();
        assert.equal(response.status, 400);
        assert.equal(repository.recordTradeCalls, 0);
    });
});

test('a transaction that did not succeed is refused', async () => {
    const repository = createTradeRepository();
    await withScenario({ record: settledTransfer({ status: 'REVERSED' }), repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 400);
        assert.match(response.body.message, /did not succeed/);
        assert.equal(repository.recordTradeCalls, 0);
    });
});

test('the consumer must be the fee payer', async () => {
    // A third party submitted the transfer. Without this the trade would be
    // attributed to a buyer who never authorised it.
    const repository = createTradeRepository();
    await withScenario({ record: settledTransfer({ payer: THIRD_PARTY }), repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 400);
        assert.match(response.body.message, /must be the transaction fee payer/);
        assert.equal(repository.recordTradeCalls, 0);
    });
});

test('the transaction memo must name the selected offer', async () => {
    // Prevents a buyer from replaying a transfer they already made for a
    // different offer, or for a different kWh amount, as though it were this one.
    const repository = createTradeRepository();
    await withScenario({ record: settledTransfer({ memo: 'EnergySwap some-other-offer' }), repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 400);
        assert.match(response.body.message, /memo does not match/);
        assert.equal(repository.recordTradeCalls, 0);
    });
});

test('a claim larger than the offer is refused before any chain verification', async () => {
    // Ceiling guard: asserted here as well because the ceiling and the
    // transfer-leg guards are different defences and either could regress alone.
    const repository = createTradeRepository({ offerKwh: 4 });
    await withScenario({ repository }, async () => {
        const response = await postTrade({ energyAmountKWh: 9 });
        assert.equal(response.status, 400);
        assert.match(response.body.message, /only has 4 kWh available/);
        assert.equal(repository.recordTradeCalls, 0);
    });
});

// ─── scenario 4: replayed request ────────────────────────────────────────────

test('a replayed transaction is idempotent: no 500, and the offer is debited once', async () => {
    const repository = createTradeRepository();
    await withScenario({ repository }, async () => {
        const first = await postTrade();
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal(repository.remainingKwh, 0);

        // Exactly the same request, byte for byte. The buyer has already been
        // told the payment succeeded, so this must be a success, not an error.
        const replay = await postTrade();
        assert.equal(replay.status, 200, `a replay must not 500: ${JSON.stringify(replay.body)}`);
        assert.equal(replay.body.success, true);
        assert.match(replay.body.message, /already recorded/i);
        assert.equal(replay.body.trade.transactionId, TX_ID);

        assert.equal(repository.recordTradeCalls, 1, 'the replay must not be recorded a second time');
        assert.equal(repository.remainingKwh, 0, 'the offer must be debited exactly once');
        assert.equal(repository.trades.size, 1);

        // A third replay stays idempotent.
        const again = await postTrade();
        assert.equal(again.status, 200);
        assert.equal(repository.trades.size, 1);
    });
});

test('a replay is still refused when trade storage reports a duplicate it cannot complete', async () => {
    // The other replay shape: the row exists but is not 'completed'. The buyer
    // paid, so this must be an explicit 409 naming the transaction - never a
    // silent success and never a 500.
    const repository = createTradeRepository();
    repository.trades.set(TX_ID, {
        id: 'trade-existing',
        offerId: OFFER_ID,
        buyerId: BUYER,
        sellerId: SELLER,
        transactionId: TX_ID,
        energyAmountKWh: String(KWH),
        hbarAmount: 5,
        gasFeeHbar: 0.001,
        totalHbarPaid: 5.001,
        gasFeeUSD: '0.000024',
        status: 'reconciliation_required',
    });
    await withScenario({ repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 409);
        assert.match(response.body.message, /requires operator reconciliation/);
        assert.equal(repository.recordTradeCalls, 0);
        assert.equal(repository.remainingKwh, KWH, 'a stuck replay must not consume more energy');
    });
});

test('a storage failure on the duplicate check is a 503, not a false success', async () => {
    const repository = createTradeRepository();
    repository.findTradeByTransactionId = async () => {
        throw new Error('connection terminated unexpectedly');
    };
    await withScenario({ repository }, async () => {
        const response = await postTrade();
        assert.equal(response.status, 503);
        assert.equal(response.body.success, false);
        assert.equal(repository.recordTradeCalls, 0);
    });
});

// ─── scenario 1: incorrect identity binding ──────────────────────────────────

const IDENTITY_TOPIC = '0.0.6242998';
const VICTIM = '0.0.6242777';
const ATTACKER = '0.0.6242666';
const ALICE_EVM = '0xabc0000000000000000000000000000000001234';
const MALLORY_EVM = '0xdef0000000000000000000000000000000005678';

const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

function mirrorReturning(messages) {
    return async () => ({ ok: true, status: 200, json: async () => ({ messages }) });
}

const attestationFor = (fields) => ({
    v: 1,
    purpose: 'energyswap.identity-binding.v1',
    hederaAccountId: VICTIM,
    evmAddress: MALLORY_EVM,
    evmChainId: 1,
    issuedAt: new Date().toISOString(),
    ...fields,
});

test('a binding whose attestation was paid for by another account never reaches the database', async () => {
    let saved = 0;
    const repository = {
        async saveIdentityBinding() {
            saved += 1;
            return {};
        },
    };

    // The whole attack: Mallory publishes a real, on-chain message naming the
    // victim's Hedera account, but she paid for it, so the mirror node records
    // her as the payer.
    await withScenario(
        {
            repository,
            config: { hcsTopicId: IDENTITY_TOPIC, hederaMirrorNodeUrl: 'https://mirror.test' },
            fetchStub: mirrorReturning([
                { payer_account_id: ATTACKER, sequence_number: 1, message: encode(attestationFor({ nonce: 'PLACEHOLDER' })) },
            ]),
        },
        async () => {
            const issued = await request(app)
                .post('/api/identity/binding/nonce')
                .send({ evmAddress: MALLORY_EVM, hederaAccountId: VICTIM })
                .expect(200);

            // Re-encode with the real nonce now that it has been issued.
            global.fetch = mirrorReturning([
                {
                    payer_account_id: ATTACKER,
                    sequence_number: 1,
                    message: encode(attestationFor({ nonce: issued.body.nonce })),
                },
            ]);

            const response = await request(app)
                .post('/api/identity/binding/verify')
                .send({ evmAddress: MALLORY_EVM, hederaAccountId: VICTIM, nonce: issued.body.nonce });

            assert.equal(response.status, 409);
            assert.equal(response.body.success, false);
            assert.equal(saved, 0, 'a forged binding must never be written');
        },
    );
});

test('a genuine attestation does reach the database (positive control)', async () => {
    // Without this, the test above could be passing because the route is broken
    // for an unrelated reason and rejects everything.
    let saved = 0;
    const repository = {
        savedBindings: [],
        async saveIdentityBinding(binding) {
            saved += 1;
            this.savedBindings.push(binding);
            return binding;
        },
    };

    await withScenario(
        {
            repository,
            config: { hcsTopicId: IDENTITY_TOPIC, hederaMirrorNodeUrl: 'https://mirror.test' },
        },
        async () => {
            const issued = await request(app)
                .post('/api/identity/binding/nonce')
                .send({ evmAddress: ALICE_EVM, hederaAccountId: VICTIM })
                .expect(200);

            global.fetch = mirrorReturning([
                {
                    payer_account_id: VICTIM,
                    sequence_number: 7,
                    consensus_timestamp: '1751000000.000000000',
                    message: encode({
                        ...attestationFor({ nonce: issued.body.nonce }),
                        evmAddress: ALICE_EVM,
                    }),
                },
            ]);

            const response = await request(app)
                .post('/api/identity/binding/verify')
                .send({ evmAddress: ALICE_EVM, hederaAccountId: VICTIM, nonce: issued.body.nonce });

            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(saved, 1);
            assert.equal(repository.savedBindings[0].evmAddress, ALICE_EVM);
            assert.equal(repository.savedBindings[0].hederaAccountId, VICTIM);
        },
    );
});

test('the unlink route refuses an unauthenticated delete and honours a signed one', async () => {
    const { Wallet } = require('ethers');
    const alice = new Wallet(`0x${'11'.repeat(32)}`);
    const mallory = new Wallet(`0x${'22'.repeat(32)}`);
    const ALICE = alice.address.toLowerCase();

    let deleted = [];
    const repository = {
        async deleteIdentityBinding(address) {
            deleted.push(address);
            return true;
        },
    };

    await withScenario({ repository }, async () => {
        // No signature at all.
        const unsigned = await request(app).delete('/api/identity/binding').send({ evmAddress: ALICE });
        assert.equal(unsigned.status, 403);
        assert.equal(deleted.length, 0);

        // Mallory signs the victim's own nonce.
        const challenge = await request(app).post('/api/identity/binding/unlink-nonce').send({ evmAddress: ALICE }).expect(200);
        const forged = await request(app)
            .delete('/api/identity/binding')
            .send({ evmAddress: ALICE, unlinkNonce: challenge.body.nonce, unlinkSignature: mallory.signMessageSync(challenge.body.message) });
        assert.equal(forged.status, 403);
        assert.equal(deleted.length, 0, 'a third party must not be able to unlink a wallet');

        // The real owner, signing her own nonce.
        const challenge2 = await request(app).post('/api/identity/binding/unlink-nonce').send({ evmAddress: ALICE }).expect(200);
        const genuine = await request(app)
            .delete('/api/identity/binding')
            .send({ evmAddress: ALICE, unlinkNonce: challenge2.body.nonce, unlinkSignature: alice.signMessageSync(challenge2.body.message) });
        assert.equal(genuine.status, 200, JSON.stringify(genuine.body));
        assert.deepEqual(deleted, [ALICE]);
    });
});

// ─── scenario 3: failed signature on the offer-posting path ───────────────────

test('a failed wallet signature refuses the offer, a valid one accepts it', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);

    let posted = 0;
    const repository = {
        async createOffer(offer) {
            posted += 1;
            return offer;
        },
    };

    const mirrorNode = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ account: SELLER, key: { _type: 'ED25519', key: rawKey.toString('hex') } }),
    });

    await withScenario(
        { repository, config: { requireWalletSignature: true }, fetchStub: mirrorNode },
        async () => {
            // No challenge at all.
            const noChallenge = await request(app)
                .post('/api/post-offer')
                .send({ prosumerId: SELLER, energyAmountKWh: 10, hbarPerKWh: 0.5 });
            assert.equal(noChallenge.status, 401);
            assert.equal(posted, 0);

            // A signature from a key that is not the account's.
            const challenge = await request(app).get('/api/wallet-auth/challenge').query({ accountId: SELLER }).expect(200);
            const impostor = crypto.generateKeyPairSync('ed25519');
            const wrongKey = await request(app)
                .post('/api/post-offer')
                .send({
                    prosumerId: SELLER,
                    energyAmountKWh: 10,
                    hbarPerKWh: 0.5,
                    challengeNonce: challenge.body.nonce,
                    challengeSignature: crypto
                        .sign(null, Buffer.from(challenge.body.message, 'utf8'), impostor.privateKey)
                        .toString('base64'),
                });
            assert.equal(wrongKey.status, 401);
            assert.equal(posted, 0);

            // The genuine owner.
            const good = await request(app).get('/api/wallet-auth/challenge').query({ accountId: SELLER }).expect(200);
            const accepted = await request(app)
                .post('/api/post-offer')
                .send({
                    prosumerId: SELLER,
                    energyAmountKWh: 10,
                    hbarPerKWh: 0.5,
                    challengeNonce: good.body.nonce,
                    challengeSignature: crypto
                        .sign(null, Buffer.from(good.body.message, 'utf8'), privateKey)
                        .toString('base64'),
                });
            assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
            assert.equal(posted, 1);
        },
    );
});

test('offer posting is unauthenticated while requireWalletSignature is off', async () => {
    // The state production is actually in: render.yaml leaves
    // REQUIRE_WALLET_SIGNATURE unset. Asserted so the day it is switched on,
    // this test is the thing that tells you the behaviour changed deliberately.
    const repository = {
        async createOffer(offer) {
            return offer;
        },
    };
    await withScenario({ repository, config: { requireWalletSignature: false } }, async () => {
        const response = await request(app)
            .post('/api/post-offer')
            .send({ prosumerId: SELLER, energyAmountKWh: 10, hbarPerKWh: 0.5 });
        assert.equal(response.status, 201);
    });
});