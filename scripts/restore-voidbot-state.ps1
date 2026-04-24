param(
  [string] $BackupPath,
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
    [string[]] $Arguments
  )

  $response = & curl.exe --connect-timeout 5 --max-time 30 @Arguments

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

function Get-LatestBackupDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BackupRoot
  )

  if (-not (Test-Path $BackupRoot)) {
    throw "Backup root does not exist: $BackupRoot"
  }

  $latest = Get-ChildItem -Path $BackupRoot -Directory |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if (-not $latest) {
    throw "No backup directories exist under $BackupRoot"
  }

  return $latest.FullName
}

function Restore-PostgresBackup {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable] $Postgres,
    [Parameter(Mandatory = $true)]
    [string] $DumpFile
  )

  if (-not (Test-Path $DumpFile)) {
    throw "PostgreSQL dump file does not exist: $DumpFile"
  }

  $containerPath = "/tmp/voidbot-restore.dump"
  & docker cp $DumpFile "$($Postgres.containerName):$containerPath"

  if ($LASTEXITCODE -ne 0) {
    throw "docker cp failed while uploading the PostgreSQL dump."
  }

  try {
    & docker exec "-e" "PGPASSWORD=$($Postgres.password)" $Postgres.containerName `
      pg_restore `
      "--clean" `
      "--if-exists" `
      "--exit-on-error" `
      "--single-transaction" `
      "--no-owner" `
      "--no-privileges" `
      "--username=$($Postgres.username)" `
      "--dbname=$($Postgres.database)" `
      $containerPath

    if ($LASTEXITCODE -ne 0) {
      throw "pg_restore failed inside $($Postgres.containerName)."
    }
  } finally {
    & docker exec $Postgres.containerName rm -f $containerPath *> $null
  }
}

function Get-QdrantCollections {
  param(
    [Parameter(Mandatory = $true)]
    [string] $QdrantUrl
  )

  $response = Invoke-CurlJson -Arguments @("-fsS", "$($QdrantUrl.TrimEnd('/'))/collections")
  return @($response.result.collections | ForEach-Object { $_.name })
}

function Restore-QdrantSnapshots {
  param(
    [Parameter(Mandatory = $true)]
    [string] $QdrantUrl,
    [Parameter(Mandatory = $true)]
    [object[]] $Collections
  )

  $existingCollections = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)

  foreach ($name in Get-QdrantCollections -QdrantUrl $QdrantUrl) {
    [void]$existingCollections.Add($name)
  }

  foreach ($collection in $Collections) {
    $collectionName = [string]$collection.name
    $snapshotFile = [string]$collection.snapshotFile
    Write-Host "Restoring Qdrant collection $collectionName from $(Split-Path -Leaf $snapshotFile)..."

    if (-not (Test-Path $snapshotFile)) {
      throw "Qdrant snapshot file does not exist: $snapshotFile"
    }

    $escapedCollection = [Uri]::EscapeDataString($collectionName)

    if ($existingCollections.Contains($collectionName)) {
      [void](Invoke-CurlJson -Arguments @(
        "-fsS",
        "-X",
        "DELETE",
        "$($QdrantUrl.TrimEnd('/'))/collections/$escapedCollection"
      ))
    }

    & curl.exe -fsS -X POST "$($QdrantUrl.TrimEnd('/'))/collections/$escapedCollection/snapshots/upload?priority=snapshot" `
      -F "snapshot=@$snapshotFile" | Out-Null

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to upload Qdrant snapshot for collection $collectionName."
    }

    Wait-Until -Condition {
      try {
        $collectionsNow = Get-QdrantCollections -QdrantUrl $QdrantUrl
        return $collectionsNow -contains $collectionName
      } catch {
        return $false
      }
    } -FailureMessage "Collection $collectionName did not reappear after Qdrant snapshot restore."
  }
}

function Restore-RagArchives {
  param(
    [Parameter(Mandatory = $true)]
    [string] $SourceDir,
    [Parameter(Mandatory = $true)]
    [string] $StorageRoot
  )

  if (-not (Test-Path $SourceDir)) {
    return
  }

  $targetDir = Join-Path $StorageRoot "rag"
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item -Path (Join-Path $SourceDir "*") -Destination $targetDir -Recurse -Force
}

function Test-BackupSectionSkipped {
  param(
    [Parameter(Mandatory = $true)]
    [psobject] $Section
  )

  $property = $Section.PSObject.Properties["skipped"]

  if ($null -eq $property) {
    return $false
  }

  return [bool]$property.Value
}

$config = Read-DotEnv -Path $envFile
$storageRoot = Resolve-ConfigPath -RepoRoot $repoRoot -Value $config["STORAGE_ROOT"] -Fallback ".voidbot"
$backupRoot = Join-Path $storageRoot "backups"
$backupDirectory = if ([string]::IsNullOrWhiteSpace($BackupPath)) {
  Get-LatestBackupDirectory -BackupRoot $backupRoot
} else {
  [System.IO.Path]::GetFullPath($BackupPath)
}
$manifestPath = Join-Path $backupDirectory "manifest.json"

if (-not (Test-Path $manifestPath)) {
  throw "Backup manifest not found: $manifestPath"
}

$manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
$stateStorageBackend = if ($config.ContainsKey("STATE_STORAGE_BACKEND")) { $config["STATE_STORAGE_BACKEND"] } else { "postgres" }
$databaseDsn = if ($config.ContainsKey("DATABASE_DSN")) { $config["DATABASE_DSN"] } else { "postgres://voidbot:voidbot@localhost:5432/voidbot" }
$vectorStoreKind = if ($config.ContainsKey("VECTOR_STORE_KIND")) { $config["VECTOR_STORE_KIND"] } else { "local_json" }
$qdrantUrl = if ($config.ContainsKey("QDRANT_URL")) { $config["QDRANT_URL"] } else { "http://127.0.0.1:6333" }
$stoppedRuntime = @()
$shouldRestart = $false
$pendingError = $null

try {
  $stoppedRuntime = @(Stop-RuntimeProcesses -RepoRoot $repoRoot)
  $shouldRestart = $stoppedRuntime.Count -gt 0 -and -not $NoRestart
  $stoppedPids = @($stoppedRuntime | ForEach-Object { $_.ProcessId })
  $stoppedDisplay = if ($stoppedPids.Count -gt 0) { $stoppedPids -join ", " } else { "none" }
  Write-Host "Stopped runtime processes: $stoppedDisplay"

  if ($stateStorageBackend -eq "postgres" -and -not (Test-BackupSectionSkipped -Section $manifest.postgres)) {
    Write-Host "Restoring Postgres state..."
    Ensure-DockerOnPath
    $postgres = Ensure-Postgres -RepoRoot $repoRoot -DatabaseDsn $databaseDsn
    Restore-PostgresBackup -Postgres $postgres -DumpFile (Join-Path $backupDirectory ([string]$manifest.postgres.dumpFile))
  }

  if ($vectorStoreKind -eq "qdrant" -and -not (Test-BackupSectionSkipped -Section $manifest.qdrant)) {
    Write-Host "Restoring Qdrant collections..."
    Ensure-DockerOnPath
    [void](Ensure-Qdrant -RepoRoot $repoRoot -QdrantUrl $qdrantUrl)
    $resolvedCollections = @($manifest.qdrant.collections | ForEach-Object {
        @{
          name = [string]$_.name
          snapshotFile = Join-Path $backupDirectory ([string]$_.snapshotFile)
        }
      })
    Restore-QdrantSnapshots -QdrantUrl $qdrantUrl -Collections $resolvedCollections
  }

  Write-Host "Restoring RAG archives..."
  Restore-RagArchives -SourceDir (Join-Path $backupDirectory "archives") -StorageRoot $storageRoot

  Write-Host "VoidBot state restore complete."
  Write-Host "Restored from: $backupDirectory"
} catch {
  $pendingError = $_
} finally {
  if ($shouldRestart) {
    try {
      Write-Host "Restarting VoidBot stack..."
      & powershell -ExecutionPolicy Bypass -File $startScript

      if ($LASTEXITCODE -ne 0) {
        throw "Failed to restart the VoidBot stack after restore."
      }
    } catch {
      if ($null -eq $pendingError) {
        $pendingError = $_
      } else {
        Write-Warning "Restore hit an error, and the automatic stack restart also failed: $($_.Exception.Message)"
      }
    }
  }
}

if ($null -ne $pendingError) {
  if ($pendingError.Exception) {
    throw $pendingError.Exception
  }

  throw $pendingError
}
