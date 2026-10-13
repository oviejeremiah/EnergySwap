/**
 * Wallet signature challenge for authenticated writes.
 *
 * Offer posting is the one endpoint that does not move money, and it is the one
 * that was unauthenticated: anyone could post an offer claiming any Hedera
 * account as the producer. The backend has always been able to enforce a
 * signature (it looks the account's key up on the mirror node and verifies
 * against it) - what was missing was the client half, so REQUIRE_WALLET_SIGNATURE
 * could never be switched on without breaking every user.
 *
 * The signature must come from the Hedera wallet itself, via the HIP-32
 * `signer.sign()` the app already uses for transactions. Pasting a private key
 * into a web form is not an acceptable alternative, so this module never sees
 * one.
 *
 * Signing is deliberately separated from the request that needs it: the caller
 * asks for the proof at the moment of use, so a user is never prompted to sign
 * something they have not yet chosen to do.
 */

/** Raised when the challenge cannot be obtained or signed. */
export class SignatureError extends Error {
    constructor(message, cause) {
        super(message, { cause });
        this.name = 'SignatureError';
    }
}

const encoder = new TextEncoder();

/**
 * Obtain a server-issued challenge and sign it with the Hedera wallet.
 *
 * @param {{accountId: string, signer: object, fetchImpl?: typeof fetch,
 *          baseUrl?: string}} params
 * @returns {Promise<{challengeNonce: string, challengeSignature: string}>}
 *          Fields to merge into the authenticated request body.
 * @throws {SignatureError} when the challenge cannot be fetched, signed, or the
 *         signer does not belong to the account being claimed.
 */
export async function signChallenge({ accountId, signer, fetchImpl, baseUrl = '' }) {
    if (typeof accountId !== 'string' || !accountId.trim()) {
        throw new SignatureError('A Hedera account ID is required before an offer can be signed.');
    }
    if (!signer || typeof signer.sign !== 'function') {
        throw new SignatureError('The Hedera wallet signer is unavailable, so this cannot be signed.');
    }

    // Guard the obvious mistake locally. A signature from the wrong account is
    // rejected by the server anyway, but only after the user has approved a
    // prompt that appeared to be for the right thing.
    const signerAccount = signer.getAccountId?.()?.toString?.();
    if (signerAccount && signerAccount !== accountId.trim()) {
        throw new SignatureError(
            `The connected wallet is ${signerAccount}, not ${accountId.trim()}. ` +
                'Switch accounts in the wallet before signing.',
        );
    }

    const doFetch = fetchImpl || globalThis.fetch;
    const url = `${baseUrl}/api/wallet-auth/challenge?accountId=${encodeURIComponent(accountId.trim())}`;

    let payload;
    try {
        const response = await doFetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new SignatureError(body?.message || `The API refused to issue a challenge (HTTP ${response.status}).`);
        }
        payload = await response.json();
    } catch (error) {
        if (error instanceof SignatureError) throw error;
        throw new SignatureError(`Could not reach the API to request a signature challenge: ${error.message}`, error);
    }

    const nonce = payload?.nonce;
    const message = payload?.message;
    // A response that is missing either half cannot be signed. Checking here
    // turns an opaque server-side failure into a message that names the cause.
    if (typeof nonce !== 'string' || !nonce) {
        throw new SignatureError('The API did not return a challenge nonce.');
    }
    if (typeof message !== 'string' || !message) {
        throw new SignatureError('The API did not return a challenge message to sign.');
    }

    let signatures;
    try {
        signatures = await signer.sign([encoder.encode(message)]);
    } catch (error) {
        // A user declining the wallet prompt lands here and is not an error the
        // user needs explained - surface their own words.
        throw new SignatureError(error?.message || 'The wallet did not sign the challenge.', error);
    }

    const signature = signatures?.[0]?.signature;
    if (typeof signature !== 'string' || !signature) {
        throw new SignatureError('The wallet did not return a signature for the challenge.');
    }

    return { challengeNonce: nonce, challengeSignature: signature };
}