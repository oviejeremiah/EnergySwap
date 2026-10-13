# Finish the EnergySwap local setup: create the PostgreSQL role + database,
# apply migrations, then verify the backend answers.
#
# You will be prompted ONCE for your PostgreSQL superuser password.
# It is never echoed, never stored, and never written to disk.
#
# Run:
#   cd EnergySwapBackend
#   .\setup-local-db.ps1

$ErrorActionPreference = 'Stop'

$psql = 'C:\Program Files\PostgreSQL\16\bin\psql.exe'
if (-not (Test-Path $psql)) { throw "psql not found at $psql" }
if (-not (Test-Path '.\setup-local-db.sql')) { throw 'setup-local-db.sql is missing.' }

# psql treats a UTF-8 byte-order mark as part of the first token and aborts
# with a confusing "syntax error at or near" on line 1. Catch it up front.
$sqlBytes = [IO.File]::ReadAllBytes((Resolve-Path '.\setup-local-db.sql'))
if ($sqlBytes.Length -ge 3 -and $sqlBytes[0] -eq 0xEF -and $sqlBytes[1] -eq 0xBB -and $sqlBytes[2] -eq 0xBF) {
    throw 'setup-local-db.sql has a UTF-8 BOM; psql cannot parse it. Rewrite the file without a BOM.'
}

if (-not (Test-Path '.\.env')) { throw '.env is missing. Copy .env.example and fill it in first.' }

# Read the app password straight out of the DATABASE_URL already in .env,
# so you never have to paste it into this script.
$line = Get-Content '.\.env' | Where-Object { $_ -match '^\s*DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { throw 'DATABASE_URL is not set in .env.' }
if ($line -notmatch '://[^:]+:([^@]+)@') { throw 'Could not read the password from DATABASE_URL.' }
$appPassword = $matches[1]

Write-Host ''
Write-Host 'Creating the PostgreSQL role and database...' -ForegroundColor Cyan

# Read the password here rather than letting psql prompt with -W. psql's own
# console prompt does not reliably accept input when psql is launched from a
# PowerShell script, which produced a spurious auth failure. PowerShell's
# Read-Host works, and passing PGPASSWORD is verified to work with scram.
$secure = Read-Host 'PostgreSQL superuser password' -AsSecureString
$superPass = [System.Net.NetworkCredential]::new('', $secure).Password
if ([string]::IsNullOrWhiteSpace($superPass)) { throw 'No password entered.' }

try {
    $env:PGPASSWORD = $superPass
    & $psql -U postgres -h localhost -p 5432 -d postgres -v ON_ERROR_STOP=1 -v "app_password=$appPassword" -f '.\setup-local-db.sql'
    $psqlExit = $LASTEXITCODE
} finally {
    $env:PGPASSWORD = $null
    $superPass = $null
}

if ($psqlExit -ne 0) {
    throw "`nRole/database creation failed. That usually means the superuser password is wrong."
}

Write-Host ''
Write-Host 'Applying database migrations...' -ForegroundColor Cyan
node .\scripts\migrate.js
if ($LASTEXITCODE -ne 0) { throw '`nMigrations failed.' }

Write-Host ''
Write-Host 'Starting the backend to verify...' -ForegroundColor Cyan

# Boot it in the background, then poll /health/ready. That endpoint confirms
# both that the process is up and that the database connection actually works.
$proc = Start-Process -FilePath 'node' -ArgumentList 'server.js' -PassThru -NoNewWindow
$ok = $false
$lastError = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-RestMethod -Uri 'http://localhost:3000/health/ready' -TimeoutSec 3
        $ok = $true
        Write-Host ("  /health/ready -> " + ($r | ConvertTo-Json -Compress)) -ForegroundColor Green
        break
    } catch {
        $lastError = $_.Exception.Message
        if ($proc.HasExited) { break }
    }
}

if ($ok) {
    Write-Host ''
    Write-Host 'Setup complete. The backend is running on port 3000.' -ForegroundColor Green
    Write-Host 'Stop it with Ctrl+C in this window, or run "npm start" again later.' -ForegroundColor DarkGray
} else {
    Write-Host ''
    if ($proc.HasExited) {
        Write-Host 'The backend exited during startup.' -ForegroundColor Yellow
    } else {
        Write-Host "The backend never became ready (last error: $lastError)" -ForegroundColor Yellow
    }
    Write-Host 'Run "npm start" in a terminal to see the full error.' -ForegroundColor Yellow
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}