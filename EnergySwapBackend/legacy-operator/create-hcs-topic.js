require('dotenv').config();

const { Client, AccountId, PrivateKey, TopicCreateTransaction, Hbar } = require('@hashgraph/sdk');

async function main() {
    console.log('--- Starting HCS Topic Creation ---');

    // Load credentials from .env file
    if (!process.env.OPERATOR_ID || !process.env.OPERATOR_KEY) {
        console.error('Error: OPERATOR_ID and OPERATOR_KEY must be in .env file.');
        return;
    }
    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);

    // Configure the client
    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);
    client.setDefaultMaxTransactionFee(new Hbar(100));

    // --- Step 1: Create the HCS Topic ---
    console.log('Creating the HCS topic for energy data logs...');

    const createTopicTx = new TopicCreateTransaction().setTopicMemo('P2P Energy Trading Data Log'); // A public description for the topic

    // Execute the transaction
    const createTopicSubmit = await createTopicTx.execute(client);

    // Get the receipt to confirm success
    const createTopicReceipt = await createTopicSubmit.getReceipt(client);

    // --- Step 2: Log the New Topic ID ---
    const newTopicId = createTopicReceipt.topicId;
    console.log('---------------------------------------');
    console.log('HCS Topic creation successful!');
    console.log('The new Topic ID is:', newTopicId.toString());
    console.log('---------------------------------------');
    console.log('IMPORTANT: Save this Topic ID! All energy data will be logged here.');
}

main().catch((error) => {
    console.error('An error occurred during HCS topic creation:', error);
    process.exit(1);
});
