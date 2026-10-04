# EnergySwap

EnergySwap is a Hedera-based peer-to-peer energy trading prototype. It has a
Vite frontend, an Express API, HashPack wallet integration, Testnet transaction
verification, and a signed meter-reading proof of concept.

Current classification
----------------------

This is a working prototype / Testnet demo, not a production MVP and not ready
for Mainnet. The backend uses PostgreSQL transactions, versioned database
migrations, health checks, safer HTTP defaults, and automated tests. These
controls improve the engineering baseline but do not by themselves make
real-world energy settlement safe.

Mainnet is intentionally disabled in this release. The backend refuses any
HEDERA_NETWORK value other than "testnet". Do not change this guard to deploy
real funds; use the release gates below first.

Architecture
------------

- EnergySwapFrontend: Vite frontend and browser wallet integration.
- EnergySwapBackend: Express API, Hedera Testnet interactions, PostgreSQL
  migrations and repository.
- migrations: versioned PostgreSQL schema, applied before the API listens.
- render.yaml: starter Render web-service and managed PostgreSQL blueprint.
- .github/workflows/backend-ci.yml: backend/API and PostgreSQL integration
  tests plus a frontend production build.

Local development
-----------------

Requirements: Node.js 22.x, npm, PostgreSQL 16 or compatible.

1. Create a local database and copy EnergySwapBackend/.env.example to
   EnergySwapBackend/.env. Set DATABASE_URL, HEDERA_NETWORK=testnet, and the
   exact local frontend origin in CORS_ORIGINS.
2. Add only Testnet operator credentials and Testnet topic/token IDs to the
   backend .env when you need chain operations. Never put private keys in the
   frontend, source control, or client-side build variables.
3. Install dependencies:

   npm --prefix EnergySwapBackend ci
   npm --prefix EnergySwapFrontend ci
   npm ci

4. Apply database migrations and start the app:

   npm --prefix EnergySwapBackend run migrate
   npm run dev

The API defaults to port 3000. Configure VITE_BACKEND_API_URL for the frontend
if the API uses a different local URL.

For a Testnet wallet demo, install the HashPack browser extension, use a
Hedera Testnet account, and configure the API to allow the frontend's exact
origin. Use Testnet HBAR and test assets only.

Database and legacy data
------------------------

The API requires DATABASE_URL and applies versioned migrations during startup.
Offers, trades, and signed meter-reading states are stored in PostgreSQL.
Writes that change offer capacity and record a completed trade run in one
database transaction; unique transaction IDs and reading IDs enforce
idempotency across backend processes.

To copy an existing EnergySwapBackend/db.json into PostgreSQL, back up the file,
run migrations, then run:

   npm --prefix EnergySwapBackend run import-json

The import is idempotent. It does not delete the JSON file. Review imported
counts and verify the resulting records before removing any local backup.
Legacy meter readings not marked credited are imported as
reconciliation_required; inspect their Hedera transaction history before any
manual action.

Gateway-signed meter evidence (Hedera Testnet)
-----------------------------------------------

EnergySwap treats the meter gateway as a core trust assumption in its
peer-to-peer design. The gateway attests which meter is associated with which
Hedera prosumer account and the energy reading reported for a specific
measurement interval. EnergySwap verifies and publishes that attestation; it
does not independently inspect the meter, certify its calibration, or prove
that the reported energy was physically delivered.

Each reading uses schema version 2 and is signed by the configured gateway
with Ed25519. The signature binds the reading ID, meter ID, prosumer account,
interval start and end, the `[start,end)` interval convention, and kWh value.
The interval must be canonical UTC, positive, no longer than 24 hours, and
fresh when submitted: the interval end must be no more than five minutes in
the past or one minute in the future relative to the API server. Energy values
use 0.01 kWh increments to match the configured energy token precision. The
gateway's public key and SHA-256 fingerprint accompany the evidence so that
the signature can be checked later.

Before chain operations, EnergySwap reserves the reading in PostgreSQL.
Unique constraints reject reuse of a reading ID and duplicate meter intervals
across API instances, protecting against replay and concurrent duplicate
submissions. The API verifies the Ed25519 signature against the configured
gateway key. The operator remains responsible for securely enrolling the
gateway, assigning meters to prosumer accounts, maintaining and calibrating
meters, protecting gateway keys, and handling key rotation.

After successful HCS submission, the topic provides a public, time-ordered,
tamper-evident record of the attestation. Both trading parties can inspect
`GET /api/oracle/readings/{readingId}` for the signed fields, signature,
gateway key and fingerprint, processing status, and HCS transaction and
consensus-time references. They can independently verify that the configured
gateway key signed those exact fields and compare them with the related trade
and payment evidence. HCS ordering proves when that message was recorded; it
does not prove the physical reading is accurate.

Buyers and sellers should agree before trading on meter/account attribution,
what the kWh quantity represents, interval boundaries, units and rounding,
allowed tolerance, missing or corrected readings, dispute deadlines, evidence
requirements, an adjudicator, and available remedies. For a dispute, preserve
the meter evidence and relevant trade/payment transaction IDs, then follow
that pre-agreed process. EnergySwap currently publishes evidence but does not
authenticate dispute claims, adjudicate them, enforce an agreement, or record
a jointly signed resolution. HBAR payments are direct; EnergySwap does not
custody funds, guarantee physical delivery, or automatically reverse a
confirmed payment.

HCS submission and HTS token credit are separate chain operations, not an
atomic transaction. Uncertain outcomes are not automatically replayed or
credited again; operators must inspect network transaction records and
reconcile the stored status before taking further action. This feature is
Testnet-only and does not make the application Mainnet-ready.

Tests and builds
----------------

Backend unit/API tests:

   npm --prefix EnergySwapBackend test

PostgreSQL integration tests run when TEST_DATABASE_URL points to a dedicated
test database whose name includes "test". The tests truncate their tables, so
never point this variable at development or production data.

   $env:TEST_DATABASE_URL = "postgresql://user:password@localhost:5432/energyswap_test"
   npm --prefix EnergySwapBackend test

Frontend production build:

   npm --prefix EnergySwapFrontend run build

Deployment preparation (Render API + Netlify frontend)
-------------------------------------------------------

The Render blueprint provisions a managed PostgreSQL database and a Node API.
Before applying it:

- Review the Render plan and region in render.yaml and the provider's current
  backup, availability, networking, and cost terms.
- Set CORS_ORIGINS to the exact HTTPS origin of the deployed frontend.
- Add Testnet OPERATOR_ID, OPERATOR_KEY, HCS_TOPIC_ID, and ENERGY_TOKEN_ID as
  Render secret/environment values. Add METER_ORACLE_PUBLIC_KEY only if the
  signed meter endpoint is configured.
- Keep HEDERA_NETWORK=testnet. Do not configure Mainnet IDs or keys.
- Set VITE_BACKEND_API_URL in Netlify to the deployed API URL, then build the
  frontend.
- Set PGSSL=true only when connecting through a TLS endpoint whose certificate
  can be validated by Node. The Render private database connection normally
  uses the internal connection string.
- Review the service logs, /health/live, /health/ready, PostgreSQL backup and
  restore procedures, and a complete Testnet trade before inviting testers.

The API binds to Render's PORT, uses /health/ready as its deployment health
check, applies Helmet headers, exact-origin CORS, JSON body limits, rate
limiting, and graceful HTTP/database shutdown. The current rate limiter uses
per-process memory; configure a shared rate-limit store before running multiple
API instances.

Security and operational limitations
------------------------------------

- A connected browser wallet is not server-side proof of ownership for offer
  creation. API callers can claim another account as a prosumer. Add and test
  wallet-signed authorization and account enrollment before production.
- Trades transfer HBAR directly and are recorded by the API after confirmation;
  offers are not escrowed or reserved on-chain. Database transactions protect
  the local ledger, but cannot reverse an already confirmed Hedera payment.
  Oversold or late payments are retained as reconciliation_required records.
- HCS submission and HTS energy-token credit are separate chain transactions.
  Unknown outcomes remain pending and are never automatically credited again.
  Operators need a documented, auditable reconciliation procedure.
- The oracle is an explicit trust assumption: one configured Ed25519 gateway
  attests the meter, prosumer account, half-open measurement interval, and kWh.
  See "Gateway-signed meter evidence" above for the evidence format, public
  verification, dispute considerations, and current limitations. Meter-to-
  prosumer enrollment, calibration, and multi-gateway key rotation still need
  operational processes.
- The frontend uses wallet-connect dependencies. A production Content Security
  Policy must be designed and tested against the chosen wallet flow; do not
  restore wildcard script/connect policies or expose server environment
  variables to Vite.
- npm audit still reports high-severity and critical advisories in the Hedera
  and wallet dependency trees, including protobufjs. The available automatic
  fixes require a package-version change outside the declared compatibility
  range; they were not forced. Resolve these advisories and re-test wallet and
  chain flows before production.
- Rate limiting is in-memory and currently applies per process, not across
  replicas. Add shared abuse controls, alerting, and traffic monitoring before
  scaling.
- HBAR price fallback values are illustrative; they are not a settlement price
  source. Do not use displayed estimates for financial accounting.
- No independent security assessment, load/soak testing, backup restoration
  exercise, disaster-recovery test, or live operational rehearsal has been
  completed.

Mainnet release gates
---------------------

Do not enable Mainnet until all of these have been completed and independently
reviewed:

1. Authenticate and authorize wallet actions server-side; enroll meters and
   prosumers; define, publish, and obtain both parties' acceptance of the
   dispute, settlement, and remedy rules.
2. Test transactional invariants, concurrent purchases, duplicate submissions,
   timeouts, partial HCS/HTS failures, process restarts, and reconciliation
   against a dedicated Testnet environment.
3. Exercise database backup restoration, migration/rollback procedures,
   monitoring, alerting, key rotation, incident response, and recovery drills.
4. Complete a security review, threat model, dependency vulnerability
   remediation, privacy review, and a wallet-compatible restrictive CSP.
5. Define a reviewed Mainnet deployment process with fresh Mainnet resources,
   separate credentials, spending limits, access controls, and explicit
   operator approval.

The current CI and Testnet configuration are preparation, not certification
for Mainnet. The oracle evidence API is implemented; an in-product,
wallet-authenticated dispute case and jointly signed resolution flow is not.

License
-------

EnergySwap project material is licensed under the Apache License, Version 2.0.
See [LICENSE](LICENSE). Third-party dependencies and assets remain under their
own licenses; consult the package lockfiles and upstream notices before
redistributing a built application.
