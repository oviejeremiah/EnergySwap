// HashPack install prompt - the platform's front door.
//
// This is deliberately a plain <a href>, not a <button onclick="...">:
// inline event handler attributes are refused by any content security
// policy of `script-src 'self'` without 'unsafe-inline', which makes the
// control dead exactly inside sandboxed and production-like environments.
// An anchor needs no JavaScript at all to open its target.

export const HASHPACK_INSTALL_URL = 'https://www.hashpack.app/download';

export const hashPackInstallMessage = () => {
    return `HashPack is required for EnergySwap. Install the browser extension from <a href="${HASHPACK_INSTALL_URL}" target="_blank" rel="noopener noreferrer" class="hashpack-install-btn">HashPack</a>, create a Hedera testnet account, and then select your role again.`;
};
