const axios = require('axios');

// We'll use the CoinGecko API as it's free and reliable without an API key for simple requests.
const HBAR_PRICE_API_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd';

let cachedPrice = {
    price: 0.08, // A default fallback price
    lastFetched: null,
};

// This function gets the live price of HBAR in USD
async function getHbarPrice() {
    const now = Date.now();
    // Cache the price for 5 minutes (300,000 milliseconds) to avoid rate limits
    if (cachedPrice.lastFetched && now - cachedPrice.lastFetched < 300000) {
        return cachedPrice.price;
    }

    try {
        console.log('Fetching new HBAR price from CoinGecko API...');
        const response = await axios.get(HBAR_PRICE_API_URL);
        const price = response.data['hedera-hashgraph'].usd;

        cachedPrice.price = price;
        cachedPrice.lastFetched = now;
        console.log('New HBAR price cached:', price);
        return price;
    } catch (error) {
        console.error('Could not fetch HBAR price, using cached/default value.', error.message);
        // If the API fails, return the last known price so the app doesn't crash
        return cachedPrice.price;
    }
}

module.exports = { getHbarPrice };
