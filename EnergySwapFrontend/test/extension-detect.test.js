import { describe, it, expect, vi } from 'vitest';
import { findAvailableExtension } from '../src/extension-detect.js';

// `connectWithRole` used to decide "HashPack is not installed" from a single
// snapshot of `dAppConnector.extensions` taken the moment WalletConnect init
// resolved. The library's `findExtensions` discovery ping fires once, 200 ms
// after the DAppConnector is constructed, and HashPack's content script (an
// MV3 service worker that sleeps) may answer too late to beat the WalletConnect
// relay handshake. With HashPack installed, the first connect click then showed
// the install prompt, and only the second click (discovery settled, module
// warm) opened the wallet popup.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeConnector = (delayUntilAvailable) => {
    const connector = { extensions: [] };
    if (delayUntilAvailable !== null) {
        const timer = setTimeout(() => {
            connector.extensions.push({ id: 'test', available: true });
        }, delayUntilAvailable);
        connector.stop = () => clearTimeout(timer);
    }
    return connector;
};

describe('findAvailableExtension', () => {
    it('returns immediately when the extension is already listed', async () => {
        const connector = { extensions: [{ id: 'test', available: true }] };
        const query = vi.fn();

        const result = await findAvailableExtension({ connector, query, timeoutMs: 2000 });

        expect(result).toEqual({ id: 'test', available: true });
        expect(query).toHaveBeenCalled();
    });

    it('recovers an extension that announces itself after init is done', async () => {
        const connector = makeConnector(700);
        const query = vi.fn();

        const result = await findAvailableExtension({ connector, query, timeoutMs: 3000, intervalMs: 200 });

        expect(result?.id).toBe('test');
        connector.stop?.();
    });

    it('returns null when no extension ever announces itself', async () => {
        const connector = { extensions: [] };
        const query = vi.fn();

        const result = await findAvailableExtension({ connector, query, timeoutMs: 600, intervalMs: 200 });

        expect(result).toBeNull();
        expect(query.mock.calls.length).toBeGreaterThan(1);
    });

    it('re-pings while waiting so a sleeping extension wakes', async () => {
        const connector = { extensions: [] };
        const query = vi.fn();

        await findAvailableExtension({ connector, query, timeoutMs: 700, intervalMs: 200 });

        // Ping fires at 0, 200, 400, 600 -> four attempts inside the window.
        expect(query.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('tolerates a connector whose extensions property is undefined', async () => {
        const query = vi.fn();
        const result = await findAvailableExtension({ connector: null, query, timeoutMs: 300, intervalMs: 100 });
        expect(result).toBeNull();
    });
});
