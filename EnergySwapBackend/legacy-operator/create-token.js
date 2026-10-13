require('dotenv').config();

const {
    Client,
    AccountId,
    PrivateKey,
    TokenCreateTransaction,
    TokenType,
    TokenSupplyType,
    Hbar,
} = require('@hashgraph/sdk');

async function main() {
    console.log('--- Starting Token Creation ---');

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
    client.setDefaultMaxTransactionFee(new Hbar(100)); // Set a high max fee for complex transactions

    // --- Step 1: Create the Fungible Token ---
    console.log('Creating the EnergyToken...');

    // A fungible token is like a standard currency, where each token is identical.
    const createTokenTx = new TokenCreateTransaction()
        .setTokenName('P2P Energy Credit') // The public name of the token
        .setTokenSymbol('P2PEC') // The public symbol (like USD or BTC)
        .setTokenType(TokenType.FungibleCommon) // We are creating a standard, interchangeable token
        .setDecimals(2) // Decimals allow for fractional parts, e.g., 1.25 kWh. 2 decimals = 0.01
        .setInitialSupply(100000000) // 1,000,000 tokens with 2 decimals = 1000000.00
        .setSupplyType(TokenSupplyType.Infinite) // Allows us to mint more tokens later if needed
        .setTreasuryAccountId(operatorId) // The account that will hold the initial supply
        .setAdminKey(operatorKey) // The key that can change token properties later
        .setSupplyKey(operatorKey); // The key that can mint or burn new tokens

    // Execute the transaction
    const createTokenSubmit = await createTokenTx.execute(client);

    // Get the receipt to confirm the transaction was successful
    const createTokenReceipt = await createTokenSubmit.getReceipt(client);

    // --- Step 2: Log the New Token ID ---
    const newTokenId = createTokenReceipt.tokenId;
    console.log('---------------------------------------');
    console.log('Token creation successful!');
    console.log('The new Token ID is:', newTokenId.toString());
    console.log('---------------------------------------');
    console.log('IMPORTANT: Save this Token ID! You will need it for all future operations.');
}

main().catch((error) => {
    console.error('An error occurred during token creation:', error);
    process.exit(1);
});
