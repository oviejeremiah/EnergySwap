# EnergySwap — Changelog

This document describes everything shipped between `6a895eb` (2026-10-04,
"Explain energy evidence to marketplace traders") and `95bfa95` (2026-11-02).
Every claim below is backed by a commit, a test that ran, or a live ledger
verification; nothing here is aspirational. The platform holds **no signing
identity**: prosumers and consumers sign their own transactions, and key
material never leaves `.env` (gitignored) or the grid gateway's own directory.

## 2026-10-13 — Operator removal & architecture hardening
`a80d13b` … `00c34e9`

- **The platform no longer holds or uses a signing identity anywhere in the
  user path.** Meter attestations and energy-token credits are signed
  exclusively by the grid gateway, which owns its keys and pays its own fees.
  `gateway.test.js` asserts the API opens zero Hedera clients when it accepts a
  reading — the invariant is tested, not stated.
- **Identity bindings** — EVM addresses are bound to Hedera accounts through an
  on-chain attestation that echoes a single-use, time-bounded nonce issued by
  the API. Observed attestations cannot be replayed; nonces are per-account and
  capped, so an unauthenticated caller cannot pin memory by requesting forever.
- **Multichain settlement fields** recorded on offers and trades, so HBAR
  settlement today does not pre-judge other settlement assets later.
- **Independent review fix (`6d7a7cf`)** — a critical money-path defect found
  by an out-of-band review was corrected with a red-then-green regression test.
- **Undeclared dependency (`75f2c25`)** — a package required by a source file
  but declared only in the root manifest would have stopped the API booting in
  any clean deploy or CI install. Declared in the manifest that actually
  installs it, and covered by a test that runs with the hoisted copy hidden.
- **Unauthenticated write path closed (`00c34e9`)** — every mutating route now
  requires authorisation or a verified proof, plus an automated verification
  ladder that mutation-tests the guards themselves.
- Launch research and plan corrected (`2d1e287`) so public documents make no
  factual overclaims.

## 2026-11-02 — Transaction-proof offers, settlement engine, frontend resilience
`83796cf`, `2ee0fd1`, `95bfa95`

### Offer authentication redesigned (security + availability)
- Message signing removed entirely. Posting an offer now proves account
  control with a **1-tinybar self-transfer carrying a server-issued nonce in
  its memo**, verified against the mirror node's REST API for three facts the
  wallet cannot fake: transaction succeeded, fee payer is the claimed account,
  and the memo carries that account's unused nonce.
- The SDK's `TransactionRecordQuery` was removed from all reads: it demands an
  operator identity this platform deliberately refuses to hold. Every ledger
  read the API makes now goes through the mirror node's REST interface.
- **Indexing-window fix** — a transaction that has reached consensus but is not
  yet indexed answers 404 from the mirror for several seconds. Both readers
  (transaction records and topic messages) now retry on a short bounded
  schedule (0.5 s / 1 s / 2 s) before absence is reported as final. This race
  silently rejected the first real offers users attempted to post.
- **First-turn user errors are no longer swallowed.** Offer-submission errors
  persist on screen and log their full cause chain, so a user whose wallet paid
  for a transaction that then failed to record keeps the evidence needed to
  recover it.

### Settlement engine (money movement, on the ledger's word only)
- New `settlement-check.js` verifies a reported payment from mirror-node
  facts: exact seller leg, buyer charged price *plus* network fee, memo bound
  to the offered trade. Amounts are compared as BigInt tinybars because float
  comparison is how "paid the posted amount" and "did not" round to the same
  value.
- New `attestation-check.js` and `mirror-node.js` modules centralise the
  reads, and **integration tests run the real INSERT against a real
  PostgreSQL** — after an earlier release was broken in a way only the real
  schema could reveal.
- **Migration 006** — a trade that consumes an entire offer now records
  correctly. Previously the resulting exactly-zero remaining energy violated
  the `CHECK (energy_amount_kwh > 0)` constraint *after* the buyer's payment
  had already settled on-chain; the defect was reproduced red against the live
  database before the fix and green after, and shipped as a new numbered
  migration because applied migrations are immutable.

### Wallet & frontend experience
- Proof transactions sign through the HashPack DAppSigner and execute from the
  dApp; the consumer payment path sets the offer-bound memo automatically, so
  the settlement rule holds without asking the buyer to type anything.
- Wallet connection was debugged against measured evidence rather than
  theory: clicking was verified with `elementFromPoint`, which found a status
  overlay absorbing the click (`z-index: 50`); an install prompt that hid
  itself after six seconds is now persistent with a CSP-safe plain anchor;
  extension discovery polls for up to four seconds with re-pings before
  reporting "HashPack is required", guarded against double popups.

### Diagnostics & tests
- 214 backend tests (213 passing; 1 skipped when no PostgreSQL is configured),
  46 frontend tests (all passing), production builds verified.
- The free static scanner is calibration-first: it plants known
  vulnerabilities and aborts unless the ruleset catches them, so "no findings"
  can never be reported more loudly than the scanner's demonstrated catch
  rate. Its one finding in the new code (wildcard `postMessage` in wallet
  discovery) is a public, secret-free ping mirroring the upstream protocol,
  documented in-code.
- Three one-off probe scripts kept under `scripts/` for re-verifying a live
  trade end to end (constraint state, offer/trade state, replay of the
  recording step only).

## Live milestones (testnet, verified on the mirror node)
- **First-ever live offer** posted by a real, unprivileged wallet via the new
  proof path — accepted, nonce consumed seconds after consensus.
- **First full end-to-end two-party trade**: an independent buyer paid a
 seller directly, peer-to-peer — the ledger shows the exact payment leg, the
  buyer charged price plus network fee, and the memo bound to the offer. The
  trade row recorded `completed`; the offer field records the exact
  full-consumption case migration 006 now handles. Bookkeeping failures are
  recoverable *without* a second payment because duplicate detection keys on
  the on-chain transaction id.

## Testnet transactions are public data
Testnet transaction ids and offers referenced in code comments and diagnostics
are public ledger entries on purpose — the design makes money movement
independently verifiable by anyone against the public mirror. No private keys,
credentials, or enabling detail for any network appear in any tracked file.

## Open items before the mainnet migration
- ~~Triage Dependabot's dependency alerts (reported at the `95bfa95` push).~~
  **Done 2026-11-02 (see `SECURITY.md`):** the stale root monolith manifest was
  pruned (90 alerts gone), and every production-reachable critical and high
  advisory is remediated — backend audits **0 critical / 0 high** with the full
  213-passing suite green, frontend audits 0 critical with 46/46 tests and a
  green build. The residual high alerts have no fixed versions upstream
  (`@reown/appkit` family, `zod` via the wallet-connect chain) and are recorded
  as documented accepted risks.
- HCS attestation topic submit-key policy and topic split.
- KYC / regulatory framing for public communications.
- The mainnet guard (`config.js` rejects any `HEDERA_NETWORK` other than
  `testnet`) stays locked until the migration flip is a deliberate, reviewed
  step.
