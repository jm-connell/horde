# Start Horde backend + frontend for local development.
# Usage: .\scripts\dev.ps1   (or double-click dev.bat from repo root)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$env:DOWNLOADS_DIR = Join-Path $Root "downloads"
$env:DATA_DIR = Join-Path $Root "data"
New-Item -ItemType Directory -Force -Path $env:DOWNLOADS_DIR, $env:DATA_DIR | Out-Null

function Get-PythonCmd {
    if (Get-Command python -ErrorAction SilentlyContinue) { return "python" }
    if (Get-Command py -ErrorAction SilentlyContinue) { return "py" }
    throw "Python not found. Install Python 3 and ensure it is on PATH."
}

function Wait-ForBackend {
    $url = "http://127.0.0.1:8080/api/health"
    for ($i = 0; $i -lt 90; $i++) {
        try {
            # Allow a few seconds — health may briefly probe optional services.
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -eq 200) { return }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Backend did not become ready at $url"
}

function Stop-DevProcess($proc) {
    if ($null -eq $proc -or $proc.HasExited) { return }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}

$python = Get-PythonCmd
$backendDir = Join-Path $Root "backend"
$frontendDir = Join-Path $Root "frontend"

Write-Host "Starting backend on http://127.0.0.1:8080 ..."
$backend = Start-Process -FilePath $python -ArgumentList @(
    "-m", "uvicorn", "app.main:app", "--reload", "--port", "8080"
) -WorkingDirectory $backendDir -PassThru -NoNewWindow

Wait-ForBackend
Write-Host "Backend ready."

Write-Host "Starting frontend (Vite dev server) ..."
$npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
$frontend = Start-Process -FilePath $npm -ArgumentList @("run", "dev") `
    -WorkingDirectory $frontendDir -PassThru -NoNewWindow

Write-Host ""
Write-Host "Horde is running. Open the Vite URL shown above (usually http://localhost:5173)."
Write-Host "Press Ctrl+C to stop both servers."
Write-Host ""

try {
    while (-not $frontend.HasExited) {
        if ($backend.HasExited) {
            throw "Backend exited unexpectedly (code $($backend.ExitCode))."
        }
        Start-Sleep -Milliseconds 200
    }
    if ($frontend.ExitCode -ne 0) {
        exit $frontend.ExitCode
    }
} finally {
    Write-Host "`nStopping servers ..."
    Stop-DevProcess $frontend
    Stop-DevProcess $backend
}
