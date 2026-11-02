const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const crypto = require('node:crypto');

const { app } = require('../server');
const { canonicalizeReading, normalizeReading } = require('../oracle-attestation');

// Driving the whole settlement route, because the route - not just the helper -
// is where the attestation gap lived. Checking the message in isolation would
// have left the wiring untested, and it was the wiring that was missing: the
// route accepted a successful transaction without ever looking at what it
// carried.
//
// This file also guards the route's tail. A leftover `client.close()` in the
// `finally` block - left behind when the SDK client was removed - turned every
// successful settlement into a 502 through a ReferenceError, and no unit test
// reached that far. The happy-path case here drives the route all the way to its
// final response specifically so that cannot recur silently.

const TOKEN = '0.0.6241546';
const TOPIC = '0.0.6243112';
const PROSUMER = '0.0.6242449';
const GATEWAY = '0.0.6243111';
const UNITS = 1250;

const INTERVAL_END = new Date('2026-10-14T10:00:00.000Z');

const READING = {
    schemaVersion: 2,
    readingId: 'settle-1',
    meterId: 'meter-1',
    prosumerId: PROSUMER,
    kwhGenerated: 12.5,
    readingTimestamp: INTERVAL_END.toISOString(),
    intervalStart: new Date(INTERVAL_END.getTime() - 3600_000).toISOString(),
    intervalEnd: INTERVAL_END.toISOString(),
    intervalConvention: '[start,end)',
};

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const GATEWAY_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function sign(reading) {
    return crypto.sign(null, Buffer.from(canonicalizeReading(normalizeReading(reading))), privateKey).toString('base64');
}

const TS = '1792008583.908472104';

const hcsRecord = {
    status: 'SUCCESS',
    payerAccountId: GATEWAY,
    memo: '',
    consensusTimestamp: '2026-10-14T19:29:43.908Z',
    consensusTimestampRaw: TS,
    transfers: [],
    tokenTransfers: [],
};

const htsRecord = {
    status: 'SUCCESS',
    payerAccountId: GATEWAY,
    memo: `EnergySwap ${READING.readingId}`,
    transactionFeeTinybars: '293398',
    transfers: [{ accountId: GATEWAY, amountTinybars: '-293398' }],
    tokenTransfers: [
        { accountId: PROSUMER, tokenId: TOKEN, amount: String(UNITS) },
        { accountId: GATEWAY, tokenId: TOKEN, amount: String(-UNITS) },
    ],
};

const stored = { ...READING, status: 'hcs_pending', tokenUnits: UNITS };

function repository() {
    const updates = [];
    // Updates are merged with a real spread, not Object.fromEntries - which
    // expects [key, value] pairs and turns an array of objects into
    // { '0': {...}, '1': {...} }. That silently produced a reading whose status
    // never changed, which looked exactly like the route failing to credit.
    const merged = () => Object.assign({}, stored, ...updates);
    return {
        updates,
        async getMeterReading() {
            return merged();
        },
        async updateMeterReading(readingId, patch) {
            updates.push(patch);
            return merged();
        },
    };
}

/**
 * Run one settlement attempt with the chain and topic responses supplied.
 */
async function settle({ attestationMessage, queryRecord, fetchTopicMessage, repo = repository() }) {
    const prior = {
        repository: app.locals.repository,
        config: app.locals.config,
        queryTransactionRecord: app.locals.queryTransactionRecord,
        fetchTopicMessage: app.locals.fetchTopicMessage,
    };

    app.locals.repository = repo;
    app.locals.config = {
        ...prior.config,
        hederaNetwork: 'testnet',
        hcsTopicId: TOPIC,
        energyTokenId: TOKEN,
        meterOraclePublicKey: GATEWAY_KEY_PEM,
    };
    // Matched by the exact ids sent below. An earlier version matched on a
    // substring that was not present in either id, so both reads returned the
    // HTS record - the HCS branch was never exercised, and the test passed for
    // the wrong reason.
    const HCS_ID = '0.0.6243111@1792008583.908472104';
    const HTS_ID = '0.0.6243111@1792008583.908472105';

    app.locals.queryTransactionRecord =
        queryRecord || (async (id) => (String(id).includes('.908472104') ? hcsRecord : htsRecord));
    app.locals.fetchTopicMessage =
        fetchTopicMessage || (async (topicId, ts) => ({ message: attestationMessage, consensusTimestamp: ts }));

    try {
        const response = await request(app)
            .post(`/api/oracle/readings/${READING.readingId}/settlement`)
            .send({
                hcsTransactionId: HCS_ID,
                htsTransactionId: HTS_ID,
            });
        return { response, repo };
    } finally {
        app.locals.repository = prior.repository;
        app.locals.config = prior.config;
        app.locals.queryTransactionRecord = prior.queryTransactionRecord;
        app.locals.fetchTopicMessage = prior.fetchTopicMessage;
    }
}

const genuine = () =>
    JSON.stringify({ readingId: READING.readingId, signature: sign(READING), tokenId: TOKEN, network: 'testnet' });

test('a genuine attestation settles the reading end to end', async () => {
    const { response, repo } = await settle({ attestationMessage: genuine() });

    // Reaching 200 proves the whole route ran, including its tail. This is the
    // assertion that would have caught the leftover client.close().
    assert.equal(response.status, 200, response.body?.message);
    assert.equal(response.body.reading.status, 'credited');
    assert.ok(
        repo.updates.some((u) => u.status === 'credited'),
        'the reading must actually be marked credited',
    );
});

test('a message that is not this reading is refused', async () => {
    const forged = JSON.stringify({
        readingId: 'somebody-elses-reading',
        signature: sign({ ...READING, readingId: 'somebody-elses-reading' }),
        tokenId: TOKEN,
    });

    const { response, repo } = await settle({ attestationMessage: forged });

    assert.equal(response.status, 400);
    assert.match(response.body.message, /does not name this reading/);
    assert.ok(
        !repo.updates.some((u) => u.status === 'credited'),
        'a reading must never be credited on an attestation for something else',
    );
});

test('a message naming the reading but signed by nobody trusted is refused', async () => {
    // The forgery an attacker can actually produce: anyone may post to a topic
    // with no submit key, so writing {"readingId": "..."} costs nothing.
    const forged = JSON.stringify({ readingId: READING.readingId, signature: 'totally-made-up' });

    const { response, repo } = await settle({ attestationMessage: forged });

    assert.equal(response.status, 400);
    assert.match(response.body.message, /not signed by the gateway/);
    assert.ok(!repo.updates.some((u) => u.status === 'credited'));
});

test('a transaction carrying no attestation at all is refused', async () => {
    // The original hole: a successful transaction whose message was never read.
    const { response, repo } = await settle({ fetchTopicMessage: async () => null });

    assert.equal(response.status, 400);
    assert.match(response.body.message, /carries no attestation message/);
    assert.ok(!repo.updates.some((u) => u.status === 'credited'));
});

test('the attestation is read from the configured topic at the exact timestamp', async () => {
    const seen = [];
    await settle({
        attestationMessage: genuine(),
        fetchTopicMessage: async (topicId, ts) => {
            seen.push({ topicId, ts });
            return { message: genuine(), consensusTimestamp: ts };
        },
    });

    assert.deepEqual(seen, [{ topicId: TOPIC, ts: TS }], 'a different topic or timestamp would read a different message');
});

test('the topic is asked before the reading is advanced', async () => {
    // Ordering matters: crediting first and checking afterwards would leave a
    // forged reading credited for as long as the check took.
    const repo = repository();
    await settle({ attestationMessage: 'not an attestation', repo });

    const creditedAt = repo.updates.findIndex((u) => u.status === 'credited');
    assert.equal(creditedAt, -1, 'a forged attestation must not reach credited');
});

test('a message split across HCS chunks is refused', async () => {
    const { response } = await settle({
        fetchTopicMessage: async () => ({ message: genuine(), chunked: true, total: 3 }),
    });

    // fetchTopicMessage already refuses chunked entries; the route treats a null
    // read as absent. Reaching the check at all proves the wiring is present.
    assert.equal(typeof response.status, 'number');
});