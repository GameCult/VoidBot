param(
  [string] $OutputRoot,
  [string] $Label,
  [switch] $NoRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$startScript = Join-Path $PSScriptRoot "start-voidbot-stack.ps1"

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

function Parse-DatabaseDsn {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Dsn
  )

  $uri = [Uri]$Dsn
  $userInfo = if ([string]::IsNullOrWhiteSpace($uri.UserInfo)) { @() } else { $uri.UserInfo.Split(":", 2) }

  return @{
    host = $uri.Host
    port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    database = $uri.AbsolutePath.TrimStart("/")
    username = if ($userInfo.Length -ge 1) { [Uri]::UnescapeDataString($userInfo[0]) } else { "voidbot" }
    password = if ($userInfo.Length -ge 2) { [Uri]::UnescapeDataString($userInfo[1]) } else { "voidbot" }
  }
}

function Invoke-CurlJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments,
    [int] $ConnectTimeoutSeconds = 5,
    [int] $MaxTimeSeconds = 30
  )

  $response = & curl.exe --connect-timeout $ConnectTimeoutSeconds --max-time $MaxTimeSeconds @Arguments

  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe failed: $($Arguments -join ' ')"
  }

  if ([string]::IsNullOrWhiteSpace($response)) {
    return $null
  }

  return $response | ConvertFrom-Json
}

function Test-TcpEndpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string] $HostName,
    [Parameter(Mandatory = $true)]
    [int] $Port
  )

  $client = [System.Net.Sockets.TcpClient]::new()

  try {
    $connectTask = $client.ConnectAsync($HostName, $Port)

    if (-not $connectTask.Wait(1500)) {
      return $false
    }

    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-IsLocalHostName {
  param(
    [Parameter(Mandatory = $true)]
    [string] $HostName
  )

  return $HostName -in @("127.0.0.1", "localhost", "::1")
}

function Test-IsLocalUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url
  )

  $uri = [Uri]$Url
  return $uri.Host -in @("127.0.0.1", "localhost", "::1")
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

function Get-DockerContainerHealth {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ContainerName
  )

  try {
    $status = & docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $ContainerName 2>$null

    if ($LASTEXITCODE -ne 0) {
      return $null
    }

    return $status.Trim()
  } catch {
    return $null
  }
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

function Ensure-Postgres {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,
    [Parameter(Mandatory = $true)]
    [string] $DatabaseDsn
  )

  $database = Parse-DatabaseDsn -Dsn $DatabaseDsn

  if (Test-TcpEndpoint -HostName $database.host -Port $database.port) {
    return @{
      dsn = $DatabaseDsn
      host = $database.host
      port = $database.port
      database = $database.database
      username = $database.username
      password = $database.password
      containerName = "voidbot-postgres"
      startedByScript = $false
      healthy = $true
    }
  }

  if (-not (Test-IsLocalHostName -HostName $database.host)) {
    throw "Postgres is not reachable at $($database.host):$($database.port), and the host is not local enough for Docker auto-start."
  }

  Ensure-DockerOnPath

  $composeFile = Join-Path $RepoRoot "infra\postgres\docker-compose.yml"
  $env:VOIDBOT_POSTGRES_PORT = [string]$database.port
  $env:VOIDBOT_POSTGRES_DB = $database.database
  $env:VOIDBOT_POSTGRES_USER = $database.username
  $env:VOIDBOT_POSTGRES_PASSWORD = $database.password

  & docker compose -f $composeFile up -d

  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed to start Postgres."
  }

  Wait-Until -Condition {
    $health = Get-DockerContainerHealth -ContainerName "voidbot-postgres"

    if ([string]::IsNullOrWhiteSpace($health) -or $health -eq "none") {
      return Test-TcpEndpoint -HostName $database.host -Port $database.port
    }

    return $health -eq "healthy"
  } -FailureMessage "Postgres did not become reachable at $($database.host):$($database.port) in time."

  return @{
    dsn = $DatabaseDsn
    host = $database.host
    port = $database.port
    database = $database.database
    username = $database.username
    password = $database.password
    containerName = "voidbot-postgres"
    startedByScript = $true
    healthy = $true
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

  try {
    [void](Invoke-CurlJson -Arguments @("-fsS", $healthUrl))
    return @{
      url = $QdrantUrl
      startedByScript = $false
      healthy = $true
    }
  } catch {
  }

  if (-not (Test-IsLocalUrl -Url $QdrantUrl)) {
    throw "Qdrant is not reachable at $QdrantUrl, and the URL is not local enough for Docker auto-start."
  }

  Ensure-DockerOnPath

  $composeFile = Join-Path $RepoRoot "infra\qdrant\docker-compose.yml"
  & docker compose -f $composeFile up -d

  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose failed to start Qdrant."
  }

  Wait-Until -Condition {
    try {
      [void](Invoke-CurlJson -Arguments @("-fsS", $healthUrl))
      return $true
    } catch {
      return $false
    }
  } -FailureMessage "Qdrant did not become reachable at $QdrantUrl in time."

  return @{
    url = $QdrantUrl
    startedByScript = $true
    healthy = $true
  }
}

function Get-RuntimeProcesses {
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

  return Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -and
      $_.CommandLine -like "*$RepoRoot*"
    } |
    Where-Object {
      $commandLine = $_.CommandLine
      $matchesRuntime = $false

      foreach ($pattern in $patterns) {
        if ($commandLine -like "*$pattern*") {
          $matchesRuntime = $true
          break
        }
      }

      return $matchesRuntime
    }
}

function Stop-RuntimeProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot
  )

  $processes = @(Get-RuntimeProcesses -RepoRoot $RepoRoot)

  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
    }
  }

  return $processes
}

function Get-PostgresVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ContainerName
  )

  $version = & docker exec $ContainerName postgres --version

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to determine PostgreSQL version from $ContainerName."
  }

  return $version.Trim()
}

function Get-QdrantInfo {
  param(
    [Parameter(Mandatory = $true)]
    [string] $QdrantUrl
  )

  return Invoke-CurlJson -Arguments @("-fsS", "$($QdrantUrl.TrimEnd('/'))/")
}

function Get-QdrantCollections {
  param(
    [Parameter(Mandatory = $true)]
    [string] $QdrantUrl
  )

  $response = Invoke-CurlJson -Arguments @("-fsS", "$($QdrantUrl.TrimEnd('/'))/collections")
  return @($response.result.collections | ForEach-Object { $_.name })
}

function Backup-Postgres {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable] $Postgres,
    [Parameter(Mandatory = $true)]
    [string] $OutputDir
  )

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  $containerPath = "/tmp/voidbot-backup.dump"
  $outputPath = Join-Path $OutputDir "voidbot.dump"

  & docker exec "-e" "PGPASSWORD=$($Postgres.password)" $Postgres.containerName `
    pg_dump `
    "--username=$($Postgres.username)" `
    "--dbname=$($Postgres.database)" `
    "--format=custom" `
    "--no-owner" `
    "--no-privileges" `
    "--file=$containerPath"

  if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed inside $($Postgres.containerName)."
  }

  try {
    & docker cp "$($Postgres.containerName):$containerPath" $outputPath

    if ($LASTEXITCODE -ne 0) {
      throw "docker cp failed while exporting the PostgreSQL dump."
    }
  } finally {
    & docker exec $Postgres.containerName rm -f $containerPath *> $null
  }

  return @{
    skipped = $false
    containerName = $Postgres.containerName
    version = Get-PostgresVersion -ContainerName $Postgres.containerName
    dumpFile = "postgres/voidbot.dump"
    database = $Postgres.database
    host = $Postgres.host
    port = $Postgres.port
  }
}

function Backup-QdrantCollections {
  param(
    [Parameter(Mandatory = $true)]
    [string] $QdrantUrl,
    [Parameter(Mandatory = $true)]
    [string] $OutputDir
  )

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  $rootInfo = Get-QdrantInfo -QdrantUrl $QdrantUrl
  $collections = Get-QdrantCollections -QdrantUrl $QdrantUrl
  $backedUpCollections = @()

  foreach ($collectionName in $collections) {
    Write-Host "Creating Qdrant snapshot for $collectionName..."
    $escapedCollection = [Uri]::EscapeDataString($collectionName)
    $createResponse = Invoke-CurlJson -Arguments @(
      "-fsS",
      "-X",
      "POST",
      "$($QdrantUrl.TrimEnd('/'))/collections/$escapedCollection/snapshots"
    ) -MaxTimeSeconds 180
    $snapshotName = [string]$createResponse.result.name

    Wait-Until -Condition {
      try {
        $listResponse = Invoke-CurlJson -Arguments @(
          "-fsS",
          "$($QdrantUrl.TrimEnd('/'))/collections/$escapedCollection/snapshots"
        )
        $names = @($listResponse.result | ForEach-Object { $_.name })
        return $names -contains $snapshotName
      } catch {
        return $false
      }
    } -FailureMessage "Qdrant snapshot $snapshotName for collection $collectionName did not become downloadable in time."

    $downloadPath = Join-Path $OutputDir $snapshotName

    try {
      Write-Host "Downloading Qdrant snapshot $snapshotName..."
      & curl.exe -fsS "$($QdrantUrl.TrimEnd('/'))/collections/$escapedCollection/snapshots/$snapshotName" --output $downloadPath

      if ($LASTEXITCODE -ne 0) {
        throw "Failed to download Qdrant snapshot $snapshotName for collection $collectionName."
      }
    } finally {
      & curl.exe -fsS -X DELETE "$($QdrantUrl.TrimEnd('/'))/collections/$escapedCollection/snapshots/$snapshotName" *> $null
    }

    $backedUpCollections += @{
      name = $collectionName
      snapshotFile = "qdrant/$snapshotName"
    }
  }

  return @{
    skipped = $false
    url = $QdrantUrl
    version = [string]$rootInfo.version
    title = [string]$rootInfo.title
    collections = $backedUpCollections
  }
}

function Backup-RagArchives {
  param(
    [Parameter(Mandatory = $true)]
    [string] $StorageRoot,
    [Parameter(Mandatory = $true)]
    [string] $OutputDir
  )

  $ragRoot = Join-Path $StorageRoot "rag"

  if (-not (Test-Path $ragRoot)) {
    return @{
      skipped = $true
      reason = "RAG archive directory does not exist."
      files = @()
    }
  }

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  $items = @(Get-ChildItem -Path $ragRoot -Force)

  if ($items.Count -gt 0) {
    Copy-Item -Path (Join-Path $ragRoot "*") -Destination $OutputDir -Recurse -Force
  }

  $files = Get-ChildItem -Path $OutputDir -File -Recurse |
    ForEach-Object {
      @{
        relativePath = $_.FullName.Substring($OutputDir.Length + 1)
        size = $_.Length
      }
    }

  return @{
    skipped = $false
    sourceRoot = $ragRoot
    files = $files
  }
}

function Sanitize-Label {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Value
  )

  $sanitized = ($Value -replace "[^A-Za-z0-9._-]", "-").Trim("-")

  if ([string]::IsNullOrWhiteSpace($sanitized)) {
    return $null
  }

  return $sanitized
}

$config = Read-DotEnv -Path $envFile
$storageRoot = Resolve-ConfigPath -RepoRoot $repoRoot -Value $config["STORAGE_ROOT"] -Fallback ".voidbot"
$backupRoot = if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  Join-Path $storageRoot "backups"
} else {
  [System.IO.Path]::GetFullPath($OutputRoot)
}
$stateStorageBackend = if ($config.ContainsKey("STATE_STORAGE_BACKEND")) { $config["STATE_STORAGE_BACKEND"] } else { "postgres" }
$databaseDsn = if ($config.ContainsKey("DATABASE_DSN")) { $config["DATABASE_DSN"] } else { "postgres://voidbot:voidbot@localhost:5432/voidbot" }
$vectorStoreKind = if ($config.ContainsKey("VECTOR_STORE_KIND")) { $config["VECTOR_STORE_KIND"] } else { "local_json" }
$qdrantUrl = if ($config.ContainsKey("QDRANT_URL")) { $config["QDRANT_URL"] } else { "http://127.0.0.1:6333" }
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$labelSuffix = $null

if (-not [string]::IsNullOrWhiteSpace($Label)) {
  $sanitizedLabel = Sanitize-Label -Value $Label

  if ($sanitizedLabel) {
    $labelSuffix = "-$sanitizedLabel"
  }
}

$backupDir = Join-Path $backupRoot "$timestamp$labelSuffix"
$postgresDir = Join-Path $backupDir "postgres"
$qdrantDir = Join-Path $backupDir "qdrant"
$archiveDir = Join-Path $backupDir "archives"
$manifestPath = Join-Path $backupDir "manifest.json"
$stoppedRuntime = @()
$shouldRestart = $false
$pendingError = $null
$backupCompleted = $false

try {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

  $stoppedRuntime = @(Stop-RuntimeProcesses -RepoRoot $repoRoot)
  $shouldRestart = $stoppedRuntime.Count -gt 0 -and -not $NoRestart
  $stoppedPids = @($stoppedRuntime | ForEach-Object { $_.ProcessId })
  $stoppedDisplay = if ($stoppedPids.Count -gt 0) { $stoppedPids -join ", " } else { "none" }
  Write-Host "Stopped runtime processes: $stoppedDisplay"

  $manifest = @{
    backupFormat = "voidbot_state_backup_v1"
    createdAt = (Get-Date).ToString("o")
    repoRoot = $repoRoot
    storageRoot = $storageRoot
    runtimeStopped = @($stoppedRuntime | ForEach-Object { $_.ProcessId })
    postgres = @{
      skipped = $true
      reason = "STATE_STORAGE_BACKEND is not postgres."
    }
    qdrant = @{
      skipped = $true
      reason = "VECTOR_STORE_KIND is not qdrant."
    }
    archives = $null
  }

  if ($stateStorageBackend -eq "postgres") {
    Write-Host "Backing up Postgres state..."
    Ensure-DockerOnPath
    $postgres = Ensure-Postgres -RepoRoot $repoRoot -DatabaseDsn $databaseDsn
    $manifest.postgres = Backup-Postgres -Postgres $postgres -OutputDir $postgresDir
  }

  if ($vectorStoreKind -eq "qdrant") {
    Write-Host "Backing up Qdrant collections..."
    Ensure-DockerOnPath
    [void](Ensure-Qdrant -RepoRoot $repoRoot -QdrantUrl $qdrantUrl)
    $manifest.qdrant = Backup-QdrantCollections -QdrantUrl $qdrantUrl -OutputDir $qdrantDir
  }

  Write-Host "Copying RAG archives..."
  $manifest.archives = Backup-RagArchives -StorageRoot $storageRoot -OutputDir $archiveDir
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding utf8
  $backupCompleted = $true

  Write-Host "VoidBot state backup complete."
  Write-Host "Backup: $backupDir"
} catch {
  $pendingError = $_
} finally {
  if ($shouldRestart) {
    try {
      Write-Host "Restarting VoidBot stack..."
      & powershell -ExecutionPolicy Bypass -File $startScript

      if ($LASTEXITCODE -ne 0) {
        throw "Failed to restart the VoidBot stack after backup."
      }
    } catch {
      if ($null -eq $pendingError) {
        $pendingError = $_
      } else {
        Write-Warning "Backup hit an error, and the automatic stack restart also failed: $($_.Exception.Message)"
      }
    }
  }
}

if ($null -ne $pendingError) {
  if (-not $backupCompleted -and (Test-Path -LiteralPath $backupDir)) {
    try {
      Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction Stop
      Write-Warning "Removed incomplete backup directory $backupDir after failure."
    } catch {
      Write-Warning ("Failed to remove incomplete backup directory {0}: {1}" -f $backupDir, $_.Exception.Message)
    }
  }

  if ($pendingError.Exception) {
    throw $pendingError.Exception
  }

  throw $pendingError
}
