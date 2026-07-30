# Start Horde backend + frontend for local development.
# Usage: .\scripts\dev.ps1   (or double-click dev.bat from repo root)
#
# Set SKIP_WIKI=1 to skip the MkDocs build (Settings → Documentation stays hidden).

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

function Test-WikiNeedsBuild {
    param([string]$WikiIndex, [string]$Stamp)
    if (-not (Test-Path $WikiIndex)) { return $true }
    if (-not (Test-Path $Stamp)) { return $true }
    $stampTime = (Get-Item $Stamp).LastWriteTimeUtc
    $mkdocs = Join-Path $Root "mkdocs.yml"
    if ((Get-Item $mkdocs).LastWriteTimeUtc -gt $stampTime) { return $true }
    $docsDir = Join-Path $Root "docs"
    $newer = Get-ChildItem -Path $docsDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -gt $stampTime } |
        Select-Object -First 1
    return $null -ne $newer
}

$python = Get-PythonCmd
$backendDir = Join-Path $Root "backend"
$frontendDir = Join-Path $Root "frontend"
$venvDir = Join-Path $Root ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$venvStamp = Join-Path $venvDir ".horde-reqs-stamp"
$venvDevStamp = Join-Path $venvDir ".horde-dev-reqs-stamp"
$wikiStamp = Join-Path $venvDir ".horde-wiki-stamp"
$reqs = Join-Path $backendDir "requirements.txt"
$devReqs = Join-Path $backendDir "requirements-dev.txt"
$wikiIndex = Join-Path $Root "backend\static\wiki\index.html"

if (-not (Test-Path $venvPython)) {
    Write-Host "Creating Python venv at $venvDir ..."
    & $python -m venv $venvDir
}
$python = $venvPython

$needReqs = -not (Test-Path $venvStamp) -or ((Get-Item $reqs).LastWriteTimeUtc -gt (Get-Item $venvStamp).LastWriteTimeUtc)
if ($needReqs) {
    Write-Host "Installing backend dependencies ..."
    & $python -m pip install -r $reqs
    New-Item -ItemType File -Force -Path $venvStamp | Out-Null
}

$needDevReqs = -not (Test-Path $venvDevStamp) -or ((Get-Item $devReqs).LastWriteTimeUtc -gt (Get-Item $venvDevStamp).LastWriteTimeUtc)
if ($needDevReqs) {
    Write-Host "Installing backend dev dependencies (pytest, mkdocs-material) ..."
    & $python -m pip install -r $devReqs
    New-Item -ItemType File -Force -Path $venvDevStamp | Out-Null
}

$skipWiki = $env:SKIP_WIKI -eq "1"
if ($skipWiki) {
    Write-Host "SKIP_WIKI=1 — not building wiki (wiki_available will stay false until you build)."
} elseif (Test-WikiNeedsBuild -WikiIndex $wikiIndex -Stamp $wikiStamp) {
    Write-Host "Building MkDocs wiki into backend/static/wiki ..."
    Push-Location $Root
    try {
        & $python -m mkdocs build -d backend/static/wiki --strict
    } finally {
        Pop-Location
    }
    New-Item -ItemType File -Force -Path $wikiStamp | Out-Null
    Write-Host "Wiki ready at /wiki/ (via Vite proxy or http://127.0.0.1:8080/wiki/)."
} else {
    Write-Host "Wiki already up to date at backend/static/wiki."
}

$nodeModules = Join-Path $frontendDir "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "Installing frontend dependencies ..."
    $npmInstall = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
    Push-Location $frontendDir
    try {
        & $npmInstall install
    } finally {
        Pop-Location
    }
}

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
