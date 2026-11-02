# EnergySwap — Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security report. Use GitHub's
private security advisory ("Report a vulnerability" on this repository's
Security tab) so details reach maintainers before attackers.

## Supported configurations

The platform runs **Hedera testnet only**. `config.js` rejects any
`HEDERA_NETWORK` value other than `testnet`; mainnet support is a deliberate,
separately reviewed migration step that does not exist yet. These facts are
public and are the design, not a configuration choice.

## Deliberate architecture (what an attacker cannot assume)

- **The platform holds no signing identity.** It never signs user
  transactions; prosumers and consumers sign their own. Verified by
  `test/gateway.test.js`, which asserts the API opens zero Hedera clients when
  accepting a reading.
- **Payments are peer-to-peer HBAR transfers** with no escrow and no custody.
  A confirmed on-chain payment is final; the API verifies settlement facts
  from the public mirror node and records them.
- **Grid-gateway keys are separate.** Meter attestations and energy-token
  credits are signed by the gateway, which owns its keys in its own directory.
- **Offer posting is authenticated by a 1-tinybar self-transfer** carrying a
  single-use, time-bounded server-issued nonce in its memo, verified from the
  mirror node's REST API for three facts a wallet cannot fake: success, fee
  payer, and memo.

## Dependency posture

Production-reachable critical and high advisories are remediated per
`CHANGELOG.md` (last full triage 2026-11-02). npm Dependabot may still report
alerts on packages with **no fixed version available**; these are recorded
here as accepted, monitored risks rather than silently ignored.

### Accepted risk: `@reown/appkit` dependency family (HIGH, GHSAs with no fixed version)

`@reown/appkit` and its sub-packages (`appkit-adapter-ethers`,
`appkit-controllers`, `appkit-pay`, `appkit-scaffold-ui`, `appkit-ui`,
`appkit-utils`, `appkit-wallet`) carry high-severity advisories for which
upstream has published **no patched version** (`security_vulnerability
first_patched_version: null`). They are used by `src/wallet-connect.js` for
multi-wallet connection, so removal is a product decision, not a patch.

- **Attack surface:** the dApp's own browser page (user session), not a server.
  Nothing in the EnergySwap API consumes user input the appkit libraries
  produce.
- **Mitigations in place:** HashPack connection is the primary, live-verified
  path; only publicly disclosed advisories are involved; the API holds no keys.
- **Review trigger:** any appkit release with a fixed version, or any change to
  EnergySwap's signing flows.

### Accepted risk: `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5 — memory exhaustion while validating oversized collections)

Patched `zod` exists (4.6.6) but sits behind the wallet-connect/appkit chain,
whose pinned ranges block the bump. Impact is a browser-side memory spike
while validating hostile input — bounded by the page itself, not the server.

### Advisory-metadata anomaly (recorded for the next triage)

Some advisories currently list a "fixed version" **older** than the installed,
live-verified release (for example `@hashgraph/hedera-wallet-connect` reports
patched 2.0.4 while 2.1.3 is installed and verified). Downgrading a
transaction-signing path that has been proven with a real peer-to-peer trade
to satisfy inconsistent advisory metadata is a change of behavior without a
change of risk; those alerts are tracked, reviewed per release, and not
actioned as downgrades.

## Secrets

Every secret lives in a gitignored `.env` (per directory) or the grid
gateway's own `.env`. Only `.env.example` templates with placeholder values
are tracked. The repository is verifiable directly: search tracked files for
PEM/DER key material — there is none.
