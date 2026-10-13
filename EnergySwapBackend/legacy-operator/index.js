/// This line loads the environment variables from your .env file
require('dotenv').config();

// This line imports the necessary classes from the Hedera SDK
const { Client, AccountId, PrivateKey } = require('@hashgraph/sdk');

console.log('Welcome to the P2P Energy Trading Platform!');
console.log('Attempting to connect to Hedera...');

// Main function to run our application
async function main() {
    // ---- START OF IMPROVED CODE ----

    // Check if the credentials exist BEFORE trying to use them
    if (!process.env.OPERATOR_ID || !process.env.OPERATOR_KEY) {
        // Give a clear, helpful error message
        console.error(
            'Error: Make sure you have a .env file in the root of your project with OPERATOR_ID and OPERATOR_KEY defined.',
        );
        // Stop the program
        return;
    }

    // Now that we know they exist, we can safely use them
    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const operatorKey = PrivateKey.fromString(process.env.OPERATOR_KEY);

    // ---- END OF IMPROVED CODE ----

    // Configure a client for the Hedera Testnet
    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    console.log('---------------------------------------');
    console.log('Hedera client configured successfully!');
    console.log('Operator Account ID:', operatorId.toString());
    console.log('---------------------------------------');
}

// Call the main function
main().catch((error) => {
    console.error('An error occurred:', error);
    process.exit(1);
});
