<#
.SYNOPSIS
    Runs a Strix security scan against EnergySwap and reports findings.

.DESCRIPTION
    Automates the safe workflow:
      1. Builds a sanitised copy of the source (excludes .env and secrets)
      2. Runs Strix against that copy and/or the local API
      3. Summarises the findings so they can be fixed together

    Requires STRIX_LLM and LLM_API_KEY in the environment, plus a running
    Docker daemon. Use -BudgetUsd to cap LLM spend; the default is 2.00.

.PARAMETER Target
    quick | standard | deep.  Defaults to quick.

.PARAMETER BudgetUsd
    Maximum LLM spend for the run.  Defaults to 2.00. Ignored for free-tier
    and local (Ollama) models, which cost nothing.

.PARAMETER Model
    Override the model. Defaults to $env:STRIX_LLM. Verified to exist on
    OpenRouter as of 2026-10-12:

      openrouter/nvidia/nemotron-3.5-lightning:free     (recommended)
      openrouter/nvidia/nemotron-3-super-120b-a12b:free
      openrouter/google/gemma-4-31b-it:free
      openrouter/openrouter/free                        (auto-router)
      ollama/qwen2.5-coder:7b                           (fully local)

    Free-tier models are rate limited but cost nothing. They still need a
    free OpenRouter API key, not a paid one.

.PARAMETER ApiOnly
    Scan only the running local API, skip the source copy.

.PARAMETER UseStrix
    Opt into the Strix LLM agent. Off by default, because Strix cannot run for
    free: local models cannot emit structured tool calls, and OpenRouter's free
    tier is 50 requests/day - one scan exhausts that in about four minutes and
    then dies with HTTP 429. The user's standing decision is no payment, so the
    free static scan is what runs unless Strix is explicitly requested.

.EXAMPLE
    .\scan-security.ps1                 # free static analysis (default)

.EXAMPLE
    .\scan-security.ps1 -Strix          # LLM agent, requires funded OpenRouter
#>
[CmdletBinding()]
param(
    [ValidateSet('quick', 'standard', 'deep')]
    [string]$Target = 'quick',

    [double]$BudgetUsd = 2.00,

    [switch]$ApiOnly,

    [string]$Model,

    [switch]$UseStrix
)

$ErrorActionPreference = 'Stop'

$strix     = "$env:USERPROFILE\.agents\tools\strix\.venv\Scripts\strix.exe"
$repoRoot  = Split-Path -Parent $PSScriptRoot
$scanCopy  = Join-Path $env:LOCALAPPDATA "Temp\energyswap-scan"
$apiUrl    = 'http://localhost:3000'

function Fail($message) { Write-Host $message -ForegroundColor Red; exit 1 }

# ── preflight ────────────────────────────────────────────────────────────────
if (-not (Test-Path $strix)) { Fail "Strix is not installed at $strix" }
if ($Model) { $env:STRIX_LLM = $Model }

# Strix persists settings in ~/.strix/cli-config.json and reads it when the
# env var is absent. Mirror that here so the wrapper sees the same model.
if (-not $env:STRIX_LLM) {
    $strixConfig = Join-Path $env:USERPROFILE '.strix\cli-config.json'
    if (Test-Path $strixConfig) {
        try {
            $fromFile = (Get-Content $strixConfig -Raw | ConvertFrom-Json).env.STRIX_LLM
            if ($fromFile) { $env:STRIX_LLM = $fromFile; Write-Host "Model from $strixConfig" -ForegroundColor DarkGray }
        } catch { }
    }
}

# Local Ollama needs no key at all. Free-tier OpenRouter models need a free key.
$modelId  = $env:STRIX_LLM
$isLocal  = $modelId -and $modelId.StartsWith('ollama/')
$isFree   = $modelId -and ($modelId -match ':free$' -or $modelId -eq 'openrouter/openrouter/free')

# Small local models cannot drive Strix. Verified 2026-10-12: qwen2.5-coder:7b
# returned tool calls as raw JSON text instead of structured tool_calls, so with
# force_required_tool_choice the agent never takes a step and hangs silently
# (52 min at 0% GPU, zero findings, no run directory). Refuse loudly instead of
# burning an hour.
if ($isLocal) {
    Fail @"
Local models do not work with Strix: $modelId

It returns tool calls as plain text rather than structured tool_calls, so the
agent cannot advance and the run hangs with no output.

Use a free-tier OpenRouter model instead (verified to support tool calling):

  openrouter/nvidia/nemotron-3.5-lightning:free     1M ctx
  openrouter/nvidia/nemotron-3-ultra-550b-a55b:free  1M ctx
  openrouter/nvidia/nemotron-3-super-120b-a12b:free  262k ctx
  openrouter/google/gemma-4-31b-it:free             262k ctx

These cost nothing. Set one in ~\.strix\cli-config.json alongside a FREE key
from https://openrouter.ai/keys (no payment details needed), then re-run.
"@
}

if (-not $UseStrix) {
    & (Join-Path $PSScriptRoot 'scan-static.ps1')
    exit $LASTEXITCODE
}

if (-not $modelId) {
    Fail @'
Strix was requested but no model is configured.

Edit ~\.strix\cli-config.json:

  {
    "env": {
      "STRIX_LLM":   "openrouter/nvidia/nemotron-3.5-lightning:free",
      "LLM_API_KEY": "<key>"
    }
  }

Note: the free tier allows only 50 requests/day and one scan exhausts that in
roughly four minutes, so Strix will still die partway through without credits.

To run the free static scan instead, just drop the -UseStrix switch.
'@
}

if (-not $env:LLM_API_KEY) {
    $cfgPath = Join-Path $env:USERPROFILE '.strix\cli-config.json'
    $fileKey = $null
    if (Test-Path $cfgPath) {
        try { $fileKey = (Get-Content $cfgPath -Raw | ConvertFrom-Json).env.LLM_API_KEY } catch { }
    }
    if ($fileKey) {
        $env:LLM_API_KEY = $fileKey
    } else {
        Fail "LLM_API_KEY is missing. Add it to the `"env`" block of $cfgPath alongside STRIX_LLM. A free-tier key from https://openrouter.ai/keys is enough; :free models cost nothing."
    }
}

try {
    $dockerServer = docker version --format '{{.Server.Version}}' 2>$null
    if (-not $dockerServer) { Fail 'Docker daemon is not running. Start Docker Desktop first.' }
} catch { Fail 'Docker is not available on PATH.' }

$costNote = if ($isLocal) { 'local model - no API cost' }
           elseif ($isFree) { 'FREE TIER - no API cost (rate limited)' }
           else { "budget cap USD $BudgetUsd" }
Write-Host "Strix scan: mode=$Target  model=$modelId  $costNote  docker=$dockerServer" -ForegroundColor Cyan

# ── sanitised source copy ─────────────────────────────────────────────────────
# Never hand the live repo to a third-party LLM: .env holds the Hedera
# operator key, HCS/topic IDs and several news API keys.
if (-not $ApiOnly) {
    Write-Host "Building sanitised copy at $scanCopy ..." -ForegroundColor DarkGray
    if (Test-Path $scanCopy) { Remove-Item $scanCopy -Recurse -Force }
    robocopy $repoRoot $scanCopy /E /XD node_modules dist .git strix_runs /XF .env db.json *.pem *.key /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "Failed to copy the source tree (robocopy exit $LASTEXITCODE)." }

    $leaked = Get-ChildItem $scanCopy -Recurse -Force -Include '.env','*.pem','*.key' -ErrorAction SilentlyContinue
    if ($leaked) {
        $leaked | ForEach-Object { Write-Host "  removing $($_.Name)" -ForegroundColor Yellow; Remove-Item $_.FullName -Force }
    }
}

# ── run ──────────────────────────────────────────────────────────────────────
$runsDir = Join-Path $scanCopy 'strix_runs'
if (-not $ApiOnly) {
    Write-Host 'Scanning source ...' -ForegroundColor Cyan
    if ($isLocal -or $isFree) {
        & $strix -n -m $Target --target $scanCopy --fail-on critical
    } else {
        & $strix -n -m $Target --max-budget-usd $BudgetUsd --target $scanCopy --fail-on critical
    }
    $sourceExit = $LASTEXITCODE
}

if (-not $ApiOnly -and $sourceExit -eq 2) {
    Write-Host 'Critical findings in source. Stopping before the live API scan.' -ForegroundColor Red
    exit 2
}

# Only hit the local API; never a deployed host.
$apiUp = $false
try { $null = Invoke-RestMethod "$apiUrl/health/live" -TimeoutSec 4; $apiUp = $true } catch {}

if ($apiUp) {
    Write-Host "Scanning $apiUrl ..." -ForegroundColor Cyan
    if ($isLocal -or $isFree) {
        & $strix -n -m $Target --target $apiUrl --fail-on critical
    } else {
        & $strix -n -m $Target --max-budget-usd $BudgetUsd --target $apiUrl --fail-on critical
    }
} else {
    Write-Host "API not running at $apiUrl - start it with 'npm run dev' to include the dynamic scan." -ForegroundColor Yellow
}

# ── report ───────────────────────────────────────────────────────────────────
$latest = $null
foreach ($base in @($scanCopy, $repoRoot)) {
    $dir = Join-Path $base 'strix_runs'
    if (Test-Path $dir) {
        $candidate = Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($candidate) { $latest = $candidate; break }
    }
}

Write-Host ''
if ($latest) {
    Write-Host "Findings: $($latest.FullName)" -ForegroundColor Green
    Write-Host "Open the interactive report with:" -ForegroundColor DarkGray
    Write-Host "  & '$strix' view" -ForegroundColor DarkGray
} else {
    Write-Host 'No run directory produced. Check the output above for errors.' -ForegroundColor Yellow
}