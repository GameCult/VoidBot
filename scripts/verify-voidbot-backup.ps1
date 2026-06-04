param(
  [string] $BackupPath,
  [switch] $AsJson,
  [switch] $Quiet
)

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

function Add-Check {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,
    [Parameter(Mandatory = $true)]
    [ValidateSet("passed", "warning", "failed")]
    [string] $Status,
    [Parameter(Mandatory = $true)]
    [string] $Detail,
    [hashtable] $Data = @{}
  )

  $script:checks += [ordered]@{
    name = $Name
    status = $Status
    detail = $Detail
    data = $Data
  }
}

function Get-LatestBackupDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BackupRoot
  )

  $latest = Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{8}-\d{6}(?:-.+)?$' } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if ($null -eq $latest) {
    return $null
  }

  return $latest
}

function Test-DockerAvailable {
  try {
    & docker version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Test-DockerContainerExists {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ContainerName
  )

  try {
    & docker inspect $ContainerName *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Test-PostgresDumpReadable {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ContainerName,
    [Parameter(Mandatory = $true)]
    [string] $DumpFile
  )

  $tempContainerPath = "/tmp/voidbot-verify-$([Guid]::NewGuid().ToString('N')).dump"

  try {
    & docker cp $DumpFile "${ContainerName}:$tempContainerPath" *> $null

    if ($LASTEXITCODE -ne 0) {
      throw "docker cp failed for $DumpFile."
    }

    & docker exec $ContainerName pg_restore --list $tempContainerPath *> $null

    if ($LASTEXITCODE -ne 0) {
      throw "pg_restore --list failed for the copied dump."
    }

    return @{
      status = "passed"
      detail = "Postgres dump passed pg_restore --list inside $ContainerName."
    }
  } catch {
    return @{
      status = "failed"
      detail = $_.Exception.Message
    }
  } finally {
    try {
      & docker exec $ContainerName rm -f $tempContainerPath *> $null
    } catch {
    }
  }
}

function Finalize-Report {
  $failedCount = @($script:checks | Where-Object { $_.status -eq "failed" }).Count
  $warningCount = @($script:checks | Where-Object { $_.status -eq "warning" }).Count
  $passedCount = @($script:checks | Where-Object { $_.status -eq "passed" }).Count

  $status = if ($failedCount -gt 0) {
    "failed"
  } elseif ($warningCount -gt 0) {
    "warning"
  } else {
    "passed"
  }

  return [ordered]@{
    checkedAt = (Get-Date).ToString("o")
    repoRoot = $repoRoot
    backupDirectory = if ($script:backupDirectory) { $script:backupDirectory.FullName } else { $null }
    status = $status
    summary = @{
      passed = $passedCount
      warning = $warningCount
      failed = $failedCount
    }
    checks = $script:checks
  }
}

$checks = @()
$backupDirectory = $null
$config = Read-DotEnv -Path $envFile
$storageRoot = Resolve-ConfigPath -RepoRoot $repoRoot -Value $config["STORAGE_ROOT"] -Fallback ".voidbot"
$backupRoot = Join-Path $storageRoot "backups"

if ([string]::IsNullOrWhiteSpace($BackupPath)) {
  $backupDirectory = Get-LatestBackupDirectory -BackupRoot $backupRoot
} elseif (Test-Path -LiteralPath $BackupPath) {
  $backupDirectory = Get-Item -LiteralPath $BackupPath
}

if ($null -eq $backupDirectory) {
  Add-Check -Name "backup.directory" -Status "failed" -Detail "No backup directory was found to verify." -Data @{
    backupRoot = $backupRoot
    requestedPath = $BackupPath
  }
  $report = Finalize-Report
  $json = $report | ConvertTo-Json -Depth 8

  if ($AsJson) {
    Write-Output $json
  } elseif (-not $Quiet) {
    Write-Host "Backup verification failed."
    Write-Host $json
  }

  exit 1
}

Add-Check -Name "backup.directory" -Status "passed" -Detail "Found backup directory $($backupDirectory.FullName)." -Data @{
  path = $backupDirectory.FullName
}

$manifestPath = Join-Path $backupDirectory.FullName "manifest.json"
$manifest = $null

if (-not (Test-Path -LiteralPath $manifestPath)) {
  Add-Check -Name "backup.manifest" -Status "failed" -Detail "Backup manifest is missing at $manifestPath." -Data @{
    manifestPath = $manifestPath
  }
  $report = Finalize-Report
  $json = $report | ConvertTo-Json -Depth 8

  if ($AsJson) {
    Write-Output $json
  } elseif (-not $Quiet) {
    Write-Host "Backup verification failed."
    Write-Host $json
  }

  exit 1
}

try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Add-Check -Name "backup.manifest" -Status "passed" -Detail "Parsed manifest.json successfully." -Data @{
    manifestPath = $manifestPath
  }
} catch {
  Add-Check -Name "backup.manifest" -Status "failed" -Detail "Failed to parse manifest.json: $($_.Exception.Message)" -Data @{
    manifestPath = $manifestPath
  }
  $report = Finalize-Report
  $json = $report | ConvertTo-Json -Depth 8

  if ($AsJson) {
    Write-Output $json
  } elseif (-not $Quiet) {
    Write-Host "Backup verification failed."
    Write-Host $json
  }

  exit 1
}

if ([string]$manifest.backupFormat -eq "voidbot_state_backup_v1") {
  Add-Check -Name "backup.format" -Status "passed" -Detail "Manifest format matches voidbot_state_backup_v1."
} else {
  Add-Check -Name "backup.format" -Status "failed" -Detail "Unexpected backupFormat '$([string]$manifest.backupFormat)'." -Data @{
    expected = "voidbot_state_backup_v1"
    actual = [string]$manifest.backupFormat
  }
}

try {
  $createdAt = [DateTimeOffset]::Parse([string]$manifest.createdAt)
  Add-Check -Name "backup.created_at" -Status "passed" -Detail "Backup timestamp parsed successfully." -Data @{
      createdAt = $createdAt.ToString("o")
      ageHours = [Math]::Round(([DateTimeOffset]::Now - $createdAt).TotalHours, 2)
  }
} catch {
  Add-Check -Name "backup.created_at" -Status "failed" -Detail "Manifest createdAt could not be parsed." -Data @{
    value = [string]$manifest.createdAt
  }
}

$postgresSection = $manifest.postgres

if ($null -eq $postgresSection) {
  Add-Check -Name "postgres.section" -Status "warning" -Detail "Manifest has no postgres section."
} elseif ($postgresSection.skipped) {
  Add-Check -Name "postgres.section" -Status "passed" -Detail "Postgres backup was intentionally skipped." -Data @{
    reason = [string]$postgresSection.reason
  }
} else {
  $dumpRelativePath = [string]$postgresSection.dumpFile
  $dumpPath = Join-Path $backupDirectory.FullName $dumpRelativePath

  if (-not (Test-Path -LiteralPath $dumpPath)) {
    Add-Check -Name "postgres.dump" -Status "failed" -Detail "Postgres dump file is missing at $dumpPath." -Data @{
      dumpFile = $dumpRelativePath
    }
  } else {
    $dumpItem = Get-Item -LiteralPath $dumpPath
    Add-Check -Name "postgres.dump" -Status "passed" -Detail "Found Postgres dump file." -Data @{
      path = $dumpPath
      size = $dumpItem.Length
      containerName = [string]$postgresSection.containerName
    }

    $containerName = [string]$postgresSection.containerName

    if ([string]::IsNullOrWhiteSpace($containerName)) {
      Add-Check -Name "postgres.dump_readable" -Status "warning" -Detail "Skipped pg_restore validation because the manifest has no containerName."
    } elseif (-not (Test-DockerAvailable)) {
      Add-Check -Name "postgres.dump_readable" -Status "warning" -Detail "Skipped pg_restore validation because Docker is unavailable."
    } elseif (-not (Test-DockerContainerExists -ContainerName $containerName)) {
      Add-Check -Name "postgres.dump_readable" -Status "warning" -Detail "Skipped pg_restore validation because container $containerName is not available."
    } else {
      $pgRestoreCheck = Test-PostgresDumpReadable -ContainerName $containerName -DumpFile $dumpPath
      Add-Check -Name "postgres.dump_readable" -Status $pgRestoreCheck.status -Detail $pgRestoreCheck.detail -Data @{
        containerName = $containerName
      }
    }
  }
}

$qdrantSection = $manifest.qdrant

if ($null -eq $qdrantSection) {
  Add-Check -Name "qdrant.section" -Status "warning" -Detail "Manifest has no qdrant section."
} elseif ($qdrantSection.skipped) {
  Add-Check -Name "qdrant.section" -Status "passed" -Detail "Qdrant snapshot backup was intentionally skipped." -Data @{
    reason = [string]$qdrantSection.reason
  }
} else {
  $collectionCount = @($qdrantSection.collections).Count

  if ($collectionCount -eq 0) {
    Add-Check -Name "qdrant.snapshots" -Status "failed" -Detail "Manifest lists zero Qdrant collection snapshots."
  } else {
    Add-Check -Name "qdrant.snapshots" -Status "passed" -Detail "Manifest lists $collectionCount Qdrant collection snapshots." -Data @{
      collectionCount = $collectionCount
      version = [string]$qdrantSection.version
    }
  }

  foreach ($collection in @($qdrantSection.collections)) {
    $snapshotRelativePath = [string]$collection.snapshotFile
    $snapshotPath = Join-Path $backupDirectory.FullName $snapshotRelativePath
    $checkName = "qdrant.snapshot.$([string]$collection.name)"

    if (-not (Test-Path -LiteralPath $snapshotPath)) {
      Add-Check -Name $checkName -Status "failed" -Detail "Snapshot file is missing at $snapshotPath." -Data @{
        collection = [string]$collection.name
        snapshotFile = $snapshotRelativePath
      }
      continue
    }

    $snapshotItem = Get-Item -LiteralPath $snapshotPath

    if ($snapshotItem.Length -le 0) {
      Add-Check -Name $checkName -Status "failed" -Detail "Snapshot file exists but is empty." -Data @{
        collection = [string]$collection.name
        snapshotFile = $snapshotRelativePath
      }
      continue
    }

    Add-Check -Name $checkName -Status "passed" -Detail "Snapshot file exists for $([string]$collection.name)." -Data @{
      collection = [string]$collection.name
      path = $snapshotPath
      size = $snapshotItem.Length
    }
  }
}

$archivesSection = $manifest.archives

if ($null -eq $archivesSection) {
  Add-Check -Name "archives.section" -Status "failed" -Detail "Manifest has no archives section."
} elseif ($archivesSection.skipped) {
  Add-Check -Name "archives.section" -Status "warning" -Detail "Archive copy was skipped." -Data @{
    reason = [string]$archivesSection.reason
  }
} else {
  $archiveFiles = @($archivesSection.files)

  if ($archiveFiles.Count -eq 0) {
    Add-Check -Name "archives.files" -Status "failed" -Detail "Manifest lists zero archive files."
  } else {
    Add-Check -Name "archives.files" -Status "passed" -Detail "Manifest lists $($archiveFiles.Count) archive files." -Data @{
      sourceRoot = [string]$archivesSection.sourceRoot
    }
  }

  foreach ($archive in $archiveFiles) {
    $relativePath = [string]$archive.relativePath
    $filePath = Join-Path (Join-Path $backupDirectory.FullName "archives") $relativePath
    $checkName = "archives.file.$relativePath"

    if (-not (Test-Path -LiteralPath $filePath)) {
      Add-Check -Name $checkName -Status "failed" -Detail "Archive file is missing at $filePath." -Data @{
        relativePath = $relativePath
      }
      continue
    }

    $fileItem = Get-Item -LiteralPath $filePath

    if ($fileItem.Length -le 0) {
      Add-Check -Name $checkName -Status "failed" -Detail "Archive file exists but is empty." -Data @{
        relativePath = $relativePath
        path = $filePath
      }
      continue
    }

    Add-Check -Name $checkName -Status "passed" -Detail "Archive file exists for $relativePath." -Data @{
      relativePath = $relativePath
      path = $filePath
      size = $fileItem.Length
    }
  }
}

$report = Finalize-Report
$json = $report | ConvertTo-Json -Depth 8

if ($AsJson) {
  Write-Output $json
} elseif (-not $Quiet) {
  Write-Host "Backup verification status: $($report.status)"
  foreach ($check in $report.checks) {
    Write-Host ("[{0}] {1}: {2}" -f $check.status.ToUpperInvariant(), $check.name, $check.detail)
  }
}

if ($report.status -eq "failed") {
  exit 1
}

exit 0
