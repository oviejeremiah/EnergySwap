require('dotenv').config();

const { Client, AccountId, PrivateKey, TokenAssociateTransaction, Hbar } = require('@hashgraph/sdk');

async function main() {
    console.log('--- Starting Token Association ---');

    // Load credentials from .env file
    if (!process.env.PROSUMER_ID || !process.env.PROSUMER_KEY || !process.env.ENERGY_TOKEN_ID) {
        console.error('Error: PROSUMER_ID, PROSUMER_KEY, and ENERGY_TOKEN_ID must be in .env file.');
        return;
    }
    const prosumerId = AccountId.fromString(process.env.PROSUMER_ID);
    const prosumerKey = PrivateKey.fromString(process.env.PROSUMER_KEY);
    const tokenId = process.env.ENERGY_TOKEN_ID;

    // We need a client to submit the transaction
    // The client's operator will pay the transaction fee
    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);
    const client = Client.forTestnet().setOperator(operatorId, operatorKey);

    // --- Step 1: Create the Token Associate Transaction ---
    // This transaction must be signed by the prosumer's key
    const associateTx = await new TokenAssociateTransaction()
        .setAccountId(prosumerId)
        .setTokenIds([tokenId])
        .freezeWith(client); // Freeze the transaction for signing

    // Sign with the key of the account that is being associated
    const signTx = await associateTx.sign(prosumerKey);

    // --- Step 2: Submit the transaction ---
    const txResponse = await signTx.execute(client);
    const receipt = await txResponse.getReceipt(client);

    console.log('---------------------------------------');
    console.log('Token association successful with status:', receipt.status.toString());
    console.log(`Account ${prosumerId} is now associated with Token ${tokenId}`);
    console.log('---------------------------------------');
}

main().catch((error) => {
    console.error('An error occurred during association:', error);
    process.exit(1);
});
