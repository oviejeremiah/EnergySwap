require('dotenv').config();

const { Client, AccountId, PrivateKey, TokenAssociateTransaction } = require('@hashgraph/sdk');

async function main() {
    console.log('--- Starting Consumer Token Association ---');

    // Load credentials from .env file
    if (!process.env.CONSUMER_ID || !process.env.CONSUMER_KEY || !process.env.ENERGY_TOKEN_ID) {
        console.error('Error: CONSUMER_ID, CONSUMER_KEY, and ENERGY_TOKEN_ID must be in .env file.');
        return;
    }
    const consumerId = AccountId.fromString(process.env.CONSUMER_ID);
    const consumerKey = PrivateKey.fromString(process.env.CONSUMER_KEY);
    const tokenId = process.env.ENERGY_TOKEN_ID;

    // We need a client to submit the transaction
    // The client's operator will pay the transaction fee
    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);
    const client = Client.forTestnet().setOperator(operatorId, operatorKey);

    // --- Step 1: Create the Token Associate Transaction ---
    // This transaction must be signed by the CONSUMER's key
    const associateTx = await new TokenAssociateTransaction()
        .setAccountId(consumerId) // <-- This is the corrected line
        .setTokenIds([tokenId])
        .freezeWith(client); // Freeze the transaction for signing

    // Sign with the key of the account that is being associated
    const signTx = await associateTx.sign(consumerKey); // <-- This is also corrected

    // --- Step 2: Submit the transaction ---
    const txResponse = await signTx.execute(client);
    const receipt = await txResponse.getReceipt(client);

    console.log('---------------------------------------');
    console.log('Token association successful with status:', receipt.status.toString());
    console.log(`Account ${consumerId} is now associated with Token ${tokenId}`);
    console.log('---------------------------------------');
}

main().catch((error) => {
    console.error('An error occurred during association:', error);
    process.exit(1);
});
