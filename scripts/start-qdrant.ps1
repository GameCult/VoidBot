Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "infra\qdrant\docker-compose.yml"
$dockerCliDir = "C:\Program Files\Docker\Docker\resources\bin"

if (Test-Path $dockerCliDir) {
  $env:Path = "$dockerCliDir;$env:Path"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI is not available on PATH. Install Docker Desktop first, then rerun this script."
}

& docker version *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker is installed but the daemon is not ready. Start Docker Desktop, finish any first-run prompts, then rerun this script."
}

Write-Host "Starting Qdrant with Docker Compose..."
& docker compose -f $composeFile up -d

if ($LASTEXITCODE -ne 0) {
  throw "Docker Compose failed to start Qdrant."
}

$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:6333" -TimeoutSec 5

    if ($null -ne $response) {
      $healthy = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}

if (-not $healthy) {
  throw "Qdrant container started, but the HTTP API did not become reachable at http://127.0.0.1:6333 in time."
}

Write-Host "Qdrant is up."
Write-Host "API: http://127.0.0.1:6333"
Write-Host "Dashboard: http://127.0.0.1:6333/dashboard"
