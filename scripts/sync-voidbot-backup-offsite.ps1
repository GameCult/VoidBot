param(
  [string] $SshTarget,
  [string] $RemoteWindowsDir,
  [string] $RemoteSftpDir,
  [int] $LocalKeepLatest,
  [int] $RemoteKeepLatest,
  [string] $BackupLabel,
  [switch] $NoRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$backupScript = Join-Path $PSScriptRoot "backup-voidbot-state.ps1"
$verifyScript = Join-Path $PSScriptRoot "verify-voidbot-backup.ps1"

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

function Start-LogCapture {
  param(
    [Parameter(Mandatory = $true)]
    [string] $LogPath
  )

  $directory = Split-Path -Parent $LogPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null

  try {
    Start-Transcript -Path $LogPath -Append | Out-Null
    return $true
  } catch {
    Write-Warning "Failed to start transcript logging at ${LogPath}: $($_.Exception.Message)"
    return $false
  }
}

function Stop-LogCapture {
  param(
    [Parameter(Mandatory = $true)]
    [bool] $Started
  )

  if (-not $Started) {
    return
  }

  try {
    Stop-Transcript | Out-Null
  } catch {
  }
}

function Convert-WindowsPathToSftpPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $WindowsPath
  )

  if ($WindowsPath -notmatch "^[A-Za-z]:\\") {
    throw "Remote Windows path must start with a drive letter: $WindowsPath"
  }

  $drive = $WindowsPath.Substring(0, 1).ToUpperInvariant()
  $remainder = $WindowsPath.Substring(2).Replace("\", "/").TrimStart("/")
  return "/$($drive):/$remainder"
}

function Get-LatestBackupDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BackupRoot,
    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  $pattern = "*-$Label"
  $latest = Get-ChildItem -Path $BackupRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $pattern } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if (-not $latest) {
    throw "No backup directories matching $pattern were found under $BackupRoot."
  }

  return $latest
}

function Invoke-RemotePowerShell {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target,
    [Parameter(Mandatory = $true)]
    [string] $Script
  )

  $bytes = [System.Text.Encoding]::Unicode.GetBytes($Script)
  $encoded = [Convert]::ToBase64String($bytes)
  $output = & ssh $Target powershell -NoProfile -NonInteractive -EncodedCommand $encoded

  if ($LASTEXITCODE -ne 0) {
    throw "Remote PowerShell command failed on $Target."
  }

  return ($output -join "`n").Trim()
}

function Ensure-RemoteDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target,
    [Parameter(Mandatory = $true)]
    [string] $RemoteWindowsDir
  )

  $escapedDir = $RemoteWindowsDir.Replace("'", "''")
  $script = @'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path '__REMOTE_DIR__' | Out-Null
'@.Replace("__REMOTE_DIR__", $escapedDir)
  [void](Invoke-RemotePowerShell -Target $Target -Script $script)
}

function Get-RemoteFileInfo {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target,
    [Parameter(Mandatory = $true)]
    [string] $RemoteWindowsPath
  )

  $escapedPath = $RemoteWindowsPath.Replace("'", "''")
  $script = @'
$ProgressPreference = 'SilentlyContinue'
$item = Get-Item -LiteralPath '__REMOTE_PATH__'
[pscustomobject]@{
  name = $item.Name
  size = $item.Length
  lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
} | ConvertTo-Json -Compress
'@.Replace("__REMOTE_PATH__", $escapedPath)
  $output = Invoke-RemotePowerShell -Target $Target -Script $script
  return $output | ConvertFrom-Json
}

function Upload-WithSftp {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target,
    [Parameter(Mandatory = $true)]
    [string] $LocalFile,
    [Parameter(Mandatory = $true)]
    [string] $RemoteSftpPath,
    [Parameter(Mandatory = $true)]
    [string] $BatchFilePath
  )

  $localForSftp = $LocalFile.Replace("\", "/")
  $content = @(
    "put `"$localForSftp`" $RemoteSftpPath",
    "bye"
  )
  Set-Content -Path $BatchFilePath -Value $content -Encoding ascii

  try {
    & sftp -b $BatchFilePath $Target

    if ($LASTEXITCODE -ne 0) {
      throw "sftp upload failed for $LocalFile."
    }
  } finally {
    Remove-Item $BatchFilePath -Force -ErrorAction SilentlyContinue
  }
}

function Prune-RemoteBackups {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target,
    [Parameter(Mandatory = $true)]
    [string] $RemoteWindowsDir,
    [Parameter(Mandatory = $true)]
    [int] $KeepLatest
  )

  if ($KeepLatest -lt 0) {
    throw "Remote keep-latest count cannot be negative."
  }

  $escapedDir = $RemoteWindowsDir.Replace("'", "''")
  $script = @'
$ProgressPreference = 'SilentlyContinue'
$files = Get-ChildItem -Path '__REMOTE_DIR__' -File -Filter '*.zip' | Sort-Object LastWriteTimeUtc -Descending
$toDelete = @($files | Select-Object -Skip __KEEP_LATEST__)
foreach ($file in $toDelete) {
  Remove-Item -LiteralPath $file.FullName -Force
  Write-Output $file.Name
}
'@.Replace("__REMOTE_DIR__", $escapedDir).Replace("__KEEP_LATEST__", [string]$KeepLatest)
  $output = Invoke-RemotePowerShell -Target $Target -Script $script

  if ([string]::IsNullOrWhiteSpace($output)) {
    return @()
  }

  return @($output -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Prune-LocalBackupDirectories {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BackupRoot,
    [Parameter(Mandatory = $true)]
    [string] $BackupLabel,
    [Parameter(Mandatory = $true)]
    [int] $KeepLatest
  )

  if ($KeepLatest -lt 0) {
    throw "Local keep-latest count cannot be negative."
  }

  $pattern = "*-$BackupLabel"
  $toDelete = Get-ChildItem -Path $BackupRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $pattern } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -Skip $KeepLatest

  $deleted = @()

  foreach ($item in $toDelete) {
    Remove-Item -LiteralPath $item.FullName -Recurse -Force
    $deleted += $item.Name
  }

  return $deleted
}

function Prune-LocalBackupArchives {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BackupRoot,
    [Parameter(Mandatory = $true)]
    [string] $BackupLabel,
    [Parameter(Mandatory = $true)]
    [int] $KeepLatest
  )

  if ($KeepLatest -lt 0) {
    throw "Local keep-latest count cannot be negative."
  }

  $pattern = "*-$BackupLabel.zip"
  $toDelete = Get-ChildItem -Path $BackupRoot -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $pattern } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -Skip $KeepLatest

  $deleted = @()

  foreach ($item in $toDelete) {
    Remove-Item -LiteralPath $item.FullName -Force
    $deleted += $item.Name
  }

  return $deleted
}

$config = Read-DotEnv -Path $envFile
$storageRoot = Resolve-ConfigPath -RepoRoot $repoRoot -Value $config["STORAGE_ROOT"] -Fallback ".voidbot"
$backupRoot = Join-Path $storageRoot "backups"
$statusPath = Join-Path $storageRoot "status\offsite-backup.json"
$logPath = Join-Path $storageRoot "logs\offsite-backup.log"
$sshTargetValue = if (-not [string]::IsNullOrWhiteSpace($SshTarget)) {
  $SshTarget
} elseif ($config.ContainsKey("OFFSITE_BACKUP_SSH_TARGET")) {
  $config["OFFSITE_BACKUP_SSH_TARGET"]
} else {
  ""
}
$remoteWindowsDirValue = if (-not [string]::IsNullOrWhiteSpace($RemoteWindowsDir)) {
  $RemoteWindowsDir
} elseif ($config.ContainsKey("OFFSITE_BACKUP_REMOTE_WINDOWS_DIR")) {
  $config["OFFSITE_BACKUP_REMOTE_WINDOWS_DIR"]
} else {
  "C:\Meta\voidbot-backups"
}
$remoteSftpDirValue = if (-not [string]::IsNullOrWhiteSpace($RemoteSftpDir)) {
  $RemoteSftpDir
} elseif ($config.ContainsKey("OFFSITE_BACKUP_REMOTE_SFTP_DIR") -and -not [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_REMOTE_SFTP_DIR"])) {
  $config["OFFSITE_BACKUP_REMOTE_SFTP_DIR"]
} else {
  Convert-WindowsPathToSftpPath -WindowsPath $remoteWindowsDirValue
}
$localKeepLatestValue = if ($PSBoundParameters.ContainsKey("LocalKeepLatest")) {
  $LocalKeepLatest
} elseif ($config.ContainsKey("OFFSITE_BACKUP_LOCAL_KEEP_LATEST")) {
  [int]$config["OFFSITE_BACKUP_LOCAL_KEEP_LATEST"]
} else {
  7
}
$remoteKeepLatestValue = if ($PSBoundParameters.ContainsKey("RemoteKeepLatest")) {
  $RemoteKeepLatest
} elseif ($config.ContainsKey("OFFSITE_BACKUP_REMOTE_KEEP_LATEST")) {
  [int]$config["OFFSITE_BACKUP_REMOTE_KEEP_LATEST"]
} else {
  14
}
$backupLabelValue = if (-not [string]::IsNullOrWhiteSpace($BackupLabel)) {
  $BackupLabel
} elseif ($config.ContainsKey("OFFSITE_BACKUP_LABEL") -and -not [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_LABEL"])) {
  $config["OFFSITE_BACKUP_LABEL"]
} else {
  "offsite-auto"
}

if ([string]::IsNullOrWhiteSpace($sshTargetValue)) {
  throw "OFFSITE_BACKUP_SSH_TARGET is required for offsite backup sync."
}

$status = @{
  startedAt = (Get-Date).ToString("o")
  repoRoot = $repoRoot
  status = "starting"
  sshTarget = $sshTargetValue
  remoteWindowsDir = $remoteWindowsDirValue
  remoteSftpDir = $remoteSftpDirValue
  localKeepLatest = $localKeepLatestValue
  remoteKeepLatest = $remoteKeepLatestValue
  backupLabel = $backupLabelValue
}

$transcriptStarted = Start-LogCapture -LogPath $logPath
$archivePath = $null

try {
  Write-StatusFile -Path $statusPath -Status $status

  Write-Host "Running local backup first..."
  $backupArgs = @(
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $backupScript,
    "-Label",
    $backupLabelValue
  )

  if ($NoRestart) {
    $backupArgs += "-NoRestart"
  }

  & powershell @backupArgs

  if ($LASTEXITCODE -ne 0) {
    throw "Local backup script failed."
  }

  $backupDir = Get-LatestBackupDirectory -BackupRoot $backupRoot -Label $backupLabelValue
  $backupName = $backupDir.Name
  $archivePath = Join-Path $backupRoot "$backupName.zip"

  Write-Host "Verifying $backupName before offsite upload..."
  $verificationJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifyScript -BackupPath $backupDir.FullName -AsJson -Quiet

  if ($LASTEXITCODE -ne 0) {
    throw "Latest local backup failed verification and will not be uploaded."
  }

  $verificationReport = $verificationJson | ConvertFrom-Json

  $status.status = "compressing"
  $status.backupDirectory = $backupDir.FullName
  $status.archivePath = $archivePath
  $status.backupVerification = $verificationReport
  Write-StatusFile -Path $statusPath -Status $status

  Write-Host "Compressing $backupName for offsite transfer..."
  & tar.exe -a -cf $archivePath -C $backupRoot $backupName

  if ($LASTEXITCODE -ne 0) {
    throw "tar.exe failed while creating $archivePath."
  }

  $archiveItem = Get-Item -LiteralPath $archivePath
  $status.archiveSize = $archiveItem.Length
  $status.status = "uploading"
  Write-StatusFile -Path $statusPath -Status $status

  Write-Host "Ensuring remote directory exists..."
  Ensure-RemoteDirectory -Target $sshTargetValue -RemoteWindowsDir $remoteWindowsDirValue

  $remoteFileName = $archiveItem.Name
  $remoteWindowsPath = Join-Path $remoteWindowsDirValue $remoteFileName
  $remoteSftpPath = "$($remoteSftpDirValue.TrimEnd('/'))/$remoteFileName"
  $batchPath = Join-Path $storageRoot "status\offsite-upload.sftp"

  Write-Host "Uploading $remoteFileName to $sshTargetValue..."
  Upload-WithSftp -Target $sshTargetValue -LocalFile $archivePath -RemoteSftpPath $remoteSftpPath -BatchFilePath $batchPath

  $remoteInfo = Get-RemoteFileInfo -Target $sshTargetValue -RemoteWindowsPath $remoteWindowsPath
  $status.remoteFile = @{
    path = $remoteWindowsPath
    name = $remoteInfo.name
    size = $remoteInfo.size
    lastWriteTimeUtc = $remoteInfo.lastWriteTimeUtc
  }

  Remove-Item -LiteralPath $archivePath -Force
  $archivePath = $null
  $status.archivePath = $null

  $status.status = "pruning"
  Write-StatusFile -Path $statusPath -Status $status

  Write-Host "Pruning local scheduled backups..."
  $deletedLocalDirs = Prune-LocalBackupDirectories -BackupRoot $backupRoot -BackupLabel $backupLabelValue -KeepLatest $localKeepLatestValue
  $deletedLocalArchives = Prune-LocalBackupArchives -BackupRoot $backupRoot -BackupLabel $backupLabelValue -KeepLatest 0

  Write-Host "Pruning remote scheduled backups..."
  $deletedRemoteArchives = Prune-RemoteBackups -Target $sshTargetValue -RemoteWindowsDir $remoteWindowsDirValue -KeepLatest $remoteKeepLatestValue

  $status.deletedLocalBackupDirectories = $deletedLocalDirs
  $status.deletedLocalArchives = $deletedLocalArchives
  $status.deletedRemoteArchives = $deletedRemoteArchives
  $status.status = "completed"
  $status.completedAt = (Get-Date).ToString("o")
  Write-StatusFile -Path $statusPath -Status $status

  Write-Host "Offsite backup sync complete."
  Write-Host "Latest uploaded archive: $remoteWindowsPath"
} catch {
  $status.status = "failed"
  $status.completedAt = (Get-Date).ToString("o")
  $status.error = $_.Exception.Message
  Write-StatusFile -Path $statusPath -Status $status
  throw
} finally {
  if ($archivePath -and (Test-Path $archivePath)) {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
  }

  Stop-LogCapture -Started $transcriptStarted
}
