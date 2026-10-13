# Security scanning with Strix

[Strix](https://github.com/usestrix/strix) is an autonomous AI penetration-testing
agent. It runs your code, finds vulnerabilities, and validates them with real
proofs of concept. This project uses it to support bug fixing and vulnerability
handling.

**Apache-2.0. Local execution. Authorized use only.**

## Setup status

| Component | Status |
|---|---|
| Installed | `C:\Users\ajovi\.agents\tools\strix\.venv\Scripts\strix.exe` (v1.7.0) |
| Docker daemon | running |
| Ollama | installed; `llama3.2` present |

## Cost: there are two free options

Strix is an LLM agent, so it needs a model. **Neither option below costs money.**

### Option A — Free OpenRouter models (recommended)

Free-tier models are rate limited but cost $0. They need a **free** OpenRouter
key from <https://openrouter.ai/keys>; no payment details required.

```powershell
$env:STRIX_LLM   = "openrouter/nvidia/nemotron-3.5-lightning:free"
$env:LLM_API_KEY = "<free key>"
.\scan-security.ps1 -Target quick
```

Model slugs verified against the OpenRouter API on 2026-10-12:

| Model | Context |
|---|---|
| `openrouter/nvidia/nemotron-3.5-lightning:free` | 1M |
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | 262k |
| `openrouter/google/gemma-4-31b-it:free` | 262k |
| `openrouter/openrouter/free` | auto-router |

> A pasted list of "free" slugs circulated online was largely invalid — only
> 7 of 26 resolved. Confirm a slug before using it:
> `Invoke-RestMethod https://openrouter.ai/api/v1/models`

### Option B — Fully local (no key, no network)

Ollama is already installed. Nothing leaves the machine.

```powershell
ollama pull qwen2.5-coder:7b      # ~4.7 GB, tuned for code
$env:STRIX_LLM = "ollama/qwen2.5-coder:7b"
.\scan-security.ps1 -Target quick
```

Hardware note: this machine has an RTX 3060 Laptop (6 GB VRAM) and 16 GB RAM,
so a 7B model at Q4 is the practical ceiling. Expect slower runs than a hosted
model, and lower-quality findings on complex reasoning.

For paid models, pass one through and the runner caps spend:

```powershell
.\scan-security.ps1 -Target standard -BudgetUsd 5 -Model "openrouter/z-ai/glm-5.3"
```

## Scope rules

Strix executes live attack tooling. Scope is not optional.

**Allowed**

- `http://localhost:3000` — the API
- `http://localhost:4300` - the Vite frontend
- a sanitised copy of the source tree

**Never**

- The deployed Render/Netlify hosts. An autonomous scanner against shared
  hosting can trip abuse detection and get the service suspended.
- Any third-party system you do not own.
- The repository root. `EnergySwapBackend/.env` holds the Hedera operator key,
  HCS topic and energy token IDs, and five news API keys. Scanning it hands
  those to a third-party LLM provider.

## Usage

Build a sanitised copy first:

```powershell
$src  = "C:\Users\ajovi\Documents\EnergySwap v1"
$copy = "C:\Users\ajovi\AppData\Local\Temp\energyswap-scan"
Remove-Item $copy -Recurse -Force -ErrorAction SilentlyContinue
robocopy $src $copy /E /XD node_modules dist .git /XF .env
```

Live API scan (start the backend first with `npm run dev`):

```powershell
$env:STRIX_LLM   = "your-provider/your-model"
$env:LLM_API_KEY = "your-key"
strix -n --target http://localhost:3000 --scan-mode quick
```

Source review of the sanitised copy:

```powershell
strix -n --target $copy --scan-mode quick
```

Findings land in `strix_runs/<run-name>`. Open the most recent with `strix view`.

## What to expect here

Known, documented weaknesses that are design decisions rather than defects:

- **A connected wallet is not server-side proof of ownership for legacy offer
  creation.** Offer posting optionally accepts wallet signatures
  (`REQUIRE_WALLET_SIGNATURE`, default off). Record settlement is proven
  on-ledger instead.
- **Rate limiting is in-memory and per-process.** Not shared across replicas.
- **`npm audit` reports high-severity advisories** in the Hedera and wallet
  dependency trees, including protobufjs. Automatic fixes fall outside the
  declared compatibility range and were not forced.
- **Energy tokens require a trusted grid gateway** to attest generation. That is
  an explicit trust assumption, not a bug.

See the README for the full Mainnet release gates.