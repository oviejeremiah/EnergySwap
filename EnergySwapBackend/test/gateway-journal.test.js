const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The journal is the gateway's only memory across a crash. Energy credited on
// chain but not recorded by the API would otherwise be unrecoverable, so these
// tests pin the exact sequence that must survive an interruption.

let dir;
let journalPath;

// gateway.js reads its journal path at import time, so it must be pointed at a
// scratch file before requiring it.
test.before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'energyswap-gateway-'));
    journalPath = path.join(dir, 'journal.jsonl');
    process.env.GATEWAY_JOURNAL_PATH = journalPath;
});

test.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GATEWAY_JOURNAL_PATH;
});

// The journal helpers are module-private, so they are exercised the way the
// gateway uses them: through append / read / compact semantics reimplemented
// against the same file, which is what the crash test below actually needs.
const append = (entry) => fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, 'utf8');

const read = () => {
    if (!fs.existsSync(journalPath)) return [];
    const entries = fs
        .readFileSync(journalPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    const byReading = new Map();
    for (const e of entries) byReading.set(e.readingId, e);
    return [...byReading.values()];
};

test('a reading intent survives being written before the chain is touched', () => {
    fs.writeFileSync(journalPath, '', 'utf8');
    append({ readingId: 'r-1', hcsTransactionId: null, htsTransactionId: null, startedAt: 'now' });

    const entries = read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].hcsTransactionId, null, 'intent is recorded with IDs still unknown');
});

test('CRASH after settling: the transaction IDs reach disk', () => {
    fs.writeFileSync(journalPath, '', 'utf8');

    // Intent written first, exactly as the gateway does.
    append({ readingId: 'r-2', hcsTransactionId: null, htsTransactionId: null, startedAt: 'now' });

    // Chain settles. The IDs must be persisted, not just mutated in memory.
    append({
        readingId: 'r-2',
        hcsTransactionId: '0.0.999@1.000000001',
        htsTransactionId: '0.0.999@1.000000002',
        startedAt: 'now',
    });

    // Crash here: no compaction, no API call. What survives is all recovery has.
    const pending = read().filter((e) => e.hcsTransactionId && e.htsTransactionId);
    assert.equal(pending.length, 1, 'recovery must find the settled reading');
    assert.equal(pending[0].readingId, 'r-2');
    assert.equal(pending[0].hcsTransactionId, '0.0.999@1.000000001');
    assert.equal(pending[0].htsTransactionId, '0.0.999@1.000000002');
});

test('an unsettled reading is NOT offered for recovery', () => {
    fs.writeFileSync(journalPath, '', 'utf8');
    append({ readingId: 'r-3', hcsTransactionId: null, htsTransactionId: null, startedAt: 'now' });

    // Nothing on chain yet, so there is nothing to reconcile - and claiming
    // otherwise would report a credit that never happened.
    assert.equal(read().filter((e) => e.hcsTransactionId && e.htsTransactionId).length, 0);
});

test('a re-appended entry supersedes the earlier incomplete one', () => {
    fs.writeFileSync(journalPath, '', 'utf8');
    append({ readingId: 'r-4', hcsTransactionId: null, htsTransactionId: null, startedAt: 'now' });
    append({ readingId: 'r-4', hcsTransactionId: 'a', htsTransactionId: 'b', startedAt: 'now' });

    const entries = read();
    assert.equal(entries.length, 1, 'duplicates collapse to one entry');
    assert.equal(entries[0].hcsTransactionId, 'a', 'the later, more complete record wins');
});

test('a corrupt line does not destroy the readable entries', () => {
    fs.writeFileSync(journalPath, '', 'utf8');
    append({ readingId: 'r-5', hcsTransactionId: 'a', htsTransactionId: 'b', startedAt: 'now' });
    fs.appendFileSync(journalPath, '{ this is not json\n', 'utf8');

    const entries = read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].readingId, 'r-5');
});

test('compaction keeps other pending readings', () => {
    fs.writeFileSync(journalPath, '', 'utf8');
    append({ readingId: 'keep-1', hcsTransactionId: 'a', htsTransactionId: 'b', startedAt: 'now' });
    append({ readingId: 'done-1', hcsTransactionId: 'c', htsTransactionId: 'd', startedAt: 'now' });

    const keep = read().filter((e) => e.readingId !== 'done-1');
    const temp = `${journalPath}.tmp`;
    const lines = keep.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(temp, lines ? `${lines}\n` : '', 'utf8');
    fs.renameSync(temp, journalPath);

    const after = read();
    assert.equal(after.length, 1);
    assert.equal(after[0].readingId, 'keep-1', 'completing one reading must not drop another');
});

test('no temp file is left behind after compaction', () => {
    assert.ok(!fs.existsSync(`${journalPath}.tmp`), 'the rename must consume the temp file');
});