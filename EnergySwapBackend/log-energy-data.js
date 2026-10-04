require('dotenv').config();

const { Client, AccountId, PrivateKey, TopicMessageSubmitTransaction } = require('@hashgraph/sdk');

async function main() {
    console.log('--- Starting Energy Data Submission ---');

    // Load all credentials and IDs from .env file
    if (!process.env.OPERATOR_ID || !process.env.OPERATOR_KEY || !process.env.HCS_TOPIC_ID) {
        console.error('Error: OPERATOR_ID, OPERATOR_KEY, and HCS_TOPIC_ID must be in .env file.');
        return;
    }
    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);
    const topicId = process.env.HCS_TOPIC_ID;

    // Configure the client
    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    // --- Step 1: Prepare the Energy Data Message ---
    // In a real application, this data would come from a smart meter or user input.
    // For our prototype, we will simulate it.
    const energyData = {
        prosumerId: operatorId.toString(), // We'll pretend our operator is the prosumer for this test
        kwhGenerated: 15.75,
        readingTimestamp: new Date().toISOString(), // Use the current time
    };

    // We will format our data as a JSON string to submit it.
    const message = JSON.stringify(energyData);
    console.log('Preparing to submit message:', message);

    // --- Step 2: Submit the Message to the HCS Topic ---
    const submitMessageTx = await new TopicMessageSubmitTransaction({
        topicId: topicId,
        message: message,
    }).execute(client);

    // Get the receipt to confirm success
    const receipt = await submitMessageTx.getReceipt(client);
    console.log('Message submitted successfully with status:', receipt.status.toString());

    // --- Step 3: Log Information for Verification ---
    // You can use the transaction ID to find your transaction on a Hedera explorer
    const transactionId = submitMessageTx.transactionId.toString();
    console.log('---------------------------------------');
    console.log('Transaction ID for this submission:', transactionId);
    console.log(`You can view this transaction on a Hedera Explorer like HashScan:`);
    console.log(`https://hashscan.io/testnet/transaction/${transactionId}`);
    console.log('---------------------------------------');
}

main().catch((error) => {
    console.error('An error occurred during data submission:', error);
    process.exit(1);
});
