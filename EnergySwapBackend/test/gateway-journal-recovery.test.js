const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// These tests drive the REAL gateway module.
//
// `gateway-journal.test.js` re-implements append / read / compact locally and
// tests those re-implementations; it never requires `gateway/gateway.js`. Proof
// that it proves nothing: delete gateway/gateway.js entirely and that file still
// passes 10/10. The journal is the gateway's only memory across a crash, so the
// code that reads it has to be covered by a test that actually loads it.
//
// The module reads its journal path at import time, so it must be pointed at a
// scratch file before it is required.
// ─────────────────────────────────────────────────────────────────────────────

let dir;
let journalPath;
let recover;

test.before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'energyswap-gateway-real-'));
    journalPath = path.join(dir, 'journal.jsonl');
    process.env.GATEWAY_JOURNAL_PATH = journalPath;
    // `recover` only needs the journal and the API; the Hedera client is unused.
    ({ recover } = require('../gateway/gateway'));
});

test.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GATEWAY_JOURNAL_PATH;
});

const CONFIG = { network: 'testnet' };

const seed = (...entries) => fs.writeFileSync(journalPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
const readLines = () =>
    fs
        .readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

/**
 * Capture the settlement reports recover() makes, and the console noise it makes.
 *
 * `handler` returns the JSON body to answer with; returning `{ fail: true }`
 * produces the non-2xx response `apiPost` turns into a thrown error, which is
 * how a still-failing API looks to the gateway.
 */
async function withStubbedApi(handler = () => ({})) {
    const priorFetch = global.fetch;
    const priorLog = console.log;
    const reports = [];
    const logs = [];
    global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const pathname = new URL(url).pathname;
        reports.push({ pathname, body });
        const payload = handler({ pathname, body }) || {};
        if (payload.fail) {
            return { ok: false, status: 503, text: async () => JSON.stringify({ message: payload.message }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    console.log = (message) => logs.push(message);
    try {
        await recover(CONFIG, {});
    } finally {
        global.fetch = priorFetch;
        console.log = priorLog;
    }
    return { reports, logs };
}

test('a re-appended reading is re-reported once, with its transaction IDs, and is not flagged as interrupted', async () => {
    // This is the F6 crash: intent is journalled, the chain settles, the IDs are
    // appended, then the process dies before the API is told.
    //
    // Read naively the journal contains two lines for r-1. The first has null
    // IDs, so it looks like an interrupted settlement - and an operator is told
    // to go and check energy that had in fact been credited. Collapsing by
    // readingId, last occurrence winning, is what prevents that.
    seed(
        { readingId: 'r-1', hcsTransactionId: null, htsTransactionId: null, startedAt: 't0' },
        { readingId: 'r-1', hcsTransactionId: '0.0.9@1.1', htsTransactionId: '0.0.9@1.2', startedAt: 't0' },
    );

    const { reports, logs } = await withStubbedApi();

    assert.equal(reports.length, 1, 'a re-appended reading must be reported exactly once');
    assert.equal(reports[0].pathname, '/api/oracle/readings/r-1/settlement');
    assert.equal(reports[0].body.hcsTransactionId, '0.0.9@1.1');
    assert.equal(reports[0].body.htsTransactionId, '0.0.9@1.2');
    assert.ok(
        !logs.some((line) => /interrupted mid-settlement/.test(line)),
        `a settled reading must not be reported as interrupted: ${JSON.stringify(logs)}`,
    );
    assert.deepEqual(readLines(), [], 'a recovered reading is compacted out of the journal');
});

test('a genuinely interrupted reading is surfaced and not silently dropped', async () => {
    seed({ readingId: 'r-2', hcsTransactionId: null, htsTransactionId: null, startedAt: 't0' });

    const { reports, logs } = await withStubbedApi();

    assert.equal(reports.length, 0, 'an unsettled reading must not be reported as settled');
    assert.ok(
        logs.some((line) => /interrupted mid-settlement/.test(line)),
        'an operator must be told about it rather than it being forgotten',
    );
    assert.equal(readLines().length, 1, 'it stays in the journal until an operator deals with it');
});

test('recovering one reading does not lose another that is still pending', async () => {
    seed(
        { readingId: 'keep-1', hcsTransactionId: 'a1', htsTransactionId: 'b1', startedAt: 't0' },
        { readingId: 'keep-2', hcsTransactionId: 'a2', htsTransactionId: 'b2', startedAt: 't0' },
    );

    const { reports, logs } = await withStubbedApi(({ body }) =>
        body.hcsTransactionId === 'a1' ? { fail: true, message: 'API unavailable' } : { success: true },
    );

    assert.equal(reports.length, 2, 'both pending readings are attempted');
    assert.ok(
        logs.some((line) => /could not finalise keep-1/.test(line)),
        'a reading the API still refuses must be reported as unfinalised',
    );
    const remaining = readLines().map((e) => e.readingId);
    assert.deepEqual(remaining, ['keep-1'], 'only the one the API accepted is compacted away');
});

test('a corrupt line does not destroy the readable entries', async () => {
    seed({ readingId: 'r-3', hcsTransactionId: 'a', htsTransactionId: 'b', startedAt: 't0' });
    fs.appendFileSync(journalPath, '{ not json at all\n', 'utf8');

    const { reports } = await withStubbedApi();

    assert.equal(reports.length, 1);
    assert.equal(reports[0].body.hcsTransactionId, 'a');
});

test('COMPACTION IS ATOMIC: the journal file is never rewritten in place', async () => {
    // A crash part-way through an in-place rewrite leaves a truncated journal,
    // destroying pending entries for other readings - the exact failure the
    // temp-file-plus-rename change was meant to prevent. Assert the mechanism:
    // while compacting, writes go to a sibling temp file and only a rename
    // touches the real journal.
    seed({ readingId: 'r-4', hcsTransactionId: 'a', htsTransactionId: 'b', startedAt: 't0' });

    const written = [];
    const renamed = [];
    const priorWrite = fs.writeFileSync;
    const priorRename = fs.renameSync;
    fs.writeFileSync = (target, ...rest) => {
        written.push(String(target));
        return priorWrite(target, ...rest);
    };
    fs.renameSync = (from, to) => {
        renamed.push([String(from), String(to)]);
        return priorRename(from, to);
    };
    try {
        await withStubbedApi();
    } finally {
        fs.writeFileSync = priorWrite;
        fs.renameSync = priorRename;
    }

    assert.ok(
        !written.includes(journalPath),
        `compaction wrote the journal in place, which is not atomic: ${JSON.stringify(written)}`,
    );
    assert.ok(
        renamed.some(([from, to]) => from === `${journalPath}.tmp` && to === journalPath),
        `compaction must finish with an atomic rename: ${JSON.stringify(renamed)}`,
    );
    assert.ok(!fs.existsSync(`${journalPath}.tmp`), 'the temp file must not be left behind');
});

test('COMPACTION IS ALL-OR-NOTHING: a crash during it leaves the journal intact', async () => {
    seed(
        { readingId: 'crash-keep', hcsTransactionId: 'a', htsTransactionId: 'b', startedAt: 't0' },
        { readingId: 'crash-done', hcsTransactionId: 'c', htsTransactionId: 'd', startedAt: 't0' },
    );

    const priorRename = fs.renameSync;
    fs.renameSync = () => {
        throw new Error('simulated crash during compaction');
    };
    try {
        await assert.rejects(withStubbedApi(), /simulated crash/);
    } finally {
        fs.renameSync = priorRename;
    }

    // Whatever was pending before the crash must still be there afterwards. With
    // an in-place rewrite the file would already have been truncated.
    const survivors = readLines().map((e) => e.readingId).sort();
    assert.deepEqual(
        survivors,
        ['crash-done', 'crash-keep'],
        'a crash mid-compaction must not destroy entries that were still pending',
    );
});

test('an empty journal is a no-op, not an error', async () => {
    seed();
    const { reports, logs } = await withStubbedApi();
    assert.equal(reports.length, 0);
    assert.ok(logs.some((line) => /Nothing to recover/.test(line)));
});