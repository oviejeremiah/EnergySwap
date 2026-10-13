const ASSET_DECIMALS = Object.freeze({ HBAR: 8, ETH: 18, BTC: 8 });
const NETWORK_ASSET = Object.freeze({
    'ethereum-sepolia': 'ETH',
    'bitcoin-testnet': 'BTC',
});

class SettlementError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'SettlementError';
        this.statusCode = statusCode;
    }
}

function parseUnits(value, decimals) {
    const text = String(value);
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
        throw new SettlementError('Payment amounts must be positive decimal values.');
    }
    const [whole, rawFraction = ''] = text.split('.');
    const fraction = rawFraction.replace(/0+$/, '');
    if (fraction.length > decimals) {
        throw new SettlementError(`Payment amount has more than ${decimals} decimal places.`);
    }
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function formatUnits(value, decimals) {
    const units = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
}

function calculatePaymentAmount(energyAmountKWh, pricePerKWh, asset) {
    const decimals = ASSET_DECIMALS[asset];
    if (decimals === undefined) throw new SettlementError('Unsupported settlement asset.');
    const kWhUnits = parseUnits(energyAmountKWh, 8);
    const priceUnits = parseUnits(pricePerKWh, decimals);
    if (kWhUnits <= 0n || priceUnits <= 0n) throw new SettlementError('Trade amounts must be greater than zero.');
    const divisor = 10n ** 8n;
    const amount = (kWhUnits * priceUnits + divisor / 2n) / divisor;
    if (amount <= 0n) throw new SettlementError('Trade amount is below the supported asset precision.');
    return formatUnits(amount, decimals);
}

function validateNetworkAsset(network, asset) {
    if (NETWORK_ASSET[network] !== asset) {
        throw new SettlementError('The offer network and settlement asset do not match.');
    }
}

function assertHexHash(value, label) {
    if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
        throw new SettlementError(`${label} must be a 32-byte hexadecimal transaction hash.`);
    }
}

function assertEthereumAddress(value, label) {
    if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) {
        throw new SettlementError(`${label} must be a valid Ethereum address.`);
    }
}

function assertBitcoinAddress(value, label) {
    if (
        typeof value !== 'string' ||
        !(/^(?:[mn2][1-9A-HJ-NP-Za-km-z]{25,34}|tb1[ac-hj-np-z02-9]{11,71})$/.test(value))
    ) {
        throw new SettlementError(`${label} must be a Bitcoin Testnet address.`);
    }
}

async function readJson(response, serviceName) {
    if (!response.ok) throw new SettlementError(`${serviceName} could not verify the payment.`, 503);
    try {
        return await response.json();
    } catch {
        throw new SettlementError(`${serviceName} returned an invalid response.`, 503);
    }
}

function createSettlementVerifier({ config, fetchImpl = globalThis.fetch }) {
    async function rpc(method, params) {
        if (!config.ethereumSepoliaRpcUrl) {
            throw new SettlementError('Ethereum Sepolia payment verification is not configured.', 503);
        }
        let response;
        try {
            response = await fetchImpl(config.ethereumSepoliaRpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal: AbortSignal.timeout(10000),
            });
        } catch {
            throw new SettlementError('Ethereum Sepolia RPC is unavailable.', 503);
        }
        const payload = await readJson(response, 'Ethereum Sepolia RPC');
        if (payload.error || !Object.hasOwn(payload, 'result')) {
            throw new SettlementError('Ethereum Sepolia RPC could not verify the payment.', 503);
        }
        return payload.result;
    }

    async function verifyEthereumPayment({ transactionId, buyerAddress, sellerAddress, amount }) {
        assertHexHash(transactionId, 'Transaction ID');
        assertEthereumAddress(buyerAddress, 'Buyer address');
        assertEthereumAddress(sellerAddress, 'Seller address');
        const [chainId, transaction, receipt, headBlock] = await Promise.all([
            rpc('eth_chainId', []),
            rpc('eth_getTransactionByHash', [transactionId]),
            rpc('eth_getTransactionReceipt', [transactionId]),
            rpc('eth_blockNumber', []),
        ]);
        if (chainId !== '0xaa36a7') throw new SettlementError('RPC endpoint is not connected to Ethereum Sepolia.', 503);
        if (!transaction || !receipt) throw new SettlementError('Ethereum payment is not yet confirmed.', 409);
        if (receipt.status !== '0x1') throw new SettlementError('Ethereum payment transaction did not succeed.');
        if (transaction.from?.toLowerCase() !== buyerAddress.toLowerCase()) {
            throw new SettlementError('Ethereum payment sender does not match the connected buyer wallet.');
        }
        if (transaction.to?.toLowerCase() !== sellerAddress.toLowerCase()) {
            throw new SettlementError('Ethereum payment recipient does not match the offer seller.');
        }
        if (transaction.input !== '0x') {
            throw new SettlementError('Only direct native ETH transfers are accepted for this offer.');
        }
        if (BigInt(transaction.value) !== parseUnits(amount, ASSET_DECIMALS.ETH)) {
            throw new SettlementError('Ethereum payment amount does not match the selected offer.');
        }
        const confirmations = BigInt(headBlock) - BigInt(receipt.blockNumber) + 1n;
        if (confirmations < BigInt(config.ethereumMinConfirmations)) {
            throw new SettlementError(
                `Ethereum payment needs ${config.ethereumMinConfirmations} confirmation(s).`,
                409,
            );
        }
        const gasPrice = BigInt(receipt.effectiveGasPrice || transaction.gasPrice || '0x0');
        const gasFee = BigInt(receipt.gasUsed || '0x0') * gasPrice;
        return {
            buyerAddress: transaction.from,
            sellerAddress: transaction.to,
            paymentAmount: amount,
            paymentFee: formatUnits(gasFee, ASSET_DECIMALS.ETH),
            confirmations: Number(confirmations),
            network: 'ethereum-sepolia',
        };
    }

    async function getBitcoinJson(pathname) {
        if (!config.bitcoinTestnetApiUrl) {
            throw new SettlementError('Bitcoin Testnet payment verification is not configured.', 503);
        }
        const baseUrl = config.bitcoinTestnetApiUrl.replace(/\/+$/, '');
        let response;
        try {
            response = await fetchImpl(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(10000) });
        } catch {
            throw new SettlementError('Bitcoin Testnet explorer is unavailable.', 503);
        }
        if (pathname === '/blocks/tip/height') {
            if (!response.ok) throw new SettlementError('Bitcoin Testnet explorer could not verify the payment.', 503);
            const text = await response.text();
            if (!/^\d+$/.test(text.trim())) {
                throw new SettlementError('Bitcoin Testnet explorer returned an invalid response.', 503);
            }
            return Number(text.trim());
        }
        return readJson(response, 'Bitcoin Testnet explorer');
    }

    async function verifyBitcoinPayment({ transactionId, buyerAddress, sellerAddress, amount }) {
        if (typeof transactionId !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionId)) {
            throw new SettlementError('Transaction ID must be a 32-byte Bitcoin transaction ID.');
        }
        assertBitcoinAddress(buyerAddress, 'Buyer address');
        assertBitcoinAddress(sellerAddress, 'Seller address');
        let transaction;
        try {
            transaction = await getBitcoinJson(`/tx/${transactionId}`);
        } catch (error) {
            if (error.statusCode === 503) throw error;
            throw new SettlementError('Bitcoin transaction was not found or could not be read.', 409);
        }
        if (transaction.txid?.toLowerCase() !== transactionId.toLowerCase()) {
            throw new SettlementError('Bitcoin explorer returned a different transaction.');
        }
        if (!transaction.status?.confirmed) throw new SettlementError('Bitcoin payment is not yet confirmed.', 409);
        const tipHeight = await getBitcoinJson('/blocks/tip/height');
        const confirmations = Number(tipHeight) - Number(transaction.status.block_height) + 1;
        if (!Number.isInteger(confirmations) || confirmations < config.bitcoinMinConfirmations) {
            throw new SettlementError(
                `Bitcoin payment needs ${config.bitcoinMinConfirmations} confirmation(s).`,
                409,
            );
        }
        if (!(transaction.vin || []).some((input) => input.prevout?.scriptpubkey_address === buyerAddress)) {
            throw new SettlementError('Bitcoin transaction inputs do not match the connected buyer wallet.');
        }
        const expectedSatoshis = parseUnits(amount, ASSET_DECIMALS.BTC);
        const paidSatoshis = (transaction.vout || [])
            .filter((output) => output.scriptpubkey_address === sellerAddress)
            .reduce((total, output) => total + BigInt(output.value), 0n);
        if (paidSatoshis !== expectedSatoshis) {
            throw new SettlementError('Bitcoin payment output does not match the selected offer.');
        }
        return {
            buyerAddress,
            sellerAddress,
            paymentAmount: amount,
            paymentFee: formatUnits(BigInt(transaction.fee || 0), ASSET_DECIMALS.BTC),
            confirmations,
            network: 'bitcoin-testnet',
        };
    }

    return { verifyBitcoinPayment, verifyEthereumPayment };
}

module.exports = {
    ASSET_DECIMALS,
    NETWORK_ASSET,
    SettlementError,
    calculatePaymentAmount,
    createSettlementVerifier,
    formatUnits,
    parseUnits,
    validateNetworkAsset,
};
