// C:\Cyber Security\ProjectCode\EnergySwapBackend\execute-trade.js

require('dotenv').config();
const {
    Client,
    AccountId,
    TokenId,
    PrivateKey,
    Transaction, // Import Transaction class
    TransactionId, // To reconstruct TransactionId
    TransactionRecord,
    Hbar,
    Status,
} = require('@hashgraph/sdk');

async function executeTrade(
    unsignedTransactionBytes,
    buyerAccountId,
    sellerAccountId,
    offerId,
    energyAmountKWh,
    hbarAmount,
) {
    console.log(`--- Executing Trade: Offer ID ${offerId} ---`);
    console.log(`Buyer: ${buyerAccountId.toString()}`);
    console.log(`Seller: ${sellerAccountId.toString()}`);
    console.log(`Energy Amount (KWh): ${energyAmountKWh}`);
    console.log(`HBAR Amount: ${hbarAmount.toTinybars().toString()} tinybars`); // Ensure hbarAmount is Hbar object

    if (!process.env.OPERATOR_ID || !process.env.OPERATOR_KEY || !process.env.ENERGY_TOKEN_ID) {
        throw new Error('Missing OPERATOR_ID, OPERATOR_KEY, or ENERGY_TOKEN_ID in .env file.');
    }

    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);
    const energyTokenId = TokenId.fromString(process.env.ENERGY_TOKEN_ID);

    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    let gasFeeHbar = 0;
    let transactionSpeedSeconds = 0;
    let transactionHash = null; // We'll get the hash from the record
    let recordStatus = null;
    let transactionId = null; // The TransactionId object

    try {
        const transactionStartTime = Date.now(); // Record start time

        // 1. Reconstruct the unsigned transaction from bytes
        const transaction = Transaction.fromBytes(Buffer.from(unsignedTransactionBytes, 'base64'));

        // Ensure the transaction includes the necessary transfers
        // (This validation ideally happens on the client, but a quick check here is good)
        // We expect: buyer to seller HBAR, seller to buyer tokens
        // Not performing deep validation here, assuming frontend builds correctly.

        // 2. Sign the transaction with the operator key
        const signedTransaction = await transaction.sign(operatorKey);

        // 3. Execute the transaction
        console.log('Submitting fully signed transaction to Hedera...');
        const txResponse = await signedTransaction.execute(client);

        // 4. Get the receipt and record to calculate fee and speed
        console.log(`Waiting for transaction receipt and record for TX ID: ${txResponse.transactionId.toString()}`);
        transactionId = txResponse.transactionId; // Store the TransactionId object

        const receipt = await txResponse.getReceipt(client);
        recordStatus = receipt.status.toString();
        console.log(`Transaction status: ${recordStatus}`);

        const transactionRecord = await txResponse.getRecord(client);
        const transactionEndTime = Date.now(); // Record end time

        // Calculate transaction speed
        transactionSpeedSeconds = (transactionEndTime - transactionStartTime) / 1000;

        // Get gas fee (in Hbar)
        gasFeeHbar = transactionRecord.transactionFee.toTinybars().dividedBy(100_000_000).toNumber(); // Convert tinybars to Hbar

        // Get transaction hash for unique identification in explorers
        transactionHash = Buffer.from(transactionRecord.transactionHash).toString('hex');

        console.log(`Transaction Speed: ${transactionSpeedSeconds.toFixed(2)} seconds`);
        console.log(`Gas Fee: ${gasFeeHbar.toFixed(8)} HBAR`);
        console.log(`Transaction ID: ${transactionId.toString()}`);
        console.log(`Transaction Hash: ${transactionHash}`);

        // Return the collected data
        return {
            success: true,
            transactionId: transactionId.toString(),
            transactionHash: transactionHash,
            status: recordStatus,
            transactionSpeedSeconds: transactionSpeedSeconds,
            gasFeeHbar: gasFeeHbar,
            tradeTimestamp: new Date().toISOString(), // Capture timestamp of successful trade
        };
    } catch (error) {
        console.error('Error during executeTrade:', error);
        // Return error details
        return {
            success: false,
            error: error.message,
            tradeTimestamp: new Date().toISOString(),
        };
    } finally {
        client.close();
    }
}

module.exports = { executeTrade };
