# EnergySwap v1 Debugging Notes

## Project overview
EnergySwap v1 is a Hedera-based peer-to-peer energy trading demo with:
- a Node/Express backend in `EnergySwapBackend`
- a Vite/JavaScript frontend in `EnergySwapFrontend`
- local JSON storage in `db.json`
- Hedera wallet integration and trade workflow logic

The main implementation points reviewed were:
- `EnergySwapBackend/server.js`
- `EnergySwapBackend/priceService.js`
- `EnergySwapFrontend/src/main.js`
- `EnergySwapBackend/package.json`
- root `package.json`

---

## What I debugged

### 1. Backend startup and environment configuration
I checked the backend startup flow and confirmed it depends on environment variables loaded via `dotenv`.

Observed behavior:
- `server.js` reads values from `process.env` for news API keys.
- If keys are missing, the app still starts, but the system logs them as not configured.
- The project supports a mix of free sources without keys, including CryptoCompare, Dev.to, Hashnode, and Reddit.
- Additional provider keys such as `NEWS_API_KEY`, `GNEWS_API_KEY`, `THENEWS_API_KEY`, `MEDIASTACK_KEY`, and `CURRENTS_API_KEY` improve coverage but are not strictly required for basic operation.

Debugging note:
- The main app does not crash on missing keys; it degrades gracefully and logs warnings.

### 2. Validations on offer posting and trade execution
I reviewed the API validation logic in `server.js`.

Observed behavior:
- `POST /api/post-offer` requires `prosumerId`, `energyAmountKWh`, and `hbarPerKWh`.
- Values must be positive numbers; otherwise the server returns a 400 response.
- `POST /api/execute-trade` requires `offerId`, `hbarToSpend`, and `consumerAccountId`.
- The system checks whether the offer exists and whether it is still `available` before executing a trade.
- If the offer is missing or already completed, it returns a 404 with a clear error message.

Debugging note:
- Validation is implemented correctly at the API boundary and prevents bad or incomplete trade requests from entering the workflow.

### 3. HBAR price fetching and fallback behavior
I reviewed `EnergySwapBackend/priceService.js` and confirmed that price retrieval is resilient.

Observed behavior:
- It queries CoinGecko at `https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd`.
- A 5-minute cache is used to avoid rate-limit pressure.
- If the API request fails, it falls back to a cached/default price instead of crashing.
- Default fallback value: `0.08 USD`.

Debugging note:
- This is a defensive implementation and makes the app more stable in offline or rate-limited situations.

### 4. Frontend wallet and browser compatibility setup
I inspected `EnergySwapFrontend/src/main.js` and found the project includes browser compatibility workarounds for a browser-based wallet flow.

Observed behavior:
- The frontend sets `window.global` when missing.
- It also assigns `window.process` and `window.Buffer` for compatibility with wallet and network utilities.
- The app uses `import.meta.env.VITE_BACKEND_API_URL` with a default fallback to `http://localhost:3000`.
- The UI uses a `DAppConnector` and wallet metadata for Hedera wallet integration.

Debugging note:
- These compatibility shims are necessary for browser-based Web3 tooling and reduce runtime issues when bundling wallet logic in Vite.

### 5. Data persistence and local trade state
I checked the backend data layer and confirmed that this version stores all offer/trade records in a local JSON file.

Observed behavior:
- `DB_FILE` points to `EnergySwapBackend/db.json`.
- `readDb` and `writeDb` read and persist JSON data.
- The app stores `offers` and `trades` in a simple local structure.
- Data is not backed by a real database or persistent managed service.

Debugging note:
- This design works for a demo or prototype but is not production-grade persistence.

### 6. News-fetch engine and resilience
I reviewed the HTTP fetch layer in `server.js`.

Observed behavior:
- There is a custom `rawFetch` routine with timeout and redirect handling.
- It supports HTTP/HTTPS requests and follows common 301/302/303/307/308 redirect responses.
- A wrapper `getJSON` returns `null` if the request fails, times out, or the payload is not valid JSON.
- This engine is used to gather external news content from multiple sources without relying on heavy dependencies.

Debugging note:
- The fetch pipeline is intentionally defensive and designed to skip broken sources instead of crashing the whole app.

### 7. Test coverage and project automation status
I checked the project scripts in both package manifests.

Observed behavior:
- Root `package.json` has a `test` script that exits with:
  `echo "Error: no test specified" && exit 1`
- The backend package also has the same placeholder issue.
- There is no real automated test suite configured for the project at this stage.

Debugging note:
- This is a major gap for regression safety and should be addressed before relying on the app in anything beyond demo conditions.

---

## Important issues and risks found

1. No real automated tests are present.
2. The app assumes a local backend at `http://localhost:3000` unless configured otherwise.
3. Hedera wallet and API flows depend on correct environment setup and wallet connectivity.
4. The app stores data in JSON files rather than a transactional database.
5. External data sources may fail quietly, but the system is designed to continue running.
6. The price service uses a fallback price, which is acceptable for a prototype but not ideal for financial-grade accuracy.

---

## Debugging conclusion
The EnergySwap v1 codebase is structured as a working prototype with a resilient frontend/backend pattern, but it is still a demo-grade application rather than a production-ready system. The most important things I found were:
- defensive API validation and graceful error handling
- resilient external fetch logic
- browser compatibility shims for wallet tooling
- missing test automation and production persistence

This means the project is functional as a prototype, but it still needs better operational hardening before relying on it for production or serious deployment scenarios.
