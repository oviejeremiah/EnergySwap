const assert = require('node:assert/strict');
const test = require('node:test');
const {
    SettlementError,
    calculatePaymentAmount,
    createSettlementVerifier,
    parseUnits,
    validateNetworkAsset,
} = require('../settlement-verification');

const ethereumTxId = `0x${'a'.repeat(64)}`;
const ethereumBuyer = `0x${'1'.repeat(40)}`;
const ethereumSeller = `0x${'2'.repeat(40)}`;
const bitcoinTxId = 'a'.repeat(64);
const bitcoinBuyer = 'tb1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const bitcoinSeller = 'tb1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

function createEthereumFetcher({ tx = {}, receipt = {}, chainId = '0xaa36a7', headBlock = '0x10' } = {}) {
    return async (_url, options) => {
        const { method } = JSON.parse(options.body);
        const result = {
            eth_chainId: chainId,
            eth_getTransactionByHash: tx,
            eth_getTransactionReceipt: receipt,
            eth_blockNumber: headBlock,
        }[method];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    };
}

function createBitcoinFetcher({ transaction, tipHeight = 10 } = {}) {
    return async (url) => {
        if (url.endsWith('/blocks/tip/height')) return new Response(String(tipHeight), { status: 200 });
        return new Response(JSON.stringify(transaction), { status: 200 });
    };
}

test('calculates asset amounts at their native precision without floating point arithmetic', () => {
    assert.equal(calculatePaymentAmount('1.25', '0.1', 'ETH'), '0.125');
    assert.equal(calculatePaymentAmount('0.3', '0.1', 'BTC'), '0.03');
    assert.equal(calculatePaymentAmount('1.25', '0.1', 'HBAR'), '0.125');
    assert.equal(parseUnits('0.125000000000000000', 18), 125000000000000000n);
    assert.throws(() => calculatePaymentAmount('1', '0', 'ETH'), SettlementError);
    assert.throws(() => parseUnits('0.000000001', 8), /more than 8 decimal places/);
});

test('only the configured testnet settlement network and asset pairs are accepted', () => {
    assert.doesNotThrow(() => validateNetworkAsset('ethereum-sepolia', 'ETH'));
    assert.throws(() => validateNetworkAsset('ethereum-sepolia', 'BTC'), /do not match/);
    assert.throws(() => validateNetworkAsset('ethereum-mainnet', 'ETH'), /do not match/);
});

test('verifies native ETH recipient, sender, amount, chain, and confirmation count', async () => {
    const fetchImpl = createEthereumFetcher({
        tx: {
            from: ethereumBuyer,
            to: ethereumSeller,
            value: '0x1bc16d674ec80000',
            input: '0x',
            gasPrice: '0x3b9aca00',
        },
        receipt: {
            status: '0x1',
            blockNumber: '0xf',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x3b9aca00',
        },
        headBlock: '0xf',
    });
    const verifier = createSettlementVerifier({
        config: {
            ethereumSepoliaRpcUrl: 'https://sepolia.example',
            ethereumMinConfirmations: 2,
        },
        fetchImpl,
    });
    const pending = verifier.verifyEthereumPayment({
        transactionId: ethereumTxId,
        buyerAddress: ethereumBuyer,
        sellerAddress: ethereumSeller,
        amount: '2',
    });
    await assert.rejects(pending, /needs 2 confirmation/);
});

test('accepts a confirmed native ETH payment only on Sepolia with the exact amount', async () => {
    const fetchImpl = createEthereumFetcher({
        tx: {
            from: ethereumBuyer,
            to: ethereumSeller,
            value: '0x1bc16d674ec80000',
            input: '0x',
            gasPrice: '0x3b9aca00',
        },
        receipt: {
            status: '0x1',
            blockNumber: '0xf',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x3b9aca00',
        },
        headBlock: '0x11',
    });
    const verifier = createSettlementVerifier({
        config: { ethereumSepoliaRpcUrl: 'https://sepolia.example', ethereumMinConfirmations: 2 },
        fetchImpl,
    });
    const result = await verifier.verifyEthereumPayment({
        transactionId: ethereumTxId,
        buyerAddress: ethereumBuyer,
        sellerAddress: ethereumSeller,
        amount: '2',
    });
    assert.equal(result.paymentAmount, '2');
    assert.equal(result.paymentFee, '0.000021');
    assert.equal(result.confirmations, 3);

    const wrongChain = createSettlementVerifier({
        config: { ethereumSepoliaRpcUrl: 'https://wrong.example', ethereumMinConfirmations: 1 },
        fetchImpl: createEthereumFetcher({ chainId: '0x1' }),
    });
    await assert.rejects(
        wrongChain.verifyEthereumPayment({
            transactionId: ethereumTxId,
            buyerAddress: ethereumBuyer,
            sellerAddress: ethereumSeller,
            amount: '2',
        }),
        /not connected to Ethereum Sepolia/,
    );
});

test('verifies confirmed Bitcoin Testnet output and buyer input', async () => {
    const transaction = {
        txid: bitcoinTxId,
        status: { confirmed: true, block_height: 8 },
        fee: 250,
        vin: [{ prevout: { scriptpubkey_address: bitcoinBuyer } }],
        vout: [{ scriptpubkey_address: bitcoinSeller, value: 12500000 }],
    };
    const verifier = createSettlementVerifier({
        config: { bitcoinTestnetApiUrl: 'https://bitcoin.example/testnet/api', bitcoinMinConfirmations: 3 },
        fetchImpl: createBitcoinFetcher({ transaction, tipHeight: 10 }),
    });
    const result = await verifier.verifyBitcoinPayment({
        transactionId: bitcoinTxId,
        buyerAddress: bitcoinBuyer,
        sellerAddress: bitcoinSeller,
        amount: '0.125',
    });
    assert.equal(result.paymentAmount, '0.125');
    assert.equal(result.paymentFee, '0.0000025');
    assert.equal(result.confirmations, 3);
});

test('rejects unconfirmed, underpaid, and unrelated Bitcoin Testnet transactions', async () => {
    const baseTransaction = {
        txid: bitcoinTxId,
        status: { confirmed: true, block_height: 9 },
        fee: 250,
        vin: [{ prevout: { scriptpubkey_address: bitcoinBuyer } }],
        vout: [{ scriptpubkey_address: bitcoinSeller, value: 12500000 }],
    };
    const verifier = createSettlementVerifier({
        config: { bitcoinTestnetApiUrl: 'https://bitcoin.example/testnet/api', bitcoinMinConfirmations: 3 },
        fetchImpl: createBitcoinFetcher({ transaction: baseTransaction, tipHeight: 10 }),
    });
    const request = {
        transactionId: bitcoinTxId,
        buyerAddress: bitcoinBuyer,
        sellerAddress: bitcoinSeller,
        amount: '0.125',
    };
    await assert.rejects(verifier.verifyBitcoinPayment(request), /needs 3 confirmation/);

    const mismatchedPayment = createSettlementVerifier({
        config: { bitcoinTestnetApiUrl: 'https://bitcoin.example/testnet/api', bitcoinMinConfirmations: 1 },
        fetchImpl: createBitcoinFetcher({
            transaction: { ...baseTransaction, vout: [{ ...baseTransaction.vout[0], value: 12499999 }] },
            tipHeight: 10,
        }),
    });
    await assert.rejects(mismatchedPayment.verifyBitcoinPayment(request), /does not match/);

    const unrelatedBuyer = createSettlementVerifier({
        config: { bitcoinTestnetApiUrl: 'https://bitcoin.example/testnet/api', bitcoinMinConfirmations: 1 },
        fetchImpl: createBitcoinFetcher({
            transaction: { ...baseTransaction, vin: [{ prevout: { scriptpubkey_address: 'tb1qother' } }] },
            tipHeight: 10,
        }),
    });
    await assert.rejects(unrelatedBuyer.verifyBitcoinPayment(request), /inputs do not match/);
});
