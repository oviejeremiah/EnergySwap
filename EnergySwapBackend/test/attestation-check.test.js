const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { attestationError } = require('../attestation-check');
const { verifyMeterReading, normalizeReading, canonicalizeReading } = require('../oracle-attestation');

// Why the reported HCS transaction is not, by itself, evidence of anything.
//
// The meter topic has no submit key. Any Hedera account can submit to it. The
// settlement route used to accept an `hcsTransactionId` on the strength of the
// transaction having succeeded - which says nothing about what it carried. An
// attacker could submit a message of their own, get a successful transaction id,
// and report it: the reading would be marked attested and its audit trail would
// point at an unrelated message.
//
// So the message is read back from the topic and has to be this reading's
// attestation, signed by the gateway's attestation key. Two things are checked,
// and both are necessary:
//
//   1. The message names this reading. Without it, a genuine attestation of a
//      different reading could be reported here.
//   2. The signature in the message verifies against the canonicalised reading
//      with the configured gateway public key. Without it, anyone could write
//      {"readingId": "..."} and be believed.
//
// Checking only the first is the obvious half-fix and it is forgeable by anyone
// who can post to the topic. Checking only the second requires knowing which
// reading was signed, which is the first check.

// The reading shape the attestation layer actually accepts, taken from the
// schema in oracle-attestation.js rather than invented: schemaVersion 2, kWh in
// hundredths to match HTS token precision, and a half-open [start,end) interval.
const INTERVAL_END = new Date('2026-10-14T10:00:00.000Z');

const READING = {
    schemaVersion: 2,
    readingId: 'gateway-e2e-1',
    meterId: 'meter-gateway-1',
    prosumerId: '0.0.6242449',
    kwhGenerated: 12.5,
    readingTimestamp: INTERVAL_END.toISOString(),
    intervalStart: new Date(INTERVAL_END.getTime() - 3600_000).toISOString(),
    intervalEnd: INTERVAL_END.toISOString(),
    intervalConvention: '[start,end)',
};

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function sign(reading) {
    return crypto
        .sign(null, Buffer.from(canonicalizeReading(normalizeReading(reading))), privateKey)
        .toString('base64');
}

function messageFor(reading, over = {}) {
    return JSON.stringify({
        readingId: reading.readingId,
        signature: sign(reading),
        tokenId: '0.0.6241546',
        network: 'testnet',
        ...over,
    });
}

const ctx = { reading: READING, publicKeyPem: PUBLIC_KEY_PEM };

test('a genuine attestation of this reading is accepted', () => {
    assert.equal(attestationError(messageFor(READING), ctx), null);
});

test('a message that is not this reading is refused', () => {
    const other = { ...READING, readingId: 'gateway-e2e-2', meterId: 'meter-8' };

    const reason = attestationError(messageFor(other), ctx);

    assert.match(reason, /does not name this reading/);
});

test('a message naming this reading but signed by nobody trusted is refused', () => {
    // The half-fix that looks sufficient: it names the right reading, but the
    // signature is meaningless. Anyone able to post to the topic could write
    // exactly this.
    const forged = JSON.stringify({
        readingId: READING.readingId,
        signature: Buffer.from('not a signature at all').toString('base64'),
        tokenId: '0.0.6241546',
    });

    assert.match(attestationError(forged, ctx), /not signed by the gateway/);
});

test('a correctly signed attestation of a different reading is refused', () => {
    // The signature is valid - it is the gateway's own key - but it attests
    // something else. Without the readingId check this would be accepted.
    const other = { ...READING, readingId: 'gateway-e2e-2' };

    assert.match(attestationError(messageFor(other), ctx), /does not name this reading/);
});

test('a message naming the reading but attesting different energy is refused', () => {
    // Names this reading, but the signature covers a different payload. This is
    // the substitution that only a real signature check catches: the readingId
    // alone would pass it.
    const tampered = { ...READING, kwhGenerated: 500 };
    const forged = JSON.stringify({
        readingId: READING.readingId,
        signature: sign(tampered),
        tokenId: '0.0.6241546',
    });

    assert.match(attestationError(forged, ctx), /not signed by the gateway/);
});

test('text that is not JSON is refused rather than guessed at', () => {
    assert.ok(attestationError('this is just a message on the topic', ctx));
    assert.ok(attestationError('', ctx));
    assert.ok(attestationError(null, ctx));
    assert.ok(attestationError(undefined, ctx));
});

test('JSON that is not an attestation is refused', () => {
    for (const body of ['[]', '"a string"', '42', 'null', '{"unrelated":true}', '{}']) {
        assert.ok(attestationError(body, ctx), `expected a refusal for ${body}`);
    }
});

test('an empty or missing signature is refused', () => {
    for (const signature of ['', null, undefined]) {
        const body = JSON.stringify({ readingId: READING.readingId, signature });
        assert.ok(attestationError(body, ctx), `expected a refusal for signature ${JSON.stringify(signature)}`);
    }
});

test('a signature in the wrong encoding is refused, not coerced', () => {
    // A base64 field holding hex, or vice versa, must fail rather than be
    // massaged into something that verifies.
    const valid = sign(READING);
    const asHex = Buffer.from(valid, 'base64').toString('hex');

    assert.ok(attestationError(JSON.stringify({ readingId: READING.readingId, signature: asHex }), ctx));
});

test('no configured gateway key means nothing can be verified, so nothing passes', () => {
    // Without a key there is no way to tell the gateway from anyone else, so
    // the only safe answer is to refuse.
    const reason = attestationError(messageFor(READING), { reading: READING, publicKeyPem: '' });

    assert.match(reason, /no gateway public key/i);
});

test('every refusal says what was wrong', () => {
    const reasons = [
        attestationError('not json', ctx),
        attestationError('{}', ctx),
        attestationError(JSON.stringify({ readingId: 'other', signature: sign(READING) }), ctx),
        attestationError(JSON.stringify({ readingId: READING.readingId, signature: 'nope' }), ctx),
        attestationError(messageFor(READING), { reading: READING, publicKeyPem: '' }),
    ];

    for (const reason of reasons) {
        assert.ok(reason, 'each of these must be refused');
        assert.ok(reason.length > 15, `reason too terse to act on: ${reason}`);
    }
});

test('the signature covers the reading as normalised, not as submitted', () => {
    // The gateway signs the canonicalised form, so a reading carrying extra
    // fields still verifies - the signature was made over the normalised subset.
    const signature = sign({ ...READING, extraField: 'ignored' });
    const body = JSON.stringify({ readingId: READING.readingId, signature, extraField: 'ignored' });

    assert.equal(attestationError(body, ctx), null);
});