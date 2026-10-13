/**
 * Generic wallet connector for EnergySwap ---— identity only, Hedera-agnostic.
 *
 * ---—---—--- Why this file exists ---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---
 * EnergySwap settles in HBAR, but the wallet a person signs in with does not
 * have to be the wallet that holds their HBAR. That separation is a deliberate
 * security property: if your EnergySwap login wallet holds nothing, then
 * compromising it yields an identity and no funds.
 *
 *   Identity    ---  this module. Any EIP-1193 extension or WalletConnect phone
 *                 wallet. Holds no HBAR.
 *   Settlement  ---  DAppConnector in main.js. A Hedera account holding HBAR.
 *
 * Keeping them apart is the point. Do not merge them, and do not let a wallet
 * connected here be treated as proof of control over a Hedera account.
 *
 * ---—---—--- Scope ---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---
 * EVM wallets only (ECDSA / secp256k1, keccak256 digests). Solana, Bitcoin and
 * other non-EVM wallets are intentionally out of scope: they cannot settle HBAR
 * and their signature schemes would add verification paths for no settlement
 * benefit. Hedera accounts are handled by the Hedera connector, not here.
 *
 * ---—---—--- Trust model ---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---
 * Everything a browser wallet tells us is self-reported and unverified. Flags
 * like `provider.isMetaMask` are trivially spoofed by any page or extension, so
 * they are used for *labelling only* and never for authorisation. The only
 * thing a wallet proves is control of a private key, and only via a signature
 * the backend verifies itself.
 */

// `@walletconnect/ethereum-provider` pulls in the relay client, crypto and the
// QR modal UI ---— roughly 360 kB raw (~95 kB gzipped). Most visitors will never
// pair a phone wallet, and the ones who do are often on a phone already paying
// for every kilobyte. It is therefore imported lazily: extension sign-in never
// downloads it, and the phone path fetches it on first click.
//
// ---—---—---—--- Extension discovery ---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---
//
// Everything below the WalletConnect section is dependency-free EIP-1193 and
// ships in the main bundle. Only `connectViaWalletConnect` touches the heavy package.

// --- WalletConnect project id ---
//
// REQUIRED for the phone path, and it must be your own project. Register a
// free project at https://cloud.walletconnect.com and set:
//
//   VITE_WALLETCONNECT_PROJECT_ID=<your project id>
//
// Do NOT reuse the Hedera project id (`3bb8070d3c128e28471c850ee21f3978`).
// It is domain-restricted to Hedera's own dApps: the WalletConnect wallet-list
// API answers `Forbidden` for it, and pairing silently hangs with no modal and
// no error. That failure is indistinguishable from a code bug, so it is worth
// stating plainly.
const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;

/** True when a usable WalletConnect project id has been configured. */
export const isWalletConnectConfigured = () => Boolean(WC_PROJECT_ID);

// EVM chains offered when pairing from a phone. Ordering is preference order:
// mainnet first, then the chains a Hedera user is most likely to hold a
 // bridged position on. Optional so pairing never fails just because a wallet
// only supports a subset.
// Explorer listings for the wallets we surface, fetched 2026-10-12 from
// explorer-api.walletconnect.com for eip155. Pinned explicitly so the list
// is not at the mercy of whatever the default catalogue query returns.
//
// MetaMask, Coinbase, Phantom and OKX are deliberately absent: they are
// injected browser wallets, and WalletConnect surfaces those through its own
// browser-wallet entry rather than an explorer listing.
const WC_CATALOGUE_WALLET_IDS = [
    '18388be9ac2d02726dbac9777c96efaac06d744b2f6d580fccdd4127a6d01fd1', // Rabby
    '8a0ee50d1f22f6651afcae7eb4253e52a3310b90af5daef78a8c4929a9bb99d4', // Binance Wallet
    '19177a98252e07ddfc9af2083ba8e07ef627cb6103467ffebb3f8f4205fd7927', // Ledger Wallet
    '20459438007b75f4f4acb98bf29aa3b800550309646d375da5fd4aac6c2a2c66', // TokenPocket
    'ecc4036f814562b41a5268adc86270fba1365471402006302e70169465b7ac18', // Zerion
    '16181134503608bc683a3f071b99ebc2581f134dafb350756b86fc984726dd94', // Hex Trust
    '1aedbcfc1f31aade56ca34c38b0a1607b41cccfa3de93c946ef3b4ba2dfab11c', // OneKey
    'ef333840daf915aafdc4a004525502d6d49d77bd9c65e0642dbaefb3c2893bef', // imToken
];

const WC_CHAINS = [1];
const WC_OPTIONAL_CHAINS = [8453, 137, 10, 42161, 43114];

const WC_METADATA = {
    name: 'EnergySwap',
    description: 'Peer-to-peer energy trading',
    url: typeof window !== 'undefined' ? window.location.origin : 'https://energyswap.app',
    icons: [`${typeof window !== 'undefined' ? window.location.origin : 'https://energyswap.app'}/favicon.png`],
};

/**
 * @typedef {object} WalletSession
 * @property {'extension'|'mobile'} transport  How the wallet was reached.
 * @property {string}  name       Display label. Unverified ---— for display only.
 * @property {string}  address    Address reported by the wallet. Unverified.
 * @property {number}  chainId    Numeric chain id, default 1.
 * @property {object}  provider   EIP-1193 provider, for signing.
 * @property {() => Promise<void>} disconnect
 */

// ---—---—---—--- Extension discovery ---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---

/**
 * Best-effort label for an injected EIP-1193 provider.
 *
 * Purely cosmetic. These flags are set by the wallet itself and any page can
 * spoof them, so nothing here may gate a permission check.
 */
const labelFor = (provider) => {
    if (provider.isRabby) return 'Rabby';
    if (provider.isBraveWallet) return 'Brave Wallet';
    if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
    if (provider.isTrust || provider.isTrustWallet) return 'Trust Wallet';
    if (provider.isMetaMask) return 'MetaMask';
    if (provider.isOkexWallet || provider.isOKExWallet) return 'OKX Wallet';
    if (provider.isPhantom) return 'Phantom';
    return 'Browser Wallet';
};

/**
 * Enumerate injected EIP-1193 wallets.
 *
 * Several extensions can be installed at once and they compete for the same
 * `window.ethereum` global. The convention is that the wrapper exposes a
 * `providers` array holding each one; we read that rather than trusting
 * `window.ethereum` to be the wallet the user wants.
 *
 * @returns {Array<{id: string, name: string, provider: object}>}
 */
export function detectExtensionWallets() {
    if (typeof window === 'undefined') return [];

    const injected = window.ethereum;
    if (!injected) return [];

    // `providers` is present when two or more EIP-1193 wallets are installed.
    // A single wallet leaves it undefined, so fall back to the global itself.
    const candidates =
        Array.isArray(injected.providers) && injected.providers.length
            ? injected.providers
            : [injected];

    return candidates.map((provider, index) => ({
        id: provider.uuid || `eip1193-${index}`,
        name: labelFor(provider),
        provider,
    }));
}

/** @returns {boolean} True when at least one extension wallet is available. */
export function hasExtensionWallets() {
    return detectExtensionWallets().length > 0;
}

/**
 * Ask an extension wallet to connect.
 *
 * `eth_requestAccounts` is the only call that may prompt the user, and it is
 * the wallet's job to show its own approval UI ---— never synthesise one here.
 *
 * @param {{id: string, provider: object}} wallet
 * @returns {Promise<WalletSession>}
 */
export async function connectExtension(wallet) {
    if (!wallet?.provider) throw new Error('No wallet supplied.');

    // Throws 4001 if the user rejects. Let that propagate ---— it is the normal
    // path for a declined prompt and callers should treat it as not-an-error.
    const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error('Wallet returned no accounts.');
    }

    let chainId = 1;
    try {
        chainId = Number.parseInt(await wallet.provider.request({ method: 'eth_chainId' }), 16) || 1;
    } catch {
        // Some wallets withhold eth_chainId until a wallet is unlocked. Not
        // fatal: the address is what identifies the session.
    }

    const provider = wallet.provider;
    const address = accounts[0];

    return {
        transport: 'extension',
        name: wallet.name || 'Browser Wallet',
        address,
        chainId,
        provider,
        async disconnect() {
            // EIP-1193 has no standard "disconnect"; the EIP-2255 permission
            // revocation is the closest equivalent.
            try {
                await provider.request({
                    method: 'wallet_revokePermissions',
                    params: [{ eth_accounts: {} }],
                });
            } catch {
                // Not all wallets implement it. The user can disconnect in the
                // wallet UI regardless.
            }
        },
    };
}

// ---—---—---—--- WalletConnect ---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---—---

/** @type {import('@walletconnect/universal-provider').UniversalProvider | null} */
/**
 * The AppKit instance. Created once and reused.
 *
 * WalletConnect Core is a module-level singleton; re-initialising it leaves an
 * already-mounted modal unable to render. One instance for the life of the page.
 */
let appKit = null;

/** Cached module handle, so repeated clicks do not re-import. */
let appKitModule = null;

const APPKIT_NETWORKS = [
    'mainnet',
    'arbitrum',
    'base',
    'polygon',
    'optimism',
    'avalanche',
    'bsc',
    'scroll',
    'linea',
    'zksync',
];

/** Resolve once the user has either connected or dismissed the modal. */
function waitForAppKitConnection(instance, { timeoutMs }) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe?.();
            resolve(value);
        };

        const fail = (message) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe?.();
            reject(new Error(message));
        };

        const unsubscribe = instance.subscribeAccount((account) => {
            if (settled) return;
            if (account?.isConnected && account?.address) {
                finish({
                    transport: 'walletconnect',
                    name: account.connectorName || 'Wallet',
                    address: account.address,
                    chainId: Number(account.chainId) || 1,
                    provider: null,
                    async disconnect() {
                        try {
                            await instance.disconnect();
                        } catch {
                            /* already gone */
                        }
                    },
                });
            }
        });

        // A modal that is dismissed should read as a cancellation, not as a
        // failure. AppKit reports no state change in that case, so wait for the
        // user and treat the deadline as a cancel.
        const timer = setTimeout(() => fail('Wallet connection cancelled.'), timeoutMs);
    });
}

/**
 * Connect any wallet through WalletConnect.
 *
 * One modal, one action. The user picks whichever wallet they want from inside
 * it — browser extension or phone — because AppKit surfaces the whole WalletConnect
 * catalogue and handles the transport per wallet.
 *
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<WalletSession>}
 */
export async function connectViaWalletConnect(options = {}) {
    if (!WC_PROJECT_ID) {
        throw new Error(
            'WalletConnect needs a project id. Create a free project at ' +
                'cloud.walletconnect.com, set VITE_WALLETCONNECT_PROJECT_ID, then reload.',
        );
    }

    if (!appKit) {
        appKitModule =
            appKitModule ||
            (await Promise.all([
                import('@reown/appkit'),
                import('@reown/appkit/networks'),
                // An adapter is what lets AppKit actually talk to an EVM wallet.
                // Without one the Connect view has no way to complete a pairing.
                import('@reown/appkit-adapter-ethers'),
            ]));

        const [{ createAppKit }, networks, { EthersAdapter }] = appKitModule;
        const chainList = APPKIT_NETWORKS.map((key) => networks[key]).filter(Boolean);

        appKit = createAppKit({
            projectId: WC_PROJECT_ID,
            networks: chainList,
            adapters: [new EthersAdapter()],
            metadata: WC_METADATA,
            themeMode: 'dark',
        });
    }

    // `open()` is the AppKit instance method (there is no `openModal`). The
    // 'Connect' view is the wallet picker; 'AllWallets' is reachable from it.
    await appKit.open({ view: 'Connect' });

    // Generous by design: the modal stays open indefinitely while the user reads
    // and picks, so this only fires if they walk away entirely.
    return waitForAppKitConnection(appKit, { timeoutMs: options.timeoutMs ?? 180000 });
}

/** True when a wallet session was established earlier in this page's life. */
export function hasConnectedWallet() {
    return Boolean(appKit?.getAccount?.()?.isConnected);
}

const toHex = (text) => {
    const bytes = new TextEncoder().encode(text);
    let hex = '0x';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
};

/**
 * Sign a UTF-8 message with the connected wallet.
 *
 * Used to prove control of an address to the backend. The signature must be
 * verified server-side against the message that was challenged ---— never trust a
 * client-asserted address.
 *
 * @param {WalletSession} session
 * @param {string} message
 * @returns {Promise<string>} 0x-prefixed signature
 */
export async function signMessage(session, message) {
    if (!session?.provider) throw new Error('No active wallet session.');
    // EIP-1193 personal_sign takes [message, address]. Some wallets accept the
    // reverse order; sending the spec order first keeps us compliant.
    return session.provider.request({
        method: 'personal_sign',
        params: [toHex(message), session.address],
    });
}

/**
 * Subscribe to wallet-initiated changes.
 *
 * @param {WalletSession} session
 * @param {{onAccountsChanged?: Function, onDisconnect?: Function}} handlers
 * @returns {() => void} unsubscribe
 */
export function watchSession(session, { onAccountsChanged, onDisconnect } = {}) {
    const provider = session?.provider;
    if (!provider?.on) return () => {};

    const accountsHandler = (accounts) => onAccountsChanged?.(accounts?.[0] ?? null);
    const disconnectHandler = () => onDisconnect?.();

    provider.on('accountsChanged', accountsHandler);
    provider.on('disconnect', disconnectHandler);

    return () => {
        // `removeListener` is not guaranteed; off() is the modern spelling.
        const off = provider.off || provider.removeListener;
        if (typeof off === 'function') {
            off.call(provider, 'accountsChanged', accountsHandler);
            off.call(provider, 'disconnect', disconnectHandler);
        }
    };
}

/**
 * True when an address is a canonical Hedera account ID (0.0.1234).
 *
 * Kept here so the "can this wallet trade?" decision has one definition. An
 * EVM address is never a Hedera account, so an EVM-connected user can browse
 * but must swap to HBAR before posting or buying.
 *
 * @param {string} value
 */
export function isHederaAccountId(value) {
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value.trim());
}
