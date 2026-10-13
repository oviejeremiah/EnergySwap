import { describe, it, expect, vi } from 'vitest';
import { signChallenge, SignatureError } from '../src/wallet-signature.js';

// Offer posting is the only write endpoint that does not move money, and it is
// also the only one that is currently unauthenticated: anyone can post an offer
// claiming any Hedera account as the producer. The backend already enforces a
// signature when REQUIRE_WALLET_SIGNATURE is on - what is missing is the client
// half. These tests pin that client half.
//
// The signature has to come from the Hedera wallet itself. The alternative -
// pasting a private key into a web form - is not acceptable, so the flow is
// built on the wallet signer the app already has.

const ACCOUNT = '0.0.12345';

function fakeSigner(signature = 'BASE64SIGNATURE') {
    return {
        getAccountId: () => ({ toString: () => ACCOUNT }),
        sign: vi.fn(async () => [{ signature, accountId: ACCOUNT }]),
    };
}

function jsonResponse(body, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => body,
    };
}

describe('signChallenge', () => {
    it('requests a challenge and returns the nonce with the wallet signature', async () => {
        const signer = fakeSigner('SIG123');
        const fetchImpl = vi.fn(async (url) => {
            expect(url).toContain('/api/wallet-auth/challenge');
            expect(url).toContain(ACCOUNT);
            return jsonResponse({
                success: true,
                nonce: 'nonce-abc',
                message: 'EnergySwap|auth|testnet|0.0.12345|nonce-abc|1|2',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            });
        });

        const result = await signChallenge({ accountId: ACCOUNT, signer, fetchImpl });

        expect(result.challengeNonce).toBe('nonce-abc');
        expect(result.challengeSignature).toBe('SIG123');
    });

    it('signs the exact message the server issued', async () => {
        const message = 'EnergySwap|auth|testnet|0.0.12345|nonce-abc|1|2';
        const signer = fakeSigner();
        const fetchImpl = vi.fn(async () => jsonResponse({ success: true, nonce: 'n', message }));

        await signChallenge({ accountId: ACCOUNT, signer, fetchImpl });

        // Signing a reformatted or re-derived message would produce a signature
        // the backend cannot verify, and the failure would look like an
        // authentication problem rather than a message mismatch.
        expect(signer.sign).toHaveBeenCalledTimes(1);
        const signed = signer.sign.mock.calls[0][0];
        expect(signed).toHaveLength(1);
        expect(new TextDecoder().decode(signed[0])).toBe(message);
    });

    it('refuses when the signer belongs to a different account', async () => {
        // Signing with the wrong connected account would produce a signature the
        // server rejects, but only after the user had approved a prompt that
        // looked legitimate. Failing here makes the cause obvious.
        const signer = fakeSigner();
        signer.getAccountId = () => ({ toString: () => '0.0.99999' });

        const fetchImpl = vi.fn(async () => jsonResponse({ success: true, nonce: 'n', message: 'm' }));

        await expect(signChallenge({ accountId: ACCOUNT, signer, fetchImpl })).rejects.toBeInstanceOf(
            SignatureError,
        );
        expect(signer.sign).not.toHaveBeenCalled();
    });

    it('refuses when the challenge response is missing a nonce', async () => {
        const signer = fakeSigner();
        const fetchImpl = vi.fn(async () => jsonResponse({ success: true, message: 'm' }));

        await expect(signChallenge({ accountId: ACCOUNT, signer, fetchImpl })).rejects.toBeInstanceOf(
            SignatureError,
        );
        expect(signer.sign).not.toHaveBeenCalled();
    });

    it('refuses when the challenge response is missing a message', async () => {
        const signer = fakeSigner();
        const fetchImpl = vi.fn(async () => jsonResponse({ success: true, nonce: 'n' }));

        await expect(signChallenge({ accountId: ACCOUNT, signer, fetchImpl })).rejects.toBeInstanceOf(
            SignatureError,
        );
    });

    it('surfaces a rejected challenge request from the server', async () => {
        const signer = fakeSigner();
        const fetchImpl = vi.fn(async () => jsonResponse({ success: false, message: 'not allowed' }, false, 400));

        await expect(signChallenge({ accountId: ACCOUNT, signer, fetchImpl })).rejects.toThrow(/not allowed/);
        expect(signer.sign).not.toHaveBeenCalled();
    });

    it('surfaces a user rejecting the wallet prompt', async () => {
        const signer = fakeSigner();
        signer.sign = vi.fn(async () => {
            throw new Error('User rejected the request');
        });
        const fetchImpl = vi.fn(async () => jsonResponse({ success: true, nonce: 'n', message: 'm' }));

        await expect(signChallenge({ accountId: ACCOUNT, signer, fetchImpl })).rejects.toThrow(
            /User rejected/,
        );
    });

    it('reports a signer that returns no signature at all', async () => {
        // A wallet that resolves without throwing but signs nothing would
        // otherwise send an empty string and produce an opaque 500.
        const signer = fakeSigner();
        signer.sign = vi.fn(async () => []);
        const fetchImpl = vi.fn(async () => jsonResponse({ success: true, nonce: 'n', message: 'm' }));

        await expect(signChallenge({ accountId: ACCOUNT, signer, fetchImpl })).rejects.toThrow(
            /did not return a signature/,
        );
    });

    it('encodes the message as UTF-8 bytes', async () => {
        // The backend verifies against Buffer.from(message, 'utf8'). Signing
        // anything else produces a mismatch that is hard to diagnose.
        const message = 'EnergySwap|auth|testnet|0.0.12345|n|1|2|naïve';
        const signer = fakeSigner();
        const fetchImpl = vi.fn(async () => jsonResponse({ success: true, nonce: 'n', message }));

        await signChallenge({ accountId: ACCOUNT, signer, fetchImpl });

        const signed = signer.sign.mock.calls[0][0][0];
        expect(Array.from(signed)).toEqual(Array.from(new TextEncoder().encode(message)));
    });
});