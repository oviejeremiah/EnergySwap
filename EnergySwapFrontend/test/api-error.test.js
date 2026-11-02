import { describe, it, expect } from 'vitest';
import { describeApiError } from '../src/api-error.js';

// The API returns a specific reason for every rejection - "Unknown or
// already-used challenge nonce", "Signature does not match the account key",
// "Signature verification failed: bad signature size". Those are the only
// things that distinguish a wrong nonce from a wrong key from a malformed
// signature.
//
// The client was discarding all of it and showing only response.statusText,
// which collapses every failure to the same word: "Unauthorized". That hid a
// signature-encoding bug behind an unhelpful message, and would hide the next
// one just as effectively.

describe('describeApiError', () => {
    it('surfaces the server message when there is one', async () => {
        const response = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                success: false,
                message: 'Wallet signature verification failed: Unknown or already-used challenge nonce.',
            }),
        };

        const result = await describeApiError(response, 'Failed to post offer');

        expect(result).toContain('Unknown or already-used challenge nonce');
        expect(result).toContain('Failed to post offer');
    });

    it('falls back to the error field when the API uses that instead', async () => {
        const response = {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ success: false, error: 'Offer already exists.' }),
        };

        const result = await describeApiError(response, 'Failed to post offer');

        expect(result).toContain('Offer already exists.');
    });

    it('still says something useful when the body is not JSON', async () => {
        const response = {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => {
                throw new Error('not json');
            },
        };

        const result = await describeApiError(response, 'Failed to post offer');

        expect(result).toContain('Failed to post offer');
        expect(result).toContain('500');
        expect(result).not.toContain('undefined');
        expect(result).not.toContain('[object');
    });

    it('still says something useful when the body is empty', async () => {
        const response = {
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({}),
        };

        const result = await describeApiError(response, 'Failed to post offer');

        expect(result).toContain('Failed to post offer');
        expect(result).toContain('403');
    });

    it('never leaks a raw object into the message', async () => {
        const response = {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ success: false, message: { nested: 'object' } }),
        };

        const result = await describeApiError(response, 'Failed to post offer');

        expect(result).not.toContain('[object Object]');
    });
});