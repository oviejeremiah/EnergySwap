# Independent Review Log

A record of external specialist reviews of EnergySwap, what each one found, and
what was done about it. Each entry states its own evidence level so a later
reader can tell a verified fix from an assumption.

Entries are appended, newest first. Nothing here is a claim that the platform is
secure or correct — see "What remains unproven" in the newest entry.

---

## 2026-10-13 — First review cycle

**Scope.** The 44-file working tree held in checkpoint `a80d13b`: operator-key
removal, on-chain identity bindings, any-wallet sign-in, UI/UX work, and the
free static scanner.

**Why it happened.** Services were answering on :3000 and :4300. That was not
treated as evidence of anything. Three specialists reviewed the tree
independently, before any further changes were made.

**State preservation.** `a80d13b` was committed locally first so the reviewers
had a stable diff. Nothing was pushed at any point in this cycle. Undo with
`git reset --hard a80d13b`.

### Reviewers

| Specialist | Scope |
|---|---|
| `code-reviewer` | All 44 files against the platform's architectural constraints |
| `cybersecurity-engineer` | `record-trade` money path, identity-binding verification |
| `devops-engineer` | Render config, secrets handling, health checks, durability |

### Evidence convention

- **Verified** — reproduced or read directly from the code/schema before acting.
- **Reported** — a specialist's finding accepted without independent reproduction.
- **Unverified** — could not be checked from this machine.

Most findings below were **verified** before any change was made. That mattered:
three of the fixes introduced their own defects, which are recorded honestly in
"What this cycle got wrong".

### Findings accepted and fixed

#### F1 — `record-trade` could never persist a trade · **CRITICAL**

`recordTrade`'s INSERT listed 14 columns. Migration 003 had added
`buyer_address`, `seller_address`, `payment_amount` and `payment_fee` as
`NOT NULL` with no default. Every insert failed with SQLSTATE 23502.

**Verified** against the live database: all four columns confirmed
`nullable=NO default=NONE`, and migration 003 recorded as applied in
`schema_migrations`.

Impact: the buyer pays, the row insert fails, the response is a 500, and the
frontend tells the buyer *"HBAR payment confirmed, but trade recording failed.
Do not pay again."* Money gone, no trade, no offer decrement.

**Fixed.** All four columns are now supplied explicitly rather than via column
defaults, with a pre-check that fails with a named error if any is missing —
so a future caller omission produces a clear message instead of an opaque
constraint violation after the payment.

**Regression guard:** `test/record-trade-db.test.js` runs the real INSERT
against a real PostgreSQL schema. A mocked pool would not have caught this
class of bug and is exactly why it went unnoticed.

#### F2 — Plain HBAR accepted as proof of an energy-token credit · **HIGH**

`htsCreditError` matched a credit leg on account and amount only. On Hedera an
HBAR transfer leg carries no `tokenId` and an amount scaled in tinybar, so an
ordinary payment of the right magnitude satisfied the check — on an endpoint
with no authentication beyond rate limiting, marking a meter reading
`credited`, the status that means energy has been released.

**Verified** by reading the function. **Fixed**: the credit leg must carry the
configured `energyTokenId`, and the function fails closed when no token is
configured. 8 tests in `test/hts-credit-verification.test.js`, including the
forgery itself.

#### F3 — Unauthenticated identity unlink · **HIGH**

`DELETE /api/identity/binding` took an address and deleted it. No signature, no
nonce, no session. A scripted loop would de-link every user on the platform.

**Verified** by reading the route. **Fixed**: unlinking requires an EIP-191
signature over a server-issued nonce, recovered and compared to the address
being unlinked. Nonce is address-scoped, single-use, and expires in 10 minutes.
`ethers` was added to the backend as a direct dependency — it previously had no
signature library at all. 11 tests in `test/unlink-authorisation.test.js`.

#### F4 — Dead unique-violation handler turned replays into 500s · **MEDIUM**

The handler matched `trades_transaction_id_key`, but migration 003 had renamed
that constraint. The branch could never fire, so re-submitting a transaction
the platform had already recorded returned 500 instead of an idempotent success
— to a buyer who had just been told their payment was confirmed.

**Verified** against the migration file and `repository.js`. **Fixed**: matches
on SQLSTATE, and re-reads scoped by settlement network to distinguish a genuine
duplicate from an unrelated collision.

#### F5 — No server-side ceiling on claimed kWh · **HIGH**

The frontend capped `kwhTraded` at the offer's energy, but the API did not. An
API-direct caller could claim more kWh than the offer held. `recordTrade` then
set the row to `reconciliation_required` and deliberately did *not* debit the
offer — and no route anywhere transitions that status, while re-POSTing the
same transaction returns 409 forever. The paid trade was stranded permanently
and invisible through `/api/trades`.

The caller could only lose their own money, but it was an unrecoverable loss
reachable by any stale client or API bug.

**Fixed** in `server.js` before any chain query runs, so nothing is charged.
2 tests in `test/trade-ceiling.test.js`, including a fractional remainder so
the guard cannot reject legitimate claims.

#### F6 — Gateway never persisted transaction IDs · **MEDIUM-HIGH**

`gateway.js` recorded settlement intent before touching the chain, then mutated
the transaction IDs on the in-memory object and deleted the entry from disk
without ever writing them. `recover()` filtered on those IDs, so it was dead
code that always reported nothing to recover.

A crash after settlement but before the API call therefore left energy credited
on chain with no platform record — reconcilable only by hand.

**Fixed**: the updated entry is appended before reporting, `readJournal`
collapses duplicate entries by `readingId` keeping the most complete, and
compaction is now atomic (temp file plus rename) so a crash mid-truncate cannot
destroy other pending entries. 7 tests in `test/gateway-journal.test.js`.

#### F7 — Unbounded nonce stores and an unbounded mirror-node call · **MEDIUM**

`pendingNonces` and `unlinkChallenges` had no size cap — expiry alone is not a
bound, since a caller can issue faster than entries expire. Both were scanned
in full on every request, making growth an algorithmic cost as well as a
memory cost. `fetchTopicMessages` had no timeout, so a hanging mirror node
pinned request sockets open indefinitely. `/api/wallet-auth/challenge` was the
only state-allocating route with no rate limiter.

**Fixed**: a `MAX_PENDING_NONCES` ceiling evicting oldest-first, an 8-second
`AbortSignal` on the fetch, and the rate limiter applied.

#### F8 — Error disclosure in the identity routes · **MEDIUM**

The disclosure fix applied to the other routes was never applied to the identity
routes, which were added afterwards. `result.reason` quoted the upstream
mirror-node HTTP status and was returned to clients verbatim.

**Fixed**: reasons are logged server-side with the request ID; clients receive
fixed text.

#### F9 — Production build shipped `localhost` to every visitor · **HIGH**

`VITE_BACKEND_API_URL` fell back to `http://localhost:3000`, and the same
fallback was hardcoded a second time in a plain inline `<script>` in
`index.html` that Vite does not transform. `.env.local` is gitignored, so a
deploy from a clean clone gets the fallback. Every API call from every visitor
would go to their own machine — while the deploy reported success.

**Verified**: the string is present in the existing `dist/`.

**Fixed** with a build-time guard that fails the build rather than shipping it.
`vite.config.js` needed `loadEnv` to see `.env.local`, since a config file
cannot read it through `process.env`.

#### F10 — Render hardening · **MEDIUM-HIGH**

Added `ipAllowList: []` (without it Render accepts connections from any IP for a
newly created database, so a leaked `DATABASE_URL` means direct internet access
to the whole ledger) and `autoDeployTrigger: checksPass` (CI runs, but nothing
blocked deploy).

`OPERATOR_ID`/`OPERATOR_KEY` were removed from the blueprint. This does **not**
break boot: `config.js` throws only when exactly one of the pair is set.

### Findings accepted but deliberately not actioned

#### The operator key is still loaded · **user decision pending**

`config.js` still requires and exposes `OPERATOR_ID`/`OPERATOR_KEY` as
`config.operatorId`/`operatorKey`, and `server.js` puts that object on
`app.locals.config` — one line away from a signing identity.

**Nothing signs with it.** The behaviour is correct and `setOperator` appears
only in `gateway/` and the archived legacy scripts.

This was **kept deliberately** by the user, for post-mainnet IoT grid metering,
and has not been touched. It does contradict the stated principle that the
platform holds no signing identity, and that tension should be recorded rather
than quietly resolved either way.

#### Settlement overclaim · **OPEN**

`repository.mapOffer` publishes `settlementNetwork`, `settlementAsset`,
`sellerAddress` and `pricePerKWh` to API clients. Every current row is HBAR, so
nothing is misrepresented today — but migration 003's CHECK constraint permits
ETH and BTC settlement that **nothing in the running API can verify**:
`settlement-verification.js` (230 lines) is required only by its own test.

Latent, not active. Either wire it up or stop publishing the fields.

#### Identity attestations share the meter HCS topic · **OPEN**

`IDENTITY_TOPIC` is the same topic meter attestations use, and
`fetchTopicMessages` scans only the newest 25 messages. Once meter attestations
flow, a legitimate identity attestation can fall outside the window and
verification fails with a misleading message. An attacker publishing 25 junk
messages could deny binding, though they still could not forge one — the payer
check at the heart of `verifyBinding` holds regardless.

The 8-second timeout from F7 bounds the cost but does not fix the window.

#### Frontend `selectedRole = 'browsing'` sentinel · **OPEN**

A documented `'prosumer' | 'consumer'` field is set to an internal sentinel,
which then renders as *"Signed in as browsing with MetaMask (0x…)"*, skips the
role-specific dashboard branch, and leaves a prosumer's offers list stale.

### Things reviewed and confirmed sound

Recorded so they are not re-litigated:

- `updateMeterReading`'s dynamic column builder filters keys against a frozen
  allow-list **before** building the SET clause; values stay parameterised.
- Every query in `saveIdentityBinding` and the getters is parameterised.
- `verifyBinding`'s payer check is the first test in the loop, before the
  payload is even decoded, and the forged-attestation test genuinely fails if
  it is removed.
- Binding nonces are single-use, expiring, and scoped to the exact
  (EVM, Hedera) pair. Fail-closed on every error path; the nonce is burned
  before the database write.
- `wallet-auth.js` burns its nonce before verifying the signature, and handles
  both Ed25519 and ECDSA secp256k1.
- No money path authorises on a stored identity-binding row. `canTrade` is
  returned by the read-only GET but is consumed by nothing.
- Mainnet guard intact in both `config.js` and `gateway.js`, pinned by test.
- **No secrets in git.** Verified across all tracked files, including the
  OpenRouter key that had been used earlier in the project.
- `/health/ready` genuinely awaits `SELECT 1` and returns 503 when Postgres is
  down. A readiness probe that lies was a specific concern; it does not.
- `db.json` is not a runtime store — only `scripts/import-json.js` and the scan
  sanitiser reference it.
- Migrations run under `pg_advisory_xact_lock` and are concurrency-safe.

### What this cycle got wrong

Recording these because they are the kind of thing a review log that only lists
successes would hide.

1. **An earlier diagnosis was incomplete, and it was mine.** The failed trade
   was attributed to an unfunded testnet account. That was only part of the
   cause: F1 means the trade could not have been recorded even with funds. The
   conclusion was drawn from chain state without testing the recording path.

2. **Migration 004 was edited in place first.** The one-to-one constraint was
   added by rewriting a migration that had already been applied — a silent
   no-op on every database that recorded it, including production. Reverted;
   the constraint and its dedupe step ship as migration 005. The lesson is in
   the global lessons file.

3. **Two files were corrupted by a PowerShell text round-trip**, introducing a
   UTF-8 BOM. Caught by a BOM sweep over all changed files and stripped. No
   lossy encoding damage remains.

4. **A test passed for the wrong reason.** The unlink tests asserted wallet
   addresses that `new Wallet(privateKey)` does not produce, so every
   "rejects a different wallet" case was rejected for the wrong reason. Fixed to
   derive addresses from keys, plus a guard test asserting the two wallets
   actually differ.

5. **A `render.yaml` change was recorded as a fix but was not one.**
   `REQUIRE_WALLET_SIGNATURE` was added as `sync: false`. `config.js` reads
   `env.REQUIRE_WALLET_SIGNATURE === 'true'`, so an unset variable means
   **false** — production offer posting is still unauthenticated. The comment
   has been corrected, and the real finding is recorded below.

### What remains unproven

Stated plainly, because a green test run invites the opposite conclusion.

- **No trade has ever completed end to end.** F1–F5 are verified by direct
  tests against a real database, but no HBAR has moved through the full flow.
  Funding `0.0.10855100` and retrying is still the outstanding proof.
- **The offer-posting impersonation gap is open.** Anyone can post an offer
  claiming any Hedera account as `prosumerId`. It cannot be closed by setting
  `REQUIRE_WALLET_SIGNATURE=true`, because the frontend implements no challenge
  flow — `post-offer` sends only `prosumerId`, `energyAmountKWh` and
  `hbarPerKWh`. The client flow must be built first.
- **The frontend has no tests at all.** `updateTradeGate` and `selectOffer` are
  pure enough to test and are the exact logic that already regressed once.
- **Rate-limiter effectiveness behind Render's proxy is unverified.**
  `trust proxy: 1` resolves to the rightmost `X-Forwarded-For` entry, which is
  only correct if Render's edge appends. That could not be checked from here.
- **Render's production database state is unverified.** Whether migration 005
  has been applied there is unknown.
- **The free static scan is weak evidence.** It plants known bugs to confirm the
  ruleset fires, but catches only 1 of 5 planted bugs — it missed SQL
  concatenation, a hardcoded password and MD5. It reported 0 findings here. Read
  that as "no obvious patterns", not "secure". Notably it did **not** find F1.
- **The in-memory nonce and challenge stores are per-process.** A multi-instance
  deploy would fail intermittently unless they are moved to shared storage.

### Verification performed

| Check | Result |
|---|---|
| `npm test` (backend) | 94 tests, 93 pass, 0 fail, 1 skipped |
| Skipped test | `postgres.integration.test.js` — needs a disposable database, by design |
| New: `record-trade-db.test.js` | 6 pass against the live database |
| New: `hts-credit-verification.test.js` | 8 pass |
| New: `unlink-authorisation.test.js` | 11 pass |
| New: `gateway-journal.test.js` | 7 pass |
| New: `trade-ceiling.test.js` | 2 pass |
| `scan-static.ps1` | 0 findings, calibration confirmed the ruleset ran |
| Frontend production build | passes with env vars; **fails loudly without them** |
| Live schema inspection | all four NOT NULL columns confirmed |
| Trade rows in database | 0 — no stranded payments |

### Follow-ups

1. Fund `0.0.10855100` and complete one real trade end to end.
2. Implement the wallet challenge flow in the frontend, then enable
   `REQUIRE_WALLET_SIGNATURE`.
3. Add frontend tests for `updateTradeGate` and `selectOffer`.
4. Decide the operator key's future — keep for grid metering, or remove and
   rely on `gateway/` alone.
5. Either wire up `settlement-verification.js` or stop publishing settlement
   fields the API cannot verify.
6. Move nonce and challenge stores to shared storage before scaling out.