# Reset the PostgreSQL superuser password for this machine.
#
# WHY THIS EXISTS
#   pg_hba.conf requires scram-sha-256 for every local connection, and the
#   'postgres' superuser password is not recorded anywhere on this machine.
#   Without it, EnergySwap cannot create its database role.
#
#   This script temporarily switches local auth to 'trust' (no password), lets
#   you set a new password, then RESTORES scram-sha-256 and verifies it works.
#
# MUST BE RUN AS ADMINISTRATOR (right-click PowerShell -> Run as administrator)
#   Windows denies writes to the PostgreSQL data directory for normal users,
#   even though the ACL lists FullControl.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\reset-postgres-password.ps1

$ErrorActionPreference = 'Stop'

$dataDir = 'C:\Program Files\PostgreSQL\16\data'
$hba     = Join-Path $dataDir 'pg_hba.conf'
$service = 'postgresql-x64-16'
$psql    = 'C:\Program Files\PostgreSQL\16\bin\psql.exe'

# Must be elevated to touch the data dir and restart the service.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw 'Run this from an Administrator PowerShell. Right-click -> "Run as administrator".'
}

if (-not (Test-Path $hba)) { throw "pg_hba.conf not found at $hba" }

# pg_hba.conf ships with the ReadOnly attribute set. Set-Content then fails
# with UnauthorizedAccessException even when the ACL grants FullControl, which
# is misleading — it is the attribute, not the permission. Clear it up front.
$hbaItem = Get-Item $hba -Force
if ($hbaItem.IsReadOnly) {
    Write-Host 'Clearing ReadOnly attribute on pg_hba.conf...' -ForegroundColor Cyan
    $hbaItem.IsReadOnly = $false
}

# ── Backup first. Everything below restores from this. ──────────────────────
$backup = Join-Path $env:TEMP 'pg_hba.conf.backup'
Copy-Item $hba $backup -Force
Write-Host "Backed up pg_hba.conf to $backup" -ForegroundColor Cyan

function Restore-Hba {
    Write-Host 'Restoring pg_hba.conf...' -ForegroundColor Yellow
    $item = Get-Item $hba -Force
    if ($item.IsReadOnly) { $item.IsReadOnly = $false }
    Copy-Item $backup $hba -Force
    Restart-Service $service -Force
    Write-Host 'Restored to scram-sha-256 and restarted the service.' -ForegroundColor Green
}

try {
    # ── 1. Temporarily allow passwordless local connections ─────────────────
    Write-Host 'Switching local auth to trust...' -ForegroundColor Cyan
    $item = Get-Item $hba -Force
    if ($item.IsReadOnly) { $item.IsReadOnly = $false }
    $content = Get-Content $hba
    $patched = $content -replace '^(\s*host\s+all\s+all\s+)(127\.0\.0\.1/32|::1/128)\s+scram-sha-256\s*$', '$1$2 trust'
    $patched = $patched -replace '^(\s*local\s+all\s+all\s+)scram-sha-256\s*$', '$1trust'
    Set-Content -Path $hba -Value $patched
    Restart-Service $service -Force
    Start-Sleep -Seconds 3
    Write-Host 'Trust mode active.' -ForegroundColor Cyan

    # ── 2. Set the new password ────────────────────────────────────────────
    Write-Host ''
    Write-Host 'Choose a new password for the postgres superuser.' -ForegroundColor Cyan
    $newPass = Read-Host 'New postgres password' -AsSecureString
    $plain = [System.Net.NetworkCredential]::new('', $newPass).Password
    if ([string]::IsNullOrWhiteSpace($plain)) { throw 'Password cannot be empty.' }

    $env:PGPASSWORD = $null
    & $psql -U postgres -h localhost -p 5432 -d postgres -v ON_ERROR_STOP=1 `
        -c "ALTER USER postgres WITH PASSWORD '$plain';"
    if ($LASTEXITCODE -ne 0) { throw 'ALTER USER failed.' }
    Write-Host 'Password set.' -ForegroundColor Green

} finally {
    # Always put scram back, even if something above threw.
    Restore-Hba
}

# ── 3. Prove scram actually works with the new password ────────────────────
Write-Host ''
Write-Host 'Verifying the new password over a scram connection...' -ForegroundColor Cyan
$env:PGPASSWORD = $plain
& $psql -U postgres -h localhost -p 5432 -d postgres -c 'SELECT 1 AS ok;' | Out-Null
$env:PGPASSWORD = $null

if ($LASTEXITCODE -ne 0) {
    throw 'scram-sha-256 rejected the new password. Check for typos in step 2.'
}

Write-Host ''
Write-Host 'Done. scram-sha-256 is restored and your new password works.' -ForegroundColor Green
Write-Host 'Now run:  .\setup-local-db.ps1' -ForegroundColor Green