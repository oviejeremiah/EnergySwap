# Agent instructions for EnergySwap

## Security review is mandatory

Scan this repository for vulnerabilities as part of any bug-fix or feature work,
and report findings with severity and reproduction rather than fixing silently.

### The default tool is free static analysis

```powershell
.\EnergySwapBackend\scan-static.ps1
```

Zero cost, offline, no account. Run this by default. It first plants known
vulnerabilities to confirm the ruleset actually fires, then scans every JS file
with 8 free Semgrep packs. Without that calibration step a broken scanner would
report "clean" just as loudly as a secure codebase.

**Calibrate your confidence.** The free packs caught only 1 of 5 planted bugs
(child_process `exec`; they missed SQL concatenation, hardcoded secrets, MD5).
Static analysis finds insecure patterns, not logic flaws. It will not catch
authorization bypass or price-manipulation bugs - read the auth paths yourself.

### Strix needs a paid model and is optional

Use Strix only when the user has funded OpenRouter. It cannot run for free:

| Route | Verdict |
|---|---|
| Local Ollama (7B) | **Broken.** Emits tool calls as raw JSON text, not structured `tool_calls`. With `force_required_tool_choice` the agent never advances — 52 min at 0% GPU, 0 findings, no run dir. |
| OpenRouter `:free` | **Too small.** Free tier is **50 requests/day** (`X-RateLimit-Limit: 50`). One scan burns it in ~4 min, then dies with 429. Resets nightly, still insufficient. |

The user's decision on 2026-10-12 was **no payment**. Do not spend, and do not
re-litigate. If credits are ever added, the model is already configured in
`~/.strix/cli-config.json` as `openrouter/nvidia/nemotron-3.5-lightning:free`
(verified: free, 1M context, `tools` supported).

```powershell
.\EnergySwapBackend\scan-security.ps1 -Target quick   # falls back to static when unconfigured
```

Scope rules below are non-negotiable and apply to both scanners.

### Scope rules (non-negotiable)

These apply to **Strix**, which runs active attack tooling. `scan-static.ps1`
only reads files, so scanning the repository in place is fine for it.

Only ever point Strix at:

- `http://localhost:3000` / `http://localhost:4300` - local instances
- a sanitised copy of the source tree (built by `scan-security.ps1`)

**Never** target the deployed Render/Netlify hosts, or any third-party system
the user does not own. An autonomous scanner against shared hosting can trip
abuse detection and get the service suspended.

**Never** point it at the repository root. `EnergySwapBackend/.env` holds the
Hedera operator key, HCS/topic IDs and five news API keys.

**Never** grant Strix MCP servers with write access (GitHub write, shell, broad
filesystem). Scanning does not need them, and an autonomous agent with those
permissions could push code or edit repositories unattended. If the user ever
asks for this, explain the risk before agreeing.

## Platform architecture (do not regress this)

EnergySwap holds **no signing identity**. Verified by `test/gateway.test.js`,
which asserts the API opens zero Hedera clients when accepting a reading.

- Prosumers set their own price (`hbarPerKWh`) — never an operator-controlled price
- Consumers sign and pay their own HBAR fees
- Meter attestations and energy-token credits are signed by the **grid gateway**
  (`EnergySwapBackend/gateway/`), which owns those keys and pays the fees
- The API only verifies and stores. `setOperator` must not reappear in `server.js`

## Payments

HBAR moves directly between buyer and seller. EnergySwap does not escrow,
custody, or reverse payments. A confirmed on-chain payment is final.

## Mainnet

Mainnet is intentionally disabled. `config.js` rejects any `HEDERA_NETWORK`
other than `testnet`. Do not relax this guard.