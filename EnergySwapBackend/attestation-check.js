const { canonicalizeReading, verifyMeterReading } = require('./oracle-attestation');

/**
 * Deciding whether a consensus message is this reading's attestation.
 *
 * ## The hole this closes
 *
 * The meter HCS topic has no submit key. Any Hedera account can post to it. The
 * settlement route used to accept a reported `hcsTransactionId` on the strength
 * of the transaction having succeeded, which says nothing about what it carried.
 * An attacker could post a message of their own, take the resulting successful
 * transaction id, and report it: the reading would be marked attested, and its
 * audit trail - the transaction id and consensus timestamp - would point at an
 * unrelated message. That record is what an auditor would later rely on.
 *
 * Reading the message back is what makes it evidence again.
 *
 * ## Why both checks are needed
 *
 * The message must name this reading, and the signature in it must verify
 * against the canonicalised reading with the configured gateway public key.
 *
 * The first alone is forgeable by anyone who can post to the topic: write
 * `{"readingId": "..."}` and it names any reading you like. The second alone
 * proves something was signed but not what - so the readingId tells it which
 * reading to verify against, and the signature proves the gateway signed it.
 *
 * Either alone leaves the route open. Both together mean a forged message would
 * need the gateway's private key.
 *
 * @param {string|null} messageText the decoded consensus message.
 * @param {{reading: object, publicKeyPem: string}} ctx
 * @returns {string|null} why it is not the attestation, or null when it is.
 */
function attestationError(messageText, { reading, publicKeyPem }) {
    // Without a key there is no way to tell the gateway from anyone else, so
    // the only safe answer is to refuse. This fails closed rather than treating
    // an unconfigured deployment as one where anything is acceptable.
    if (typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) {
        return 'No gateway public key is configured, so no attestation can be verified.';
    }

    if (typeof messageText !== 'string' || !messageText.trim()) {
        return 'The reported HCS transaction carried no attestation message.';
    }

    let payload;
    try {
        payload = JSON.parse(messageText);
    } catch {
        // A message that is not JSON is not an attestation. Guessing at it would
        // mean verifying a payload nobody signed.
        return 'The HCS message is not a valid attestation.';
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return 'The HCS message is not a valid attestation.';
    }

    // Checked before the signature: the readingId decides which reading the
    // signature is verified against, so a message about a different reading can
    // never pass a signature check for this one.
    if (payload.readingId !== reading?.readingId) {
        return 'The HCS message does not name this reading.';
    }

    if (!verifyMeterReading(reading, payload.signature, publicKeyPem)) {
        return 'The attestation is not signed by the gateway for this reading.';
    }

    return null;
}

module.exports = { attestationError, canonicalizeReading };