// Wait for an installed browser-wallet extension to announce itself.
//
// `DAppConnector` discovers extensions with a one-shot postMessage ping fired
// 200 ms after construction (see @hashgraph/hedera-wallet-connect
// `lib/shared/extensionController.js` -> `findExtensions`). An MV3 extension
// like HashPack whose service worker is asleep can reply later than the
// WalletConnect relay handshake that `init()` performs, so a snap decision
// taken right after init wrongly reports "HashPack is required" on the first
// connect click.
//
// This helper polls the extension list for a bounded time, re-pinging each
// interval so a sleeping(ish) extension wakes up and identifies itself. It
// returns the first extension with `available: true`, or null if none
// appears before the deadline.

export const findAvailableExtension = async ({
    connector,
    timeoutMs = 4000,
    intervalMs = 400,
    query,
} = {}) => {
    const sendQuery = query || (() => {
        if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
            // Target origin '*' is deliberate and mirrors the upstream protocol:
            // `hedera-extension-query` pings are how this dApp discovers which
            // wallets are installed (see @hashgraph/hedera-wallet-connect
            // `shared/extensionController.js -> extensionQuery`, which sends
            // with '*' too). The packet names nothing and carries no secret;
            // extension content scripts reply to it from their own origins.
            // Static scanners flag this pattern; the risk is disclosure of a
            // known public constant.
            window.postMessage({ type: 'hedera-extension-query' }, '*');
        }
    });

    const deadline = Date.now() + timeoutMs;
    sendQuery();

    let last = null;
    while (Date.now() < deadline) {
        last = connector?.extensions?.find?.((e) => e && e.available);
        if (last) return last;

        const wait = Math.min(intervalMs, Math.max(50, deadline - Date.now()));
        await new Promise((resolve) => setTimeout(resolve, wait));
        sendQuery();
    }

    // Final check in case the answer arrived during the last interval.
    return connector?.extensions?.find?.((e) => e && e.available) || null;
};
