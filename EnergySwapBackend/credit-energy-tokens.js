require('dotenv').config();

const { Client, AccountId, PrivateKey, TransferTransaction } = require('@hashgraph/sdk');

async function main() {
    console.log('--- Starting Energy Token Credit ---');

    // Load credentials from .env file
    if (
        !process.env.OPERATOR_ID ||
        !process.env.OPERATOR_KEY ||
        !process.env.PROSUMER_ID ||
        !process.env.ENERGY_TOKEN_ID
    ) {
        console.error('Error: All necessary IDs and Keys must be in .env file.');
        return;
    }
    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);
    const prosumerId = AccountId.fromString(process.env.PROSUMER_ID);
    const tokenId = process.env.ENERGY_TOKEN_ID;

    // Configure the client
    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    // --- Step 1: Simulate crediting tokens for energy generated ---
    // We assume we have verified a prosumer generated 15.75 kWh.
    // Our token has 2 decimal places, so we need to transfer 1575 units (15.75 * 100).
    const amountToCredit = 1575;
    console.log(`Crediting ${prosumerId} with ${amountToCredit / 100} EnergyTokens...`);

    // --- Step 2: Create and execute the HTS Transfer Transaction ---
    // The treasury account (operator) signs this transaction to authorize the transfer
    const transferTx = await new TransferTransaction()
        .addTokenTransfer(tokenId, operatorId, -amountToCredit) // Debiting from treasury
        .addTokenTransfer(tokenId, prosumerId, amountToCredit) // Crediting to prosumer
        .execute(client);

    // Get the receipt
    const receipt = await transferTx.getReceipt(client);

    console.log('---------------------------------------');
    console.log('Token credit successful with status:', receipt.status.toString());
    console.log(`Transferred ${amountToCredit / 100} tokens from ${operatorId} to ${prosumerId}`);
    console.log('---------------------------------------');
}

main().catch((error) => {
    console.error('An error occurred during token credit:', error);
    process.exit(1);
});
