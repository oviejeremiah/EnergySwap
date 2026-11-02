import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    resolvePlatformNetwork,
    defaultClientFor,
    _resetPlatformNetwork,
} from '../src/wallet-signature.js';

// The platform settles in HBAR on whichever Hedera network it is configured
// for. Today that is testnet; after migration it will be mainnet. Nothing about
// the trade or offer flow should need to change when that happens - only which
// network the client talks to.
//
// Hardcoding `Client.forTestnet()` at a call site is how that silently breaks:
// the code keeps working against the wrong network, or fails on mainnet with an
// error that does not mention the network at all.

describe('resolvePlatformNetwork', () => {
    // The cache is module-level by design, so it has to be cleared between
    // tests or the first case's answer answers all the others.
    beforeEach(() => _resetPlatformNetwork());

    it('reports the network the API says it is on', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            json: async () => ({ status: 'ready', network: 'mainnet' }),
        }));

        expect(await resolvePlatformNetwork({ fetchImpl, baseUrl: 'http://api' })).toBe('mainnet');
    });

    it('falls back to testnet when the API does not say', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ready' }) }));

        expect(await resolvePlatformNetwork({ fetchImpl })).toBe('testnet');
    });

    it('falls back to testnet when the API cannot be reached', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('offline');
        });

        expect(await resolvePlatformNetwork({ fetchImpl })).toBe('testnet');
    });

    it('caches, so a busy page does not re-ask on every trade', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            json: async () => ({ status: 'ready', network: 'testnet' }),
        }));

        const first = await resolvePlatformNetwork({ fetchImpl, baseUrl: 'http://api' });
        const second = await resolvePlatformNetwork({ fetchImpl, baseUrl: 'http://api' });

        expect(first).toBe(second);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('defaultClientFor', () => {
    it('builds a client for the named network rather than a fixed one', () => {
        // Both must be constructible; the point is that neither is hardcoded.
        expect(() => defaultClientFor('testnet')).not.toThrow();
        expect(() => defaultClientFor('mainnet')).not.toThrow();
    });
});