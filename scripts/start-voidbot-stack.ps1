Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"

function Read-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  if (-not (Test-Path $Path)) {
    throw "Missing .env at $Path"
  }

  $values = @{}

  foreach ($line in Get-Content -Path $Path) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }

    if ($line.TrimStart().StartsWith("#")) {
      continue
    }

    $separatorIndex = $line.IndexOf("=")

    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1)
    $values[$key] = $value
  }

  return $values
}

function Resolve-ConfigPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,
    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $Value,
    [Parameter(Mandatory = $true)]
    [string] $Fallback
  )

  $raw = if ([string]::IsNullOrWhiteSpace($Value)) { $Fallback } else { $Value }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $raw))
}

function Write-StatusFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    [hashtable] $Status
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $Status | ConvertTo-Json -Depth 8 | Set-Content -Path $Path -Encoding utf8
}

function Invoke-JsonGet {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url
  )

  $response = & curl.exe -fsS --connect-timeout 5 --max-time 15 $Url

  if ($LASTEXITCODE -ne 0) {
    throw "Request failed for $Url"
  }

  return $response | ConvertFrom-Json
}

function Test-JsonEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url
  )

  try {
    [void](Invoke-JsonGet -Url $Url)
    return $true
  } catch {
    return $false
  }
}

function Wait-Until {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock] $Condition,
    [Parameter(Mandatory = $true)]
    [string] $FailureMessage,
    [int] $Attempts = 30,
    [int] $SleepSeconds = 2
  )

  for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
    if (& $Condition) {
      return
    }

    Start-Sleep -Seconds $SleepSeconds
  }

  throw $FailureMessage
}

function Test-IsLocalUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url
  )

  $uri = [Uri]$Url
  return $uri.Host -in @("127.0.0.1", "localhost", "::1")
}

function Ensure-DockerOnPath {
  $dockerCliDir = "C:\Program Files\Docker\Docker\resources\bin"

  if (Test-Path $dockerCliDir) {
    $env:Path = "$dockerCliDir;$env:Path"
  }

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI is not available on PATH."
  }

  & docker version *> $null

  if ($LASTEXITCODE -ne 0) {
    throw "Docker is installed but the daemon is not ready."
  }
}

function Ensure-Qdrant {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,
    [Parameter(Mandatory = $true)]
    [string] $QdrantUrl
  )

  $healthUrl = "$($QdrantUrl.TrimEnd('/'))/collections"

  if (Test-JsonEndpoint -Url $healthUrl) {
    return @{
      url = $QdrantUrl
      startedByScript = $false
      healthy = $true
    }
  }

  Ensure-DockerOnPath

  $composeFile = Join-Path $RepoRoot "infra\qdrant\docker-compose.yml"
  & docker compose -f $composeFile up -d

  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed to start Qdrant."
  }

  Wait-Until -Condition { Test-JsonEndpoint -Url $healthUrl } -FailureMessage "Qdrant did not become reachable at $QdrantUrl in time."

  return @{
    url = $QdrantUrl
    startedByScript = $true
    healthy = $true
  }
}

function Ensure-OllamaEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BaseUrl,
    [Parameter(Mandatory = $true)]
    [string] $Model,
    [Parameter(Mandatory = $true)]
    [string] $Label,
    [Parameter(Mandatory = $true)]
    [string] $LogDir
  )

  $tagsUrl = "$($BaseUrl.TrimEnd('/'))/api/tags"
  $startedByScript = $false
  $processId = $null
  $stdoutLog = $null
  $stderrLog = $null

  if (-not (Test-JsonEndpoint -Url $tagsUrl) -and (Test-IsLocalUrl -Url $BaseUrl)) {
    $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue

    if (-not $ollamaCommand) {
      throw "$Label is not reachable at $BaseUrl and the ollama CLI is not available."
    }

    $stdoutLog = Join-Path $LogDir "ollama-local.log"
    $stderrLog = Join-Path $LogDir "ollama-local.err.log"
    $process = Start-Process -FilePath $ollamaCommand.Source -ArgumentList "serve" -WorkingDirectory $repoRoot -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -WindowStyle Hidden -PassThru
    $startedByScript = $true
    $processId = $process.Id
  }

  Wait-Until -Condition { Test-JsonEndpoint -Url $tagsUrl } -FailureMessage "$Label is not reachable at $BaseUrl."

  $tags = Invoke-JsonGet -Url $tagsUrl
  $models = @($tags.models)
  $foundModel = $models | Where-Object { $_.name -eq $Model }

  if (-not $foundModel) {
    throw "$Label is reachable at $BaseUrl, but model '$Model' is not installed."
  }

  return @{
    url = $BaseUrl
    model = $Model
    startedByScript = $startedByScript
    pid = $processId
    stdoutLog = $stdoutLog
    stderrLog = $stderrLog
    healthy = $true
  }
}

function Stop-StaleRuntimeProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot
  )

  $patterns = @(
    "apps\bot\src\index.ts",
    "apps/bot/src/index.ts",
    "apps\bot\dist\index.js",
    "apps/bot/dist/index.js",
    "apps\worker\src\index.ts",
    "apps/worker/src/index.ts",
    "apps\worker\dist\index.js",
    "apps/worker/dist/index.js"
  )

  $processes = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -and
      $_.CommandLine -like "*$RepoRoot*"
    }

  foreach ($process in $processes) {
    $matchesRuntime = $false

    foreach ($pattern in $patterns) {
      if ($process.CommandLine -like "*$pattern*") {
        $matchesRuntime = $true
        break
      }
    }

    if ($matchesRuntime) {
      try {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      } catch {
      }
    }
  }
}

function Wait-ForProcessReady {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process] $Process,
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [Parameter(Mandatory = $true)]
    [string] $LogPath,
    [Parameter(Mandatory = $true)]
    [string] $ErrPath,
    [Parameter(Mandatory = $true)]
    [string] $ReadyText,
    [int] $TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    $Process.Refresh()

    if ($Process.HasExited) {
      $stdoutTail = if (Test-Path $LogPath) { (Get-Content -Path $LogPath -Tail 40) -join "`n" } else { "" }
      $stderrTail = if (Test-Path $ErrPath) { (Get-Content -Path $ErrPath -Tail 40) -join "`n" } else { "" }
      throw "$Name exited early.`nSTDOUT:`n$stdoutTail`nSTDERR:`n$stderrTail"
    }

    if (Test-Path $LogPath) {
      $content = Get-Content -Path $LogPath -Raw -ErrorAction SilentlyContinue

      if ($content -like "*$ReadyText*") {
        return
      }
    }

    Start-Sleep -Seconds 1
  }

  throw "$Name did not report readiness within $TimeoutSeconds seconds."
}

$config = Read-DotEnv -Path $envFile
$storageRoot = Resolve-ConfigPath -RepoRoot $repoRoot -Value $config["STORAGE_ROOT"] -Fallback ".voidbot"
$logDir = Join-Path $storageRoot "logs"
$statusPath = Join-Path $storageRoot "status\runtime-stack.json"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$status = @{
  startedAt = (Get-Date).ToString("o")
  repoRoot = $repoRoot
  statusPath = $statusPath
}

Write-StatusFile -Path $statusPath -Status $status

$vectorStoreKind = if ($config.ContainsKey("VECTOR_STORE_KIND")) { $config["VECTOR_STORE_KIND"] } else { "local_json" }
$qdrantUrl = if ($config.ContainsKey("QDRANT_URL")) { $config["QDRANT_URL"] } else { "http://127.0.0.1:6333" }
$ragBackend = if ($config.ContainsKey("RAG_EMBEDDING_BACKEND")) { $config["RAG_EMBEDDING_BACKEND"] } else { "ollama" }
$ragOllamaBaseUrl = if ($config.ContainsKey("RAG_OLLAMA_BASE_URL")) { $config["RAG_OLLAMA_BASE_URL"] } else { "http://127.0.0.1:11434" }
$ragOllamaModel = if ($config.ContainsKey("RAG_OLLAMA_MODEL")) { $config["RAG_OLLAMA_MODEL"] } else { "qwen3-embedding:0.6b" }
$localLlmEnabled = if ($config.ContainsKey("ENABLED_PROVIDERS")) { $config["ENABLED_PROVIDERS"] -like "*local_llm*" } else { $false }
$localLlmBaseUrl = if ($config.ContainsKey("LOCAL_LLM_OLLAMA_BASE_URL")) { $config["LOCAL_LLM_OLLAMA_BASE_URL"] } else { "http://127.0.0.1:11434" }
$localLlmModel = if ($config.ContainsKey("LOCAL_LLM_OLLAMA_MODEL")) { $config["LOCAL_LLM_OLLAMA_MODEL"] } else { "qwen3.5:9b" }

if ($vectorStoreKind -eq "qdrant") {
  $status.qdrant = Ensure-Qdrant -RepoRoot $repoRoot -QdrantUrl $qdrantUrl
  Write-StatusFile -Path $statusPath -Status $status
} else {
  $status.qdrant = @{
    skipped = $true
    reason = "VECTOR_STORE_KIND is not qdrant."
  }
}

if ($ragBackend -eq "ollama") {
  $status.ragOllama = Ensure-OllamaEndpoint -BaseUrl $ragOllamaBaseUrl -Model $ragOllamaModel -Label "Local embedding Ollama" -LogDir $logDir
  Write-StatusFile -Path $statusPath -Status $status
}

if ($localLlmEnabled) {
  $status.localLlmOllama = Ensure-OllamaEndpoint -BaseUrl $localLlmBaseUrl -Model $localLlmModel -Label "Local LLM Ollama" -LogDir $logDir
  Write-StatusFile -Path $statusPath -Status $status
}

$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$nodeCommand = Get-Command node.exe -ErrorAction Stop

Write-Host "Building VoidBot..."
& $npmCommand.Source run build

if ($LASTEXITCODE -ne 0) {
  throw "npm run build failed."
}

Stop-StaleRuntimeProcesses -RepoRoot $repoRoot

$botOut = Join-Path $logDir "bot.log"
$botErr = Join-Path $logDir "bot.err.log"
$workerOut = Join-Path $logDir "worker.log"
$workerErr = Join-Path $logDir "worker.err.log"

$botProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList (Join-Path $repoRoot "apps\bot\dist\index.js") -WorkingDirectory $repoRoot -RedirectStandardOutput $botOut -RedirectStandardError $botErr -WindowStyle Hidden -PassThru
$workerProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList (Join-Path $repoRoot "apps\worker\dist\index.js") -WorkingDirectory $repoRoot -RedirectStandardOutput $workerOut -RedirectStandardError $workerErr -WindowStyle Hidden -PassThru

Wait-ForProcessReady -Process $botProcess -Name "VoidBot bot" -LogPath $botOut -ErrPath $botErr -ReadyText "VoidBot connected as"
Wait-ForProcessReady -Process $workerProcess -Name "VoidBot worker" -LogPath $workerOut -ErrPath $workerErr -ReadyText "VoidBot worker polling"

$status.bot = @{
  pid = $botProcess.Id
  log = $botOut
  errLog = $botErr
}

$status.worker = @{
  pid = $workerProcess.Id
  log = $workerOut
  errLog = $workerErr
}

$status.completedAt = (Get-Date).ToString("o")
$status.ready = $true
Write-StatusFile -Path $statusPath -Status $status

Write-Host "VoidBot stack is up."
Write-Host "Status: $statusPath"
Write-Host "Bot log: $botOut"
Write-Host "Worker log: $workerOut"
