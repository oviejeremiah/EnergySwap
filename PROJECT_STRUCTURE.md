# EnergySwap repository guide

This guide describes the files tracked in this repository snapshot. Local
environment files, database records, installed dependencies, and generated
build output are intentionally excluded; see the root `.gitignore`.

## Root

- `.github/workflows/backend-ci.yml` — GitHub Actions workflow that runs the
  backend tests against PostgreSQL and builds the frontend.
- `.gitignore` — excludes local environment files, credentials, database
  files, installed dependencies, build output, and logs.
- `DEBUGGING_NOTES.md` — historical notes from the earlier JSON-storage
  prototype; not the authority for current behavior.
- `DEBUGGING_SUMMARY_AND_TECHNICAL_BUG_LIST.txt` — historical debugging
  summary and proposed fixes from an earlier prototype; not a current issue
  tracker.
- `LICENSE` — Apache License 2.0 for EnergySwap project material. Third-party
  packages and assets retain their own licenses.
- `README.md` — project overview, Testnet status, setup instructions,
  gateway-evidence trust model, operational limitations, and Mainnet release
  gates.
- `PROJECT_STRUCTURE.md` — this file-by-file repository guide.
- `netlify.toml` — Netlify frontend build, publish-directory, and
  single-page-app redirect configuration.
- `package.json` — root development, test, and build scripts and root
  dependencies.
- `package-lock.json` — exact dependency resolution for the root npm
  installation.
- `render.yaml` — Render blueprint for the Testnet API service and managed
  PostgreSQL database.

## `.github/workflows/`

- `backend-ci.yml` — CI jobs for backend unit/API tests, PostgreSQL
  integration tests, and the frontend production build.

## `EnergySwapBackend/`

The Express API, Hedera Testnet integration, PostgreSQL data layer, migration
scripts, and backend tests.

- `.env.example` — safe starting template for backend environment settings;
  replace example values locally and never commit a real `.env`.
- `associate-consumer.js` — Testnet helper that associates a consumer account
  with the configured energy token.
- `associate-token.js` — Testnet helper that associates the prosumer account
  with the configured energy token.
- `config.js` — parses and validates backend configuration, including the
  Testnet-only guard and required production settings.
- `create-hcs-topic.js` — Testnet helper that creates an HCS topic and prints
  its topic ID.
- `create-token.js` — Testnet helper that creates the fungible energy token
  and prints its token ID.
- `credit-energy-tokens.js` — example Testnet token transfer from the operator
  treasury to a prosumer; it is a manual helper, not the signed-reading API.
- `database.js` — PostgreSQL connection pool lifecycle and ordered,
  transactionally applied SQL migrations.
- `execute-trade.js` — Hedera transaction helper that submits a prepared trade
  transaction and returns its confirmation, fee, and timing information.
- `index.js` — simple Testnet client-configuration smoke check.
- `log-energy-data.js` — example HCS submission of a sample energy reading;
  the production-style signed gateway flow is documented separately.
- `oracle-attestation.js` — schema-v2 reading normalization, canonical
  serialization, interval/freshness checks, Ed25519 signature verification,
  and gateway-key fingerprint generation.
- `ORACLE_INTEGRATION.md` — gateway trust assumptions, signed reading schema,
  evidence API, HCS verification, dispute considerations, and recovery limits.
- `package.json` — backend scripts, runtime requirements, and direct
  dependencies.
- `package-lock.json` — exact backend dependency resolution.
- `priceService.js` — cached USD price lookup for the supported market pairs,
  plus OHLC history for the chart timeframe selector, with a clearly documented
  prototype fallback. `getHbarPrice()` is the settlement input and is guaranteed
  to resolve to a positive number.
- `repository.js` — PostgreSQL repository for offers, trades, and meter
  readings, including transactional trade recording and replay reservations.
- `server.js` — Express API routes, health checks, offer/trade workflows,
  signed meter-reading verification, HCS/HTS operations, and news endpoints.

### `EnergySwapBackend/migrations/`

- `001_initial_schema.sql` — creates the initial offers, trades, and meter
  reading tables, constraints, and indexes.
- `002_meter_interval_evidence.sql` — adds signed interval and gateway/HCS
  evidence fields and enforces unique meter intervals.

### `EnergySwapBackend/scripts/`

- `import-json.js` — imports legacy JSON records into PostgreSQL after
  migrations have been applied.
- `migrate.js` — applies pending PostgreSQL schema migrations.

### `EnergySwapBackend/test/`

- `config.test.js` — tests configuration validation and Testnet restrictions.
- `oracle-attestation.test.js` — tests signed-reading canonicalization,
  signature binding, interval validation, and freshness rules.
- `postgres.integration.test.js` — tests PostgreSQL migrations, idempotency,
  and concurrent settlement against a dedicated disposable test database.
- `server.test.js` — tests API behavior, health endpoints, replay protection,
  failure recovery, and public evidence responses.

## `EnergySwapFrontend/`

The Vite single-page application and browser wallet integration.

- `.gitignore` — frontend-local ignores for dependencies, generated build
  output, logs, and editor files.
- `index.html` — application document shell, UI markup, metadata, and Vite
  module entry point.
- `jsconfig.json` — JavaScript editor and language-service configuration.
- `package.json` — frontend development/build scripts and browser dependencies.
- `package-lock.json` — exact frontend dependency resolution.
- `vite.config.js` — Vite build/dev-server configuration and browser polyfills
  needed by wallet dependencies.

### `EnergySwapFrontend/public/`

Static assets copied directly to the frontend build output.

- `_headers` — Netlify response-header rules for the deployed frontend.
- `vite.svg` — Vite starter-template logo asset.

### `EnergySwapFrontend/public/.well-known/`

- `walletconnect.txt` — public WalletConnect domain-verification metadata;
  replace or remove it if the deployment domain or verification setup changes.

### `EnergySwapFrontend/src/`

- `counter.js` — Vite starter-template counter helper; separate from the
  EnergySwap trading flow.
- `javascript.svg` — JavaScript starter-template illustration.
- `main.js` — main browser application: wallet connection, roles, offer and
  trade interactions, API calls, and dashboard/news rendering.

All styling lives in the `<style>` block inside `index.html`, next to the markup
it targets. There is no separate stylesheet; the earlier `src/style.css` was an
unreferenced light-theme leftover from the Vite starter and has been removed.

## Generated and local-only files

The following are deliberately not committed:

- `.env` and other local environment files, which may contain credentials or
  deployment-specific configuration.
- `db.json` and other local database files, which can contain user or trade
  records.
- `node_modules/` and frontend `dist/`, which are restored from the lockfiles
  or generated by the build.
- `structure.txt`, a large generated directory dump with no runtime role.
