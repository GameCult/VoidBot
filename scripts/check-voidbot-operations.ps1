param(
  [switch] $NotifyOwner,
  [switch] $FailOnIssues
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$verifyScript = Join-Path $PSScriptRoot "verify-voidbot-backup.ps1"
. (Join-Path $PSScriptRoot "voidbot-operations-dashboard-lib.ps1")

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
    [object] $Status
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $Status | ConvertTo-Json -Depth 10 | Set-Content -Path $Path -Encoding utf8

  if ($script:storageRoot) {
    [void](Update-VoidBotOperationsDashboard -RepoRoot $repoRoot -StorageRoot $script:storageRoot)
  }
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

function Finalize-Report {
  $failedCount = @($script:checks | Where-Object { $_.status -eq "failed" }).Count
  $warningCount = @($script:checks | Where-Object { $_.status -eq "warning" }).Count
  $passedCount = @($script:checks | Where-Object { $_.status -eq "passed" }).Count

  $status = if ($failedCount -gt 0) {
    "failed"
  } elseif ($warningCount -gt 0) {
    "warning"
  } else {
    "healthy"
  }

  return [ordered]@{
    checkedAt = (Get-Date).ToString("o")
    repoRoot = $repoRoot
    status = $status
    summary = @{
      passed = $passedCount
      warning = $warningCount
      failed = $failedCount
    }
    checks = $script:checks
  }
}

function Get-Json {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url,
    [string[]] $Headers = @()
  )

  $args = @(
    "-fsS",
    "--connect-timeout", "5",
    "--max-time", "20",
    $Url
  )

  foreach ($header in $Headers) {
    $args = @("-H", $header) + $args
  }

  $response = & curl.exe @args

  if ($LASTEXITCODE -ne 0) {
    throw "Request failed for $Url"
  }

  return $response | ConvertFrom-Json
}

function Invoke-CommandWithTimeout {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,
    [Parameter(Mandatory = $false)]
    [string[]] $ArgumentList = @(),
    [Parameter(Mandatory = $false)]
    [int] $TimeoutSeconds = 15
  )

  $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())

  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        $process.Kill()
      } catch {
      }

      throw "Command timed out after $TimeoutSeconds second(s): $FilePath $($ArgumentList -join ' ')"
    }

    $process.Refresh()
    $exitCode = $process.ExitCode

    $stdout = if (Test-Path -LiteralPath $stdoutPath) {
      Get-Content -LiteralPath $stdoutPath -Raw
    } else {
      ""
    }

    $stderr = if (Test-Path -LiteralPath $stderrPath) {
      Get-Content -LiteralPath $stderrPath -Raw
    } else {
      ""
    }

    return [PSCustomObject]@{
      ExitCode = $exitCode
      StdOut = $stdout
      StdErr = $stderr
    }
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-SourceRepoReconcile {
  param(
    [switch] $CheckOnly,
    [switch] $Detached
  )

  $tsxCommand = Join-Path $repoRoot "node_modules\.bin\tsx.cmd"
  $reconcileScript = Join-Path $repoRoot "scripts\reconcile-source-repos.ts"

  if (-not (Test-Path -LiteralPath $tsxCommand)) {
    throw "Local tsx launcher is missing at $tsxCommand."
  }

  if (-not (Test-Path -LiteralPath $reconcileScript)) {
    throw "Source repo reconcile script is missing at $reconcileScript."
  }

  $arguments = @($reconcileScript, "--json")

  if ($CheckOnly) {
    $arguments += "--check"
  }

  if ($Detached) {
    $arguments += "--detached"
  }

  $stdout = (& $tsxCommand @arguments 2>&1 | Out-String).Trim()
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0) {
    if ([string]::IsNullOrWhiteSpace($stdout)) {
      $stdout = "Source repo reconcile exited with code $exitCode."
    }

    throw $stdout
  }

  if ([string]::IsNullOrWhiteSpace($stdout)) {
    throw "Source repo reconcile returned no JSON output."
  }

  return $stdout | ConvertFrom-Json
}

function Ensure-DockerCliOnPath {
  $dockerCliDir = "C:\Program Files\Docker\Docker\resources\bin"

  if (Test-Path -LiteralPath $dockerCliDir) {
    $pathEntries = @($env:Path -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    if ($pathEntries -notcontains $dockerCliDir) {
      $env:Path = "$dockerCliDir;$env:Path"
    }
  }
}

function Get-DockerExecutable {
  Ensure-DockerCliOnPath

  $command = Get-Command docker.exe -ErrorAction SilentlyContinue

  if ($null -eq $command) {
    $command = Get-Command docker -ErrorAction SilentlyContinue
  }

  if ($null -eq $command) {
    throw "Docker CLI is not available on PATH."
  }

  return $command.Source
}

function Test-DockerAvailable {
  try {
    $dockerExe = Get-DockerExecutable
    & $dockerExe version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Get-DockerContainerHealth {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ContainerName
  )

  try {
    $dockerExe = Get-DockerExecutable
    $result = & $dockerExe inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $ContainerName 2>$null

    if ($LASTEXITCODE -ne 0) {
      return $null
    }

    return $result.Trim()
  } catch {
    return $null
  }
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
  }
}

function Test-ProcessAlive {
  param(
    [Parameter(Mandatory = $true)]
    [int] $ProcessId
  )

  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return $null -ne $process
  } catch {
    return $false
  }
}

function Escape-SingleQuotedPowerShell {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Value
  )

  return $Value.Replace("'", "''")
}

function Get-OptionalPropertyValue {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [object] $InputObject,
    [Parameter(Mandatory = $true)]
    [string] $PropertyName
  )

  if ($null -eq $InputObject) {
    return $null
  }

  $property = $InputObject.PSObject.Properties[$PropertyName]

  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Invoke-RemotePowerShellJson {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target,
    [Parameter(Mandatory = $true)]
    [string] $ScriptText
  )

  $bytes = [System.Text.Encoding]::Unicode.GetBytes($ScriptText)
  $encoded = [Convert]::ToBase64String($bytes)
  $response = & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 $Target powershell -NoProfile -EncodedCommand $encoded

  if ($LASTEXITCODE -ne 0) {
    throw "SSH command failed for $Target."
  }

  if ([string]::IsNullOrWhiteSpace($response)) {
    return $null
  }

  return $response | ConvertFrom-Json
}

function Invoke-RemoteLinuxCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target,
    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $IdentityFile = "",
    [Parameter(Mandatory = $true)]
    [string] $Command
  )

  $args = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=10")

  if (-not [string]::IsNullOrWhiteSpace($IdentityFile)) {
    $args += @("-i", $IdentityFile)
  }

  $args += @($Target, $Command)
  $response = & ssh.exe @args

  if ($LASTEXITCODE -ne 0) {
    throw "SSH command failed for $Target."
  }

  return [string]($response -join "`n")
}

function Invoke-WatchdogExtension {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    [hashtable] $Context
  )

  . $Path

  $extensionCommand = Get-Command -Name "Invoke-VoidBotWatchdogExtension" -ErrorAction SilentlyContinue

  if ($null -eq $extensionCommand) {
    throw "Watchdog extension at $Path did not define Invoke-VoidBotWatchdogExtension."
  }

  & $extensionCommand -Context $Context
}

function Invoke-DiscordJsonRequest {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Method,
    [Parameter(Mandatory = $true)]
    [string] $Url,
    [Parameter(Mandatory = $true)]
    [string] $BotToken,
    [Parameter(Mandatory = $true)]
    [string] $JsonBody
  )

  $bodyPath = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName() + ".json")

  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($bodyPath, $JsonBody, $utf8NoBom)
    $response = & curl.exe -fsS -X $Method $Url `
      -H "Authorization: Bot $BotToken" `
      -H "Content-Type: application/json" `
      --data-binary "@$bodyPath"

    if ($LASTEXITCODE -ne 0) {
      throw "Request failed for $Url"
    }

    return $response
  } finally {
    Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
  }
}

function Open-OwnerDmChannel {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BotToken,
    [Parameter(Mandatory = $true)]
    [string] $OwnerDiscordId
  )

  $payload = @{ recipient_id = $OwnerDiscordId } | ConvertTo-Json -Compress
  $response = Invoke-DiscordJsonRequest -Method "POST" -Url "https://discord.com/api/v10/users/@me/channels" -BotToken $BotToken -JsonBody $payload

  $parsed = $response | ConvertFrom-Json

  if (-not $parsed.id) {
    throw "Discord DM open returned no channel id."
  }

  return [string]$parsed.id
}

function Send-OwnerDm {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BotToken,
    [Parameter(Mandatory = $true)]
    [string] $OwnerDiscordId,
    [Parameter(Mandatory = $true)]
    [string] $Content
  )

  $dmChannelId = Open-OwnerDmChannel -BotToken $BotToken -OwnerDiscordId $OwnerDiscordId
  $payload = @{
    content = if ($Content.Length -le 1900) { $Content } else { "$($Content.Substring(0, 1897))..." }
    allowed_mentions = @{
      parse = @()
    }
  } | ConvertTo-Json -Depth 4 -Compress

  [void](Invoke-DiscordJsonRequest -Method "POST" -Url "https://discord.com/api/v10/channels/$dmChannelId/messages" -BotToken $BotToken -JsonBody $payload)
}

function Build-OwnerNotificationMessage {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Status,
    [Parameter(Mandatory = $true)]
    [string[]] $IssueLines,
    [Parameter(Mandatory = $true)]
    [string] $HealthStatusPath
  )

  if ($Status -eq "healthy") {
    return "VoidBot watchdog checked again. The stack looks normal now. Health report: $HealthStatusPath"
  }

  $lines = @(
    "VoidBot watchdog smelled smoke."
    "Health report: $HealthStatusPath"
    ""
  ) + ($IssueLines | ForEach-Object { "- $_" })

  return ($lines -join [Environment]::NewLine).Trim()
}

function Set-WatchdogStep {
  param(
    [Parameter(Mandatory = $true)]
    [string] $CurrentStep,
    [Parameter(Mandatory = $false)]
    [string] $Detail = ""
  )

  $script:watchdogState.currentStep = $CurrentStep
  $script:watchdogState.currentDetail = $Detail
  $script:watchdogState.stepUpdatedAt = (Get-Date).ToString("o")
  Write-StatusFile -Path $script:watchdogStatePath -Status $script:watchdogState
}

$checks = @()
$config = Read-DotEnv -Path $envFile
$storageRoot = Resolve-ConfigPath -RepoRoot $repoRoot -Value $config["STORAGE_ROOT"] -Fallback ".voidbot"
$statusPath = Join-Path $storageRoot "status\operations-health.json"
$watchdogStatePath = Join-Path $storageRoot "status\operations-watchdog.json"
$logPath = Join-Path $storageRoot "logs\operations-watchdog.log"
$runtimeStatusPath = Join-Path $storageRoot "status\runtime-stack.json"
$offsiteStatusPath = Join-Path $storageRoot "status\offsite-backup.json"
$backupRoot = Join-Path $storageRoot "backups"
$backupMaxAgeHours = if ($config.ContainsKey("VOIDBOT_BACKUP_MAX_AGE_HOURS")) { [double]$config["VOIDBOT_BACKUP_MAX_AGE_HOURS"] } else { 30.0 }
$offsiteMaxAgeHours = if ($config.ContainsKey("VOIDBOT_OFFSITE_BACKUP_MAX_AGE_HOURS")) { [double]$config["VOIDBOT_OFFSITE_BACKUP_MAX_AGE_HOURS"] } else { 36.0 }
$notifyRepeatHours = if ($config.ContainsKey("VOIDBOT_HEALTHCHECK_NOTIFY_REPEAT_HOURS")) { [double]$config["VOIDBOT_HEALTHCHECK_NOTIFY_REPEAT_HOURS"] } else { 12.0 }
$stackStartupTaskName = if ($config.ContainsKey("VOIDBOT_STACK_STARTUP_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_STACK_STARTUP_TASK_NAME"])) { $config["VOIDBOT_STACK_STARTUP_TASK_NAME"] } else { "VoidBot Stack Startup" }
$watchdogTaskName = if ($config.ContainsKey("VOIDBOT_HEALTHCHECK_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_HEALTHCHECK_TASK_NAME"])) { $config["VOIDBOT_HEALTHCHECK_TASK_NAME"] } else { "VoidBot Operations Watchdog" }
$offsiteTaskName = if ($config.ContainsKey("OFFSITE_BACKUP_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_TASK_NAME"])) { $config["OFFSITE_BACKUP_TASK_NAME"] } else { "VoidBot Offsite Backup" }
$offsiteRemoteWindowsDir = if ($config.ContainsKey("OFFSITE_BACKUP_REMOTE_WINDOWS_DIR") -and -not [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_REMOTE_WINDOWS_DIR"])) { $config["OFFSITE_BACKUP_REMOTE_WINDOWS_DIR"] } else { "C:\Meta\voidbot-backups" }
$offsiteTarget = if ($config.ContainsKey("OFFSITE_BACKUP_SSH_TARGET")) { $config["OFFSITE_BACKUP_SSH_TARGET"] } else { "" }
$offsiteKeepLatest = if ($config.ContainsKey("OFFSITE_BACKUP_REMOTE_KEEP_LATEST")) { [int]$config["OFFSITE_BACKUP_REMOTE_KEEP_LATEST"] } else { 14 }
$offsiteLabel = if ($config.ContainsKey("OFFSITE_BACKUP_LABEL") -and -not [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_LABEL"])) { $config["OFFSITE_BACKUP_LABEL"] } else { "offsite-auto" }
$watchdogExtensionScriptRaw = if ($config.ContainsKey("VOIDBOT_HEALTHCHECK_EXTENSION_SCRIPT") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_HEALTHCHECK_EXTENSION_SCRIPT"])) { $config["VOIDBOT_HEALTHCHECK_EXTENSION_SCRIPT"] } else { ".voidbot/private/check-voidbot-operations.local.ps1" }
$watchdogExtensionScript = Resolve-ConfigPath -RepoRoot $repoRoot -Value $watchdogExtensionScriptRaw -Fallback ".voidbot/private/check-voidbot-operations.local.ps1"
$watchdogExtensionExplicit = $config.ContainsKey("VOIDBOT_HEALTHCHECK_EXTENSION_SCRIPT") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_HEALTHCHECK_EXTENSION_SCRIPT"])
$logCaptureStarted = Start-LogCapture -LogPath $logPath
$previousWatchdogState = if (Test-Path -LiteralPath $watchdogStatePath) {
  try {
    Get-Content -LiteralPath $watchdogStatePath -Raw | ConvertFrom-Json
  } catch {
    $null
  }
} else {
  $null
}

$script:watchdogStatePath = $watchdogStatePath
$watchdogStartedAt = (Get-Date).ToString("o")
$watchdogState = @{
  taskName = $watchdogTaskName
  logPath = $logPath
  reportPath = $statusPath
  startedAt = $watchdogStartedAt
  completedAt = $null
  runStatus = "running"
  reportStatus = $null
  currentStep = "initializing"
  currentDetail = "Starting watchdog checks."
  stepUpdatedAt = $watchdogStartedAt
  executionTimeLimitMinutes = 15
  lastStatus = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastStatus")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastStatus") } else { $null }
  lastFingerprint = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastFingerprint")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastFingerprint") } else { $null }
  lastNotifiedAt = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt") } else { $null }
  lastNotificationReason = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotificationReason")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotificationReason") } else { $null }
  lastCompletedAt = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastCompletedAt")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastCompletedAt") } elseif ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "checkedAt")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "checkedAt") } else { $null }
  lastCompletedRunStatus = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastCompletedRunStatus")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastCompletedRunStatus") } else { $null }
  lastRunError = $null
}
Write-StatusFile -Path $watchdogStatePath -Status $watchdogState

try {
  Set-WatchdogStep -CurrentStep "runtime_checks" -Detail "Inspecting runtime stack status and bot/worker liveness."
  if (-not (Test-Path -LiteralPath $runtimeStatusPath)) {
    Add-Check -Name "runtime.status_file" -Status "failed" -Detail "runtime-stack.json is missing at $runtimeStatusPath."
  } else {
    try {
      $runtimeStatus = Get-Content -LiteralPath $runtimeStatusPath -Raw | ConvertFrom-Json
    } catch {
      Add-Check -Name "runtime.status_file" -Status "failed" -Detail "runtime-stack.json could not be parsed: $($_.Exception.Message)" -Data @{
        path = $runtimeStatusPath
      }
      $runtimeStatus = $null
    }

    if ($null -ne $runtimeStatus) {
      Add-Check -Name "runtime.status_file" -Status "passed" -Detail "Found runtime-stack.json." -Data @{
        path = $runtimeStatusPath
      }

      $runtimeStage = [string](Get-OptionalPropertyValue -InputObject $runtimeStatus -PropertyName "stage")
      $runtimeReady = Get-OptionalPropertyValue -InputObject $runtimeStatus -PropertyName "ready"

      if ($runtimeReady -eq $true -and $runtimeStage -eq "ready") {
        Add-Check -Name "runtime.lifecycle" -Status "passed" -Detail "Runtime status reports ready." -Data @{
          stage = $runtimeStage
          ready = $runtimeReady
        }
      } else {
        $stageLabel = if ([string]::IsNullOrWhiteSpace($runtimeStage)) { "(missing)" } else { $runtimeStage }
        Add-Check -Name "runtime.lifecycle" -Status "failed" -Detail "Runtime status reports stage '$stageLabel' with ready=$runtimeReady." -Data @{
          stage = $runtimeStage
          ready = $runtimeReady
        }
      }

      foreach ($component in @("bot", "worker")) {
        $componentStatus = Get-OptionalPropertyValue -InputObject $runtimeStatus -PropertyName $component
        $processIdValueRaw = Get-OptionalPropertyValue -InputObject $componentStatus -PropertyName "pid"
        $processIdValue = if ($null -ne $processIdValueRaw) { ($processIdValueRaw -as [int]) } else { $null }

        if ($null -eq $processIdValue -or $processIdValue -le 0) {
          Add-Check -Name "runtime.$component" -Status "failed" -Detail "$component PID is missing from runtime-stack.json."
          continue
        }

        if (Test-ProcessAlive -ProcessId $processIdValue) {
          Add-Check -Name "runtime.$component" -Status "passed" -Detail "$component process $processIdValue is running." -Data @{
            pid = $processIdValue
          }
        } else {
          Add-Check -Name "runtime.$component" -Status "failed" -Detail "$component process $processIdValue is not running anymore." -Data @{
            pid = $processIdValue
          }
        }
      }
    }
  }

  $vectorStoreKind = if ($config.ContainsKey("VECTOR_STORE_KIND")) { $config["VECTOR_STORE_KIND"] } else { "local_json" }
  $historyCollection = if ($config.ContainsKey("QDRANT_HISTORY_COLLECTION")) { $config["QDRANT_HISTORY_COLLECTION"] } else { "voidbot_discord_history_chunks" }
  $sourceCollection = if ($config.ContainsKey("QDRANT_SOURCE_COLLECTION")) { $config["QDRANT_SOURCE_COLLECTION"] } else { "voidbot_repository_source_chunks" }
  $qdrantReady = $vectorStoreKind -ne "qdrant"

  Set-WatchdogStep -CurrentStep "qdrant_checks" -Detail "Verifying Qdrant reachability and required collections."
  if ($vectorStoreKind -eq "qdrant") {
    $qdrantUrl = if ($config.ContainsKey("QDRANT_URL")) { $config["QDRANT_URL"] } else { "http://127.0.0.1:6333" }
    try {
      $collectionsResponse = Get-Json -Url "$($qdrantUrl.TrimEnd('/'))/collections"
      $collectionNames = @($collectionsResponse.result.collections | ForEach-Object { [string]$_.name })
      $qdrantReady = $true
      Add-Check -Name "qdrant.reachable" -Status "passed" -Detail "Qdrant is reachable at $qdrantUrl." -Data @{
        url = $qdrantUrl
        collections = $collectionNames
      }

      foreach ($requiredCollection in @($historyCollection, $sourceCollection)) {
        if ($collectionNames -contains $requiredCollection) {
          Add-Check -Name "qdrant.collection.$requiredCollection" -Status "passed" -Detail "Qdrant collection $requiredCollection exists."
        } else {
          Add-Check -Name "qdrant.collection.$requiredCollection" -Status "failed" -Detail "Qdrant collection $requiredCollection is missing."
        }
      }
    } catch {
      Add-Check -Name "qdrant.reachable" -Status "failed" -Detail "Qdrant check failed: $($_.Exception.Message)" -Data @{
        url = $qdrantUrl
      }
    }
  } else {
    Add-Check -Name "qdrant.reachable" -Status "passed" -Detail "Qdrant check skipped because VECTOR_STORE_KIND=$vectorStoreKind." -Data @{
      vectorStoreKind = $vectorStoreKind
    }
  }

  $stateStorageBackend = if ($config.ContainsKey("STATE_STORAGE_BACKEND")) { $config["STATE_STORAGE_BACKEND"] } else { "postgres" }

  Set-WatchdogStep -CurrentStep "postgres_checks" -Detail "Checking Postgres container health and required tables."
  if ($stateStorageBackend -eq "postgres") {
    $databaseDsn = if ($config.ContainsKey("DATABASE_DSN")) { $config["DATABASE_DSN"] } else { "" }
    $dsn = Parse-DatabaseDsn -Dsn $databaseDsn

    if (-not (Test-DockerAvailable)) {
      Add-Check -Name "postgres.health" -Status "warning" -Detail "Skipped Postgres container health check because Docker is unavailable." -Data @{
        dsn = $databaseDsn
      }
    } else {
      $dockerExe = Get-DockerExecutable
      $containerHealth = Get-DockerContainerHealth -ContainerName "voidbot-postgres"

      if ($containerHealth -eq "healthy") {
        Add-Check -Name "postgres.health" -Status "passed" -Detail "Postgres container is healthy." -Data @{
          containerName = "voidbot-postgres"
          database = $dsn.database
        }

        try {
          $tableResult = & $dockerExe exec voidbot-postgres psql -U $dsn.username -d $dsn.database -tAc "select table_name from information_schema.tables where table_schema = 'public';"

          if ($LASTEXITCODE -ne 0) {
            $stderr = $Error[0].ToString().Trim()
            if ([string]::IsNullOrWhiteSpace($stderr)) {
              throw "psql table listing failed."
            }

            throw "psql table listing failed: $stderr"
          }

          $tables = @($tableResult -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
          foreach ($requiredTable in @("jobs", "audit_events", "interaction_memory_events")) {
            if ($tables -contains $requiredTable) {
              Add-Check -Name "postgres.table.$requiredTable" -Status "passed" -Detail "Postgres table $requiredTable exists."
            } else {
              Add-Check -Name "postgres.table.$requiredTable" -Status "failed" -Detail "Postgres table $requiredTable is missing."
            }
          }
        } catch {
          Add-Check -Name "postgres.tables" -Status "warning" -Detail "Could not verify Postgres tables: $($_.Exception.Message)"
        }
      } elseif ($containerHealth) {
        Add-Check -Name "postgres.health" -Status "failed" -Detail "Postgres container health is '$containerHealth' instead of healthy." -Data @{
          containerName = "voidbot-postgres"
        }
      } else {
        Add-Check -Name "postgres.health" -Status "failed" -Detail "Postgres container voidbot-postgres is not available."
      }
    }
  } else {
    Add-Check -Name "postgres.health" -Status "passed" -Detail "Postgres check skipped because STATE_STORAGE_BACKEND=$stateStorageBackend." -Data @{
      stateStorageBackend = $stateStorageBackend
    }
  }

  $ragOllamaUrl = if ($config.ContainsKey("RAG_OLLAMA_BASE_URL")) { $config["RAG_OLLAMA_BASE_URL"] } else { "http://127.0.0.1:11434" }
  $ragOllamaModel = if ($config.ContainsKey("RAG_OLLAMA_MODEL")) { $config["RAG_OLLAMA_MODEL"] } else { "qwen3-embedding:0.6b" }
  $ragOllamaReady = $false

  Set-WatchdogStep -CurrentStep "ollama_checks" -Detail "Checking embedding and local LLM Ollama endpoints."
  try {
    $ragTags = Get-Json -Url "$($ragOllamaUrl.TrimEnd('/'))/api/tags"
    $ragModels = @($ragTags.models | ForEach-Object { [string]$_.name })

    if ($ragModels -contains $ragOllamaModel) {
      $ragOllamaReady = $true
      Add-Check -Name "rag_ollama.model" -Status "passed" -Detail "Embedding Ollama is reachable and has $ragOllamaModel." -Data @{
        url = $ragOllamaUrl
        model = $ragOllamaModel
      }
    } else {
      Add-Check -Name "rag_ollama.model" -Status "failed" -Detail "Embedding Ollama is reachable but missing $ragOllamaModel." -Data @{
        url = $ragOllamaUrl
        models = $ragModels
      }
    }
  } catch {
    Add-Check -Name "rag_ollama.model" -Status "failed" -Detail "Embedding Ollama check failed: $($_.Exception.Message)" -Data @{
      url = $ragOllamaUrl
      model = $ragOllamaModel
    }
  }

  $enabledProviders = if ($config.ContainsKey("ENABLED_PROVIDERS") -and -not [string]::IsNullOrWhiteSpace($config["ENABLED_PROVIDERS"])) {
    @($config["ENABLED_PROVIDERS"].Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  } else {
    @()
  }
  $localLlmUrl = if ($config.ContainsKey("LOCAL_LLM_OLLAMA_BASE_URL")) { $config["LOCAL_LLM_OLLAMA_BASE_URL"] } else { "" }
  $localLlmModel = if ($config.ContainsKey("LOCAL_LLM_OLLAMA_MODEL")) { $config["LOCAL_LLM_OLLAMA_MODEL"] } else { "" }
  $localLlmSocialReadModel = if (
    $config.ContainsKey("LOCAL_LLM_SOCIAL_READ_OLLAMA_MODEL") -and
    -not [string]::IsNullOrWhiteSpace($config["LOCAL_LLM_SOCIAL_READ_OLLAMA_MODEL"])
  ) {
    $config["LOCAL_LLM_SOCIAL_READ_OLLAMA_MODEL"]
  } else {
    $localLlmModel
  }
  $localLlmEnabled = ($enabledProviders -contains "local_llm") -or (
    $config.ContainsKey("LOCAL_LLM_ALLOW_PUBLIC") -and [string]$config["LOCAL_LLM_ALLOW_PUBLIC"] -eq "true"
  )

  if ($localLlmEnabled -and -not [string]::IsNullOrWhiteSpace($localLlmUrl) -and -not [string]::IsNullOrWhiteSpace($localLlmModel)) {
    try {
      $localLlmTags = Get-Json -Url "$($localLlmUrl.TrimEnd('/'))/api/tags"
      $localLlmModels = @($localLlmTags.models | ForEach-Object { [string]$_.name })

      if ($localLlmModels -contains $localLlmModel) {
        Add-Check -Name "local_llm.model" -Status "passed" -Detail "Local LLM Ollama is reachable and has $localLlmModel." -Data @{
          url = $localLlmUrl
          model = $localLlmModel
        }
      } else {
        Add-Check -Name "local_llm.model" -Status "failed" -Detail "Local LLM Ollama is reachable but missing $localLlmModel." -Data @{
          url = $localLlmUrl
          models = $localLlmModels
        }
      }

      if ([string]::IsNullOrWhiteSpace($localLlmSocialReadModel)) {
        Add-Check -Name "local_llm.social_read_model" -Status "warning" -Detail "Social-read sidecar model is blank, so it will fall back to the main local LLM model." -Data @{
          url = $localLlmUrl
          model = $localLlmModel
        }
      } elseif ($localLlmModels -contains $localLlmSocialReadModel) {
        $socialReadDetail = if ($localLlmSocialReadModel -eq $localLlmModel) {
          "Social-read sidecar reuses the main local LLM model $localLlmSocialReadModel."
        } else {
          "Social-read sidecar is reachable and has $localLlmSocialReadModel."
        }

        Add-Check -Name "local_llm.social_read_model" -Status "passed" -Detail $socialReadDetail -Data @{
          url = $localLlmUrl
          model = $localLlmSocialReadModel
        }
      } else {
        Add-Check -Name "local_llm.social_read_model" -Status "failed" -Detail "Local LLM Ollama is reachable but missing social-read model $localLlmSocialReadModel." -Data @{
          url = $localLlmUrl
          models = $localLlmModels
        }
      }
    } catch {
      Add-Check -Name "local_llm.model" -Status "failed" -Detail "Local LLM Ollama check failed: $($_.Exception.Message)" -Data @{
        url = $localLlmUrl
        model = $localLlmModel
      }
      Add-Check -Name "local_llm.social_read_model" -Status "failed" -Detail "Social-read Ollama check failed: $($_.Exception.Message)" -Data @{
        url = $localLlmUrl
        model = $localLlmSocialReadModel
      }
    }
  } else {
    Add-Check -Name "local_llm.model" -Status "passed" -Detail "Local LLM check skipped because the provider is not enabled for this runtime." -Data @{
      enabledProviders = $enabledProviders
    }
    Add-Check -Name "local_llm.social_read_model" -Status "passed" -Detail "Social-read model check skipped because the local LLM provider is not enabled for this runtime." -Data @{
      enabledProviders = $enabledProviders
    }
  }

  $sourceRepoRoot = if ($config.ContainsKey("SOURCE_REPO_ROOT")) { $config["SOURCE_REPO_ROOT"] } else { "" }
  if ([string]::IsNullOrWhiteSpace($sourceRepoRoot)) {
    Add-Check -Name "source.repos" -Status "passed" -Detail "Source repo reconciliation check skipped because SOURCE_REPO_ROOT is blank."
  } else {
    Set-WatchdogStep -CurrentStep "source_repo_checks" -Detail "Reconciling discovered source repos against the indexed source archive."

    try {
      $sourceRepoPreview = Invoke-SourceRepoReconcile -CheckOnly
      $missingRepos = @($sourceRepoPreview.missingRepos | ForEach-Object { [string]$_ })
      $staleIndexedRepos = @($sourceRepoPreview.staleIndexedRepos | ForEach-Object { [string]$_ })

      if ($missingRepos.Count -eq 0) {
        Add-Check -Name "source.repos" -Status "passed" -Detail "All discovered source repos are represented in the indexed source archive." -Data @{
          discoveredRepoCount = [int]$sourceRepoPreview.discoveredRepoCount
          indexedRepoCount = [int]$sourceRepoPreview.indexedRepoCount
          selectedRepoCount = [int]$sourceRepoPreview.selectedRepoCount
        }
      } elseif ($qdrantReady -and $ragOllamaReady) {
        $sourceRepoRepair = Invoke-SourceRepoReconcile -Detached
        $launchedRepos = @($sourceRepoRepair.launchedRepos | ForEach-Object { [string]$_ })
        Add-Check -Name "source.repos" -Status "warning" -Detail "Detected $($missingRepos.Count) unindexed source repos and launched detached reconciliation." -Data @{
          missingRepos = $missingRepos
          launchedRepos = $launchedRepos
          discoveredRepoCount = [int]$sourceRepoPreview.discoveredRepoCount
          indexedRepoCount = [int]$sourceRepoPreview.indexedRepoCount
        }
      } else {
        Add-Check -Name "source.repos" -Status "failed" -Detail "Detected $($missingRepos.Count) unindexed source repos, but source indexing dependencies are unhealthy." -Data @{
          missingRepos = $missingRepos
          qdrantReady = $qdrantReady
          ragOllamaReady = $ragOllamaReady
        }
      }

      if ($staleIndexedRepos.Count -eq 0) {
        Add-Check -Name "source.stale_index" -Status "passed" -Detail "Indexed source archive has no repo summaries for repos that are no longer present."
      } else {
        Add-Check -Name "source.stale_index" -Status "warning" -Detail "Indexed source archive still carries repo summaries for repos that are no longer present." -Data @{
          staleIndexedRepos = $staleIndexedRepos
        }
      }
    } catch {
      Add-Check -Name "source.repos" -Status "failed" -Detail "Source repo reconciliation check failed: $($_.Exception.Message)" -Data @{
        sourceRepoRoot = $sourceRepoRoot
      }
    }
  }

  if ($config.ContainsKey("DISCORD_BOT_TOKEN") -and -not [string]::IsNullOrWhiteSpace($config["DISCORD_BOT_TOKEN"])) {
    Set-WatchdogStep -CurrentStep "discord_checks" -Detail "Validating Discord bot credentials."
    try {
      $botIdentity = Get-Json -Url "https://discord.com/api/v10/users/@me" -Headers @("Authorization: Bot $($config["DISCORD_BOT_TOKEN"])")
      Add-Check -Name "discord.bot_token" -Status "passed" -Detail "Discord bot token is valid for $([string]$botIdentity.username)." -Data @{
        id = [string]$botIdentity.id
        username = [string]$botIdentity.username
      }
    } catch {
      Add-Check -Name "discord.bot_token" -Status "failed" -Detail "Discord bot token check failed: $($_.Exception.Message)"
    }
  } else {
    Add-Check -Name "discord.bot_token" -Status "warning" -Detail "DISCORD_BOT_TOKEN is blank; bot identity could not be checked."
  }

  $latestBackup = Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1

  Set-WatchdogStep -CurrentStep "backup_checks" -Detail "Verifying the latest local backup and freshness thresholds."
  if ($null -eq $latestBackup) {
    Add-Check -Name "backup.latest" -Status "failed" -Detail "No local backup directory exists under $backupRoot."
  } else {
    try {
      $verificationJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifyScript -BackupPath $latestBackup.FullName -AsJson -Quiet
      $verificationReport = $verificationJson | ConvertFrom-Json
      $createdAtCheck = $verificationReport.checks | Where-Object { $_.name -eq "backup.created_at" } | Select-Object -First 1
      $backupAgeHours = if ($createdAtCheck -and $createdAtCheck.data -and $createdAtCheck.data.ageHours) { [double]$createdAtCheck.data.ageHours } else { [Math]::Round(((Get-Date) - $latestBackup.LastWriteTime).TotalHours, 2) }

      if ([string]$verificationReport.status -eq "failed") {
        Add-Check -Name "backup.latest" -Status "failed" -Detail "Latest local backup failed verification." -Data @{
          path = $latestBackup.FullName
          verification = $verificationReport
        }
      } else {
        Add-Check -Name "backup.latest" -Status "passed" -Detail "Latest local backup passed verification." -Data @{
          path = $latestBackup.FullName
          verificationStatus = [string]$verificationReport.status
          ageHours = $backupAgeHours
        }
      }

      if ($backupAgeHours -le $backupMaxAgeHours) {
        Add-Check -Name "backup.freshness" -Status "passed" -Detail "Latest local backup is $backupAgeHours hours old." -Data @{
          thresholdHours = $backupMaxAgeHours
          path = $latestBackup.FullName
        }
      } else {
        Add-Check -Name "backup.freshness" -Status "failed" -Detail "Latest local backup is $backupAgeHours hours old, which exceeds the $backupMaxAgeHours hour threshold." -Data @{
          thresholdHours = $backupMaxAgeHours
          path = $latestBackup.FullName
        }
      }
    } catch {
      Add-Check -Name "backup.latest" -Status "failed" -Detail "Failed to verify the latest local backup: $($_.Exception.Message)" -Data @{
        path = $latestBackup.FullName
      }
    }
  }

  Set-WatchdogStep -CurrentStep "scheduled_task_checks" -Detail "Inspecting scheduled task installation and status files."
  try {
    $startupTask = Get-ScheduledTask -TaskName $stackStartupTaskName -ErrorAction Stop
    $startupEnabled = [bool]$startupTask.Settings.Enabled
    $startupTaskStatus = if ($startupEnabled) { "passed" } else { "failed" }
    $startupTaskDetail = if ($startupEnabled) { "Stack startup task is installed and enabled." } else { "Stack startup task is installed but disabled." }
    Add-Check -Name "scheduled_task.stack_startup" -Status $startupTaskStatus -Detail $startupTaskDetail -Data @{
      taskName = $stackStartupTaskName
      state = [string]$startupTask.State
    }
  } catch {
    Add-Check -Name "scheduled_task.stack_startup" -Status "warning" -Detail "Stack startup task $stackStartupTaskName is not installed yet."
  }

  try {
    $offsiteTask = Get-ScheduledTask -TaskName $offsiteTaskName -ErrorAction Stop
    $offsiteEnabled = [bool]$offsiteTask.Settings.Enabled
    $offsiteTaskStatus = if ($offsiteEnabled) { "passed" } else { "failed" }
    $offsiteTaskDetail = if ($offsiteEnabled) { "Offsite backup task is installed and enabled." } else { "Offsite backup task is installed but disabled." }
    Add-Check -Name "scheduled_task.offsite_backup" -Status $offsiteTaskStatus -Detail $offsiteTaskDetail -Data @{
      taskName = $offsiteTaskName
      state = [string]$offsiteTask.State
    }
  } catch {
    Add-Check -Name "scheduled_task.offsite_backup" -Status "failed" -Detail "Offsite backup task $offsiteTaskName is not installed."
  }

  try {
    $watchdogTask = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction Stop
    $watchdogEnabled = [bool]$watchdogTask.Settings.Enabled
    $watchdogTaskStatus = if ($watchdogEnabled) { "passed" } else { "failed" }
    $watchdogTaskDetail = if ($watchdogEnabled) { "Operations watchdog task is installed and enabled." } else { "Operations watchdog task is installed but disabled." }
    Add-Check -Name "scheduled_task.watchdog" -Status $watchdogTaskStatus -Detail $watchdogTaskDetail -Data @{
      taskName = $watchdogTaskName
      state = [string]$watchdogTask.State
    }
  } catch {
    Add-Check -Name "scheduled_task.watchdog" -Status "warning" -Detail "Operations watchdog task $watchdogTaskName is not installed yet."
  }

  if (Test-Path -LiteralPath $offsiteStatusPath) {
    try {
      $offsiteStatus = Get-Content -LiteralPath $offsiteStatusPath -Raw | ConvertFrom-Json

      if ([string]$offsiteStatus.status -eq "completed") {
        Add-Check -Name "offsite.status_file" -Status "passed" -Detail "Latest offsite sync status is completed." -Data @{
          completedAt = [string]$offsiteStatus.completedAt
          remoteFile = $offsiteStatus.remoteFile
        }
      } else {
        Add-Check -Name "offsite.status_file" -Status "failed" -Detail "Latest offsite sync status is '$([string]$offsiteStatus.status)' instead of completed." -Data @{
          error = [string](Get-OptionalPropertyValue -InputObject $offsiteStatus -PropertyName "error")
        }
      }
    } catch {
      Add-Check -Name "offsite.status_file" -Status "failed" -Detail "Failed to parse offsite-backup.json: $($_.Exception.Message)"
    }
  } else {
    Add-Check -Name "offsite.status_file" -Status "failed" -Detail "offsite-backup.json is missing at $offsiteStatusPath."
  }

  Set-WatchdogStep -CurrentStep "offsite_remote_checks" -Detail "Checking remote offsite backup freshness and retention."
  if ([string]::IsNullOrWhiteSpace($offsiteTarget)) {
    Add-Check -Name "offsite.remote" -Status "warning" -Detail "Remote offsite backup check skipped because OFFSITE_BACKUP_SSH_TARGET is blank."
  } else {
    try {
      $escapedRemoteDir = Escape-SingleQuotedPowerShell -Value $offsiteRemoteWindowsDir
      $escapedPattern = Escape-SingleQuotedPowerShell -Value "*-$offsiteLabel.zip"
      $remoteScript = @'
$dir = '{0}'
$pattern = '{1}'
if (-not (Test-Path -LiteralPath $dir)) {{
  throw "Missing remote backup directory $dir"
}}
$files = Get-ChildItem -LiteralPath $dir -Filter $pattern -File | Sort-Object LastWriteTimeUtc -Descending
[pscustomobject]@{{
  count = @($files).Count
  newest = if (@($files).Count -gt 0) {{
    [pscustomobject]@{{
      name = $files[0].Name
      size = $files[0].Length
      lastWriteTimeUtc = $files[0].LastWriteTimeUtc.ToString('o')
    }}
  }} else {{
    $null
  }}
}} | ConvertTo-Json -Compress -Depth 4
'@ -f $escapedRemoteDir, $escapedPattern
      $remoteListing = Invoke-RemotePowerShellJson -Target $offsiteTarget -ScriptText $remoteScript

      if ($null -eq $remoteListing -or [int]$remoteListing.count -lt 1) {
        Add-Check -Name "offsite.remote" -Status "failed" -Detail "Remote offsite backup directory has no archives matching *-$offsiteLabel.zip." -Data @{
          target = $offsiteTarget
          remoteWindowsDir = $offsiteRemoteWindowsDir
        }
      } else {
        $remoteNewest = $remoteListing.newest
        $remoteAgeHours = [Math]::Round(([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$remoteNewest.lastWriteTimeUtc)).TotalHours, 2)

        if ($remoteAgeHours -le $offsiteMaxAgeHours) {
          Add-Check -Name "offsite.remote" -Status "passed" -Detail "Newest remote offsite archive is $remoteAgeHours hours old." -Data @{
            target = $offsiteTarget
            remoteWindowsDir = $offsiteRemoteWindowsDir
            newest = $remoteNewest
            archiveCount = [int]$remoteListing.count
            thresholdHours = $offsiteMaxAgeHours
          }
        } else {
          Add-Check -Name "offsite.remote" -Status "failed" -Detail "Newest remote offsite archive is $remoteAgeHours hours old, which exceeds the $offsiteMaxAgeHours hour threshold." -Data @{
            target = $offsiteTarget
            remoteWindowsDir = $offsiteRemoteWindowsDir
            newest = $remoteNewest
            archiveCount = [int]$remoteListing.count
            thresholdHours = $offsiteMaxAgeHours
          }
        }

        if ([int]$remoteListing.count -le $offsiteKeepLatest) {
          Add-Check -Name "offsite.retention" -Status "passed" -Detail "Remote offsite archive count $([int]$remoteListing.count) is within the configured keep limit of $offsiteKeepLatest." -Data @{
            archiveCount = [int]$remoteListing.count
            keepLatest = $offsiteKeepLatest
          }
        } else {
          Add-Check -Name "offsite.retention" -Status "warning" -Detail "Remote offsite archive count $([int]$remoteListing.count) exceeds the configured keep limit of $offsiteKeepLatest." -Data @{
            archiveCount = [int]$remoteListing.count
            keepLatest = $offsiteKeepLatest
          }
        }
      }
    } catch {
      Add-Check -Name "offsite.remote" -Status "failed" -Detail "Remote offsite backup check failed: $($_.Exception.Message)" -Data @{
        target = $offsiteTarget
        remoteWindowsDir = $offsiteRemoteWindowsDir
      }
    }
  }

  Set-WatchdogStep -CurrentStep "extension_checks" -Detail "Running local watchdog extension checks."
  if (Test-Path -LiteralPath $watchdogExtensionScript) {
    try {
      Invoke-WatchdogExtension -Path $watchdogExtensionScript -Context @{
        RepoRoot = $repoRoot
        StorageRoot = $storageRoot
        Config = $config
        RuntimeStatusPath = $runtimeStatusPath
        HealthStatusPath = $statusPath
        OffsiteStatusPath = $offsiteStatusPath
        NotifyOwner = [bool]$NotifyOwner
      }
      Add-Check -Name "watchdog.extension" -Status "passed" -Detail "Loaded local watchdog extension checks." -Data @{
        path = $watchdogExtensionScript
      }
    } catch {
      Add-Check -Name "watchdog.extension" -Status "failed" -Detail "Local watchdog extension failed: $($_.Exception.Message)" -Data @{
        path = $watchdogExtensionScript
      }
    }
  } elseif ($watchdogExtensionExplicit) {
    Add-Check -Name "watchdog.extension" -Status "warning" -Detail "Configured watchdog extension script is missing." -Data @{
      path = $watchdogExtensionScript
    }
  }

  Set-WatchdogStep -CurrentStep "notification_decision" -Detail "Computing report fingerprint and notification rules."
  $preNotificationReport = Finalize-Report
  $issueLines = @($preNotificationReport.checks | Where-Object { $_.status -ne "passed" } | ForEach-Object { "$($_.name): $($_.detail)" })
  $fingerprintSource = if ($issueLines.Count -eq 0) { "healthy" } else { $issueLines -join "`n" }
  $fingerprint = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($fingerprintSource))

  $notification = @{
    attempted = $false
    sent = $false
    reason = $null
  }

  if ($NotifyOwner -and $config.ContainsKey("DISCORD_BOT_TOKEN") -and -not [string]::IsNullOrWhiteSpace($config["DISCORD_BOT_TOKEN"])) {
    $lastFingerprint = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastFingerprint")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastFingerprint") } else { "" }
    $lastNotifiedAt = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt")) { [DateTimeOffset]::Parse([string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt")) } else { $null }
    $lastStatus = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastStatus")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastStatus") } else { "" }
    $shouldNotify = $false
    $notificationReason = $null

    if ($preNotificationReport.status -eq "healthy") {
      if ($lastStatus -and $lastStatus -ne "healthy") {
        $shouldNotify = $true
        $notificationReason = "recovered"
      }
    } else {
      $elapsedHours = if ($lastNotifiedAt) { ([DateTimeOffset]::Now - $lastNotifiedAt).TotalHours } else { $null }
      if ($fingerprint -ne $lastFingerprint) {
        $shouldNotify = $true
        $notificationReason = "issue_changed"
      } elseif ($null -eq $elapsedHours -or $elapsedHours -ge $notifyRepeatHours) {
        $shouldNotify = $true
        $notificationReason = "repeat"
      }
    }

    if ($shouldNotify) {
      Set-WatchdogStep -CurrentStep "notification_send" -Detail "Sending owner notification."
      $notification.attempted = $true
      try {
        $message = Build-OwnerNotificationMessage -Status $preNotificationReport.status -IssueLines $issueLines -HealthStatusPath $statusPath
        Send-OwnerDm -BotToken $config["DISCORD_BOT_TOKEN"] -OwnerDiscordId $config["DISCORD_OWNER_ID"] -Content $message
        $notification.sent = $true
        $notification.reason = $notificationReason
      } catch {
        $notification.sent = $false
        $notification.reason = "failed"
        $notification.error = $_.Exception.Message
        Add-Check -Name "watchdog.notification" -Status "warning" -Detail "Failed to DM the owner about watchdog status: $($_.Exception.Message)"
      }
    }
  }

  Set-WatchdogStep -CurrentStep "finalizing" -Detail "Writing final health report."
  $report = Finalize-Report
  $report.notification = $notification
  Write-StatusFile -Path $statusPath -Status $report

  $watchdogStatePayload = @{
    taskName = $watchdogTaskName
    logPath = $logPath
    reportPath = $statusPath
    startedAt = $watchdogStartedAt
    completedAt = (Get-Date).ToString("o")
    checkedAt = $report.checkedAt
    runStatus = "completed"
    reportStatus = $report.status
    currentStep = "finished"
    currentDetail = "Watchdog run completed."
    stepUpdatedAt = (Get-Date).ToString("o")
    executionTimeLimitMinutes = 15
    lastStatus = $report.status
    lastFingerprint = $fingerprint
    lastNotifiedAt = if ($notification.sent) { (Get-Date).ToString("o") } elseif ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt") } else { $null }
    lastNotificationReason = $notification.reason
    lastCompletedAt = (Get-Date).ToString("o")
    lastCompletedRunStatus = "completed"
    lastRunError = $null
  }
  Write-StatusFile -Path $watchdogStatePath -Status $watchdogStatePayload

  Write-Host "VoidBot operations status: $($report.status)"
  foreach ($check in $report.checks) {
    Write-Host ("[{0}] {1}: {2}" -f $check.status.ToUpperInvariant(), $check.name, $check.detail)
  }

  if ($FailOnIssues -and $report.status -eq "failed") {
    exit 1
  }

  exit 0
} catch {
  Add-Check -Name "watchdog.internal" -Status "failed" -Detail "Operations watchdog crashed: $($_.Exception.Message)"
  $report = Finalize-Report
  $report.notification = @{
    attempted = $false
    sent = $false
    reason = "internal_error"
    error = $_.Exception.Message
  }
  Write-StatusFile -Path $statusPath -Status $report
  $watchdogFailureState = @{
    taskName = $watchdogTaskName
    logPath = $logPath
    reportPath = $statusPath
    startedAt = $watchdogStartedAt
    completedAt = (Get-Date).ToString("o")
    checkedAt = $report.checkedAt
    runStatus = "failed"
    reportStatus = $report.status
    currentStep = "crashed"
    currentDetail = "Watchdog crashed before finishing."
    stepUpdatedAt = (Get-Date).ToString("o")
    executionTimeLimitMinutes = 15
    lastStatus = $report.status
    lastFingerprint = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastFingerprint")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastFingerprint") } else { $null }
    lastNotifiedAt = if ($previousWatchdogState -and (Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt")) { [string](Get-OptionalPropertyValue -InputObject $previousWatchdogState -PropertyName "lastNotifiedAt") } else { $null }
    lastNotificationReason = "internal_error"
    lastCompletedAt = (Get-Date).ToString("o")
    lastCompletedRunStatus = "failed"
    lastRunError = $_.Exception.Message
  }
  Write-StatusFile -Path $watchdogStatePath -Status $watchdogFailureState
  Write-Host "VoidBot operations status: failed"
  Write-Host "[FAILED] watchdog.internal: Operations watchdog crashed: $($_.Exception.Message)"
  exit 1
} finally {
  Stop-LogCapture -Started $logCaptureStarted
}
