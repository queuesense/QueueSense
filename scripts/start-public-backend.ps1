# Starts QueueSense locally and exposes it with a temporary public HTTPS URL.
# Keep this PowerShell window open while people use the deployed frontend.

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $projectRoot "backend"
$python = Join-Path $backendRoot ".venv-ai\\Scripts\\python.exe"
$cloudflared = Join-Path $projectRoot "tools\\cloudflared.exe"

if (-not (Test-Path $python)) {
    throw "Backend virtual environment was not found at $python."
}

if (-not (Test-Path $cloudflared)) {
    throw "Cloudflare Tunnel was not found at $cloudflared."
}

Write-Host "Starting QueueSense API at http://127.0.0.1:8000 ..." -ForegroundColor Cyan
$api = Start-Process -FilePath $python -ArgumentList "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000" -WorkingDirectory $backendRoot -PassThru

try {
    Start-Sleep -Seconds 2
    Write-Host "Starting Cloudflare Tunnel. Copy the https://*.trycloudflare.com URL it prints." -ForegroundColor Cyan
    Write-Host "Then put that URL into Vercel as VITE_API_BASE_URL and VITE_PHONE_CAMERA_BASE_URL, then redeploy." -ForegroundColor Yellow
    & $cloudflared tunnel --url http://127.0.0.1:8000
}
finally {
    if (-not $api.HasExited) {
        Stop-Process -Id $api.Id -Force
    }
}
