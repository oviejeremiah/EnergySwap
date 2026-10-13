<#
.SYNOPSIS
    Free, offline static security analysis for EnergySwap. No LLM, no account,
    no rate limits, no network calls to any third party.

.DESCRIPTION
    Strix cannot run for free: the local Ollama models cannot emit structured
    tool calls, and OpenRouter's free tier allows only 50 requests/day. This
    script is the always-available replacement.

    Two phases:
      1. Calibration - plants a file with known vulnerabilities and confirms the
         ruleset actually fires. A scanner that reports "clean" because it is
         broken is worse than no scanner, so this runs first and aborts on a miss.
      2. Scan - runs every free rule pack over the source, file by file.

    Scan the repository directly. Static analysis only reads files, so there is
    no need to sanitise a copy first.

.PARAMETER Path
    Directory to scan. Defaults to the repository root.

.PARAMETER SkipCalibration
    Skip the planted-bug check. Only useful for re-runs you already trust.

.EXAMPLE
    .\scan-static.ps1

.EXAMPLE
    .\scan-static.ps1 -Path ..\EnergySwapBackend
#>
[CmdletBinding()]
param(
    [string]$Path,
    [switch]$SkipCalibration
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Path) { $Path = $repoRoot }
$tmp = Join-Path $env:LOCALAPPDATA "Temp\energyswap-static"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Find-Semgrep {
    $onPath = Get-Command semgrep -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($d in @("$env:APPDATA\Python\Python314\Scripts", "$env:APPDATA\Python", "$env:LOCALAPPDATA\Programs\Python\Python314\Scripts")) {
        $hit = Get-ChildItem $d -Filter "semgrep.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$semgrep = Find-Semgrep
if (-not $semgrep) {
    Write-Host "Semgrep is not installed. Install with:" -ForegroundColor Red
    Write-Host '  python -m pip install semgrep' -ForegroundColor Yellow
    exit 1
}
$env:PATH = (Split-Path -Parent $semgrep) + ';' + $env:PATH

Write-Host "Static analysis - free, offline, no LLM" -ForegroundColor Cyan
Write-Host "  semgrep : $semgrep"
Write-Host "  target  : $Path"

# ── Phase 1: calibration ─────────────────────────────────────────────────────
# Proves the ruleset fires before we trust a clean result from it.
if (-not $SkipCalibration) {
    $cal = Join-Path $tmp "calibration"
    Remove-Item $cal -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $cal | Out-Null

    # Deliberately vulnerable. If these do not fire, the scan proves nothing.
    @'
const { exec } = require('child_process');
const crypto = require('crypto');
const password = "SuperSecret123";
function run(cmd) { return exec(cmd); }
function query(id) { return db.query("SELECT * FROM offers WHERE id = " + id); }
function weak(pw) { return crypto.createHash('md5').update(pw).digest('hex'); }
'@ | Set-Content (Join-Path $cal "planted.js")

    $calJson = Join-Path $tmp "calibration.json"
    & $semgrep scan --config p/javascript --config p/owasp-top-ten --config p/security-audit `
        --json --output $calJson --metrics=off --timeout 15 --quiet (Join-Path $cal "planted.js") 2>$null | Out-Null

    $caught = 0
    if (Test-Path $calJson) {
        try { $caught = ((Get-Content $calJson -Raw | ConvertFrom-Json).results | Measure-Object).Count } catch { }
    }
    if ($caught -eq 0) {
        Write-Host "`nCALIBRATION FAILED - the ruleset caught nothing in a file with" -ForegroundColor Red
        Write-Host "known vulnerabilities. Results below would be meaningless. Aborting." -ForegroundColor Red
        exit 2
    }
    Write-Host "`n  calibration OK - ruleset caught $caught planted issue(s)" -ForegroundColor DarkGray
}

# ── Phase 2: scan ────────────────────────────────────────────────────────────
$configs = @(
    'p/javascript', 'p/security-audit', 'p/owasp-top-ten', 'p/secrets',
    'p/insecure-transport', 'p/sql-injection', 'p/xss', 'p/gitleaks'
)
$cargs = $configs | ForEach-Object { @('--config', $_) }

# Scanned file by file: whole-directory scans crash semgrep-core on Windows.
$files = Get-ChildItem $Path -Recurse -File -Include *.js, *.mjs, *.cjs -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch 'node_modules|\\dist\\|\\build\\|strix_runs|\\test\\|\.min\.' }

Write-Host "`nScanning $($files.Count) file(s) with $($configs.Count) rule packs..." -ForegroundColor Cyan

$all = @()
$i = 0
foreach ($f in $files) {
    $i++
    $out = Join-Path $tmp "scan-$i.json"
    & $semgrep scan @cargs --json --output $out --metrics=off --timeout 15 --quiet $f.FullName 2>$null | Out-Null
    if (Test-Path $out) {
        try {
            $r = (Get-Content $out -Raw | ConvertFrom-Json).results
            if ($r) { $all += $r }
        } catch { }
    }
    Remove-Item $out -Force -ErrorAction SilentlyContinue
}

Write-Host "`nFINDINGS: $($all.Count)" -ForegroundColor $(if ($all.Count) { 'Yellow' } else { 'Green' })

if ($all.Count) {
    $all | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $tmp "findings.json")
    Write-Host "Saved to $(Join-Path $tmp 'findings.json')" -ForegroundColor DarkGray
    $all |
        Sort-Object { $_.path } |
        ForEach-Object {
            $rel = $_.path -replace [regex]::Escape($Path), '.'
            "`n  [$($_.extra.severity.ToUpper())] $($_.check_id)"
            "    $rel`:$($_.start.line)"
            "    $(($_.extra.message -replace '\s+',' '))"
        }
} else {
    Write-Host @'

  No issues matched. Calibration passed, so the ruleset did run - but these free
  packs are shallow. In testing they caught only 1 of 5 deliberately planted bugs
  (child_process exec; they missed SQL concatenation, a hardcoded password and
  MD5). Treat this as "no obvious patterns found", not "secure".
'@ -ForegroundColor DarkGray
}

exit $(if ($all.Count) { 1 } else { 0 })