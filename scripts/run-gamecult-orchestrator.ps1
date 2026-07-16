param(
  [string[]] $Only,
  [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$statusDir = Join-Path $repoRoot ".voidbot\status"
$logDir = Join-Path $repoRoot ".voidbot\logs\orchestrator"
$statePath = Join-Path $statusDir "gamecult-orchestrator.json"
$lockPath = Join-Path $statusDir "gamecult-orchestrator.lock"
$agentSwarmPausePath = Join-Path $repoRoot "state\agent-swarm-paused.json"
$hiddenLauncher = Join-Path $PSScriptRoot "run-hidden-powershell.vbs"
$bifrostRoot = "E:\Projects\Bifrost"
$bootstrapLogPath = Join-Path $logDir "bootstrap.log"

function Write-BootstrapLog {
  param([string] $Message)
  try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $line = "[{0}] pid={1} cwd={2} {3}" -f ([DateTime]::UtcNow.ToString("o")), $PID, (Get-Location).Path, $Message
    Add-Content -LiteralPath $bootstrapLogPath -Encoding UTF8 -Value $line
  } catch {
  }
}

function Read-DotEnv {
  param([Parameter(Mandatory = $true)][string] $Path)
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $values
  }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
      continue
    }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) {
      continue
    }
    $values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1).Trim()
  }
  return $values
}

function Get-ConfigInt {
  param(
    [hashtable] $Config,
    [string] $Name,
    [int] $Default,
    [int] $Minimum
  )
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw) -and $Config.ContainsKey($Name)) {
    $raw = $Config[$Name]
  }
  $value = $Default
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    $value = [int]$raw
  }
  return [Math]::Max($Minimum, $value)
}

function Get-ConfigBool {
  param(
    [hashtable] $Config,
    [string] $Name,
    [bool] $Default
  )
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw) -and $Config.ContainsKey($Name)) {
    $raw = $Config[$Name]
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $Default
  }
  return @("1", "true", "yes", "on").Contains($raw.Trim().ToLowerInvariant())
}

function Read-JsonFile {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }
  return $raw | ConvertFrom-Json
}

function Write-JsonFile {
  param([string] $Path, $Data)
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $json = $Data | ConvertTo-Json -Depth 32
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function ConvertTo-WindowsArgument {
  param([string] $Value)
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Join-WindowsArguments {
  param([object[]] $Arguments)
  return (($Arguments | ForEach-Object { ConvertTo-WindowsArgument -Value ([string]$_) }) -join " ")
}

function Publish-IdunnRudpHealth {
  param(
    [Parameter(Mandatory = $true)] $Summary
  )

  $publisher = Join-Path $PSScriptRoot "publish-idunn-rudp-health.cjs"
  if (-not (Test-Path -LiteralPath $publisher)) {
    return
  }

  $endpoint = $env:VOIDBOT_IDUNN_RUDP_HEALTH
  if ([string]::IsNullOrWhiteSpace($endpoint)) {
    Write-BootstrapLog "skipping-idunn-health VOIDBOT_IDUNN_RUDP_HEALTH is not configured"
    return
  }
  $state = if ($Summary.ok) { "healthy" } else { "failed" }
  $detail = "VoidBot orchestrator pulse ran $($Summary.ranCount) organ(s) in $($Summary.durationSeconds)s; ok=$($Summary.ok)"
  try {
    Write-BootstrapLog "publishing-idunn-health state=$state ran=$($Summary.ranCount) duration=$($Summary.durationSeconds)"
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $output = & $nodeExe $publisher `
      --endpoint $endpoint `
      --daemon "voidbot" `
      --contract "voidbot.cultnet-rudp-stack-health" `
      --state $state `
      --detail $detail `
      --observed-at $Summary.finishedAt 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "publisher exited with code $LASTEXITCODE`: $($output -join [Environment]::NewLine)"
    }
    Write-BootstrapLog "published-idunn-health"
  } catch {
    $message = "[$([DateTime]::UtcNow.ToString("o"))] Idunn RUDP health publish failed: $($_.Exception.Message)"
    Add-Content -LiteralPath (Join-Path $logDir "idunn-rudp-health.log") -Encoding UTF8 -Value $message
    Write-BootstrapLog "publish-idunn-health-failed $($_.Exception.Message)"
  }
}

function Get-ConfigString {
  param(
    [hashtable] $Config,
    [string] $Name,
    [string] $Default
  )
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw) -and $Config.ContainsKey($Name)) {
    $raw = $Config[$Name]
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $Default
  }
  return $raw.Trim()
}

function Find-VoidBotSwarmCultMeshProcess {
  param([string] $ScriptPath)
  $escaped = $ScriptPath.Replace("\", "\\")
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -and
    ($_.CommandLine -like "*serve-voidbot-swarm-cultmesh.cjs*" -or $_.CommandLine -like "*$escaped*")
  })
}

function Ensure-VoidBotSwarmCultMeshServer {
  param(
    [hashtable] $Config,
    [string] $NodePath
  )

  $scriptPath = Join-Path $PSScriptRoot "serve-voidbot-swarm-cultmesh.cjs"
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "VoidBot swarm CultMesh server script is missing at $scriptPath."
  }

  $storePath = Get-ConfigString -Config $Config -Name "VOIDBOT_SWARM_CULTMESH_STORE" -Default (Join-Path $statusDir "cultmesh\voidbot-swarm-state.cc")
  $storePath = [System.IO.Path]::GetFullPath($storePath)
  if (-not (Test-Path -LiteralPath $storePath)) {
    throw "VoidBot swarm CultMesh store is missing at $storePath."
  }

  $bind = Get-ConfigString -Config $Config -Name "VOIDBOT_SWARM_CULTMESH_BIND" -Default "127.0.0.1:17873"
  $odinCultMeshUri = Get-ConfigString -Config $Config -Name "VOIDBOT_ODIN_CULTMESH_URI" -Default (
    Get-ConfigString -Config $Config -Name "ODIN_CULTMESH_URI" -Default "cultmesh://odin/rendezvous/provider-catalog"
  )
  $odinRudpEndpoint = Get-ConfigString -Config $Config -Name "VOIDBOT_ODIN_RUDP" -Default (
    Get-ConfigString -Config $Config -Name "CULTMESH_URI_ODIN_RUDP" -Default "rudp://127.0.0.1:17871"
  )

  $existing = @(Find-VoidBotSwarmCultMeshProcess -ScriptPath $scriptPath)
  if ($existing.Count -gt 0) {
    return [pscustomobject]@{
      status = "already_running"
      pid = [int]$existing[0].ProcessId
      bind = $bind
      storePath = $storePath
      odinCultMeshUri = $odinCultMeshUri
      odinRudpEndpoint = $odinRudpEndpoint
    }
  }

  $stdoutPath = Join-Path $logDir "voidbot-swarm-cultmesh.stdout.log"
  $stderrPath = Join-Path $logDir "voidbot-swarm-cultmesh.stderr.log"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $arguments = @(
    $scriptPath,
    "--store", $storePath,
    "--bind", $bind,
    "--odin-cultmesh-uri", $odinCultMeshUri,
    "--odin-rudp-endpoint", $odinRudpEndpoint
  )
  $process = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $repoRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  $process.Refresh()
  if ($process.HasExited) {
    $stdoutTail = if (Test-Path -LiteralPath $stdoutPath) { (Get-Content -LiteralPath $stdoutPath -Tail 40) -join "`n" } else { "" }
    $stderrTail = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Tail 40) -join "`n" } else { "" }
    throw "VoidBot swarm CultMesh server exited early.`nSTDOUT:`n$stdoutTail`nSTDERR:`n$stderrTail"
  }

  return [pscustomobject]@{
    status = "started"
    pid = $process.Id
    bind = $bind
    storePath = $storePath
    odinCultMeshUri = $odinCultMeshUri
    odinRudpEndpoint = $odinRudpEndpoint
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
  }
}

function Get-OrganState {
  param($State, [string] $Id)
  $property = $State.organs.PSObject.Properties[$Id]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Set-OrganState {
  param($State, [string] $Id, $Value)
  $State.organs | Add-Member -NotePropertyName $Id -NotePropertyValue $Value -Force
}

function Set-SkippedOrganState {
  param($State, $Organ, [datetime] $Now, [string] $Status, $LogPath = $null)
  Set-OrganState -State $State -Id $Organ.Id -Value ([pscustomobject]@{
    label = $Organ.Label
    intervalMinutes = $Organ.IntervalMinutes
    lastStartedAt = $Now.ToString("o")
    lastFinishedAt = $Now.ToString("o")
    lastExitCode = 0
    lastStatus = $Status
    lastLogPath = $LogPath
  })
}

function Test-Due {
  param($State, [string] $Id, [int] $IntervalMinutes, [datetime] $Now)
  if ($Force) {
    return $true
  }
  $organState = Get-OrganState -State $State -Id $Id
  if ($null -eq $organState -or [string]::IsNullOrWhiteSpace($organState.lastStartedAt)) {
    return $true
  }
  $lastStartedAt = [datetime]::Parse($organState.lastStartedAt).ToUniversalTime()
  return ($Now - $lastStartedAt).TotalMinutes -ge $IntervalMinutes
}

function Invoke-Organ {
  param($Organ, [datetime] $Now)
  $runId = $Now.ToString("yyyyMMdd-HHmmss") + "-" + $Organ.Id
  $logPath = Join-Path $logDir "$runId.log"
  $stdoutPath = Join-Path $logDir "$runId.stdout.log"
  $stderrPath = Join-Path $logDir "$runId.stderr.log"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $startedAt = [DateTime]::UtcNow
  Write-BootstrapLog "invoke-organ start id=$($Organ.Id) executable=$($Organ.Executable)"
  $exitCode = 0
  $timedOut = $false
  try {
    Push-Location -LiteralPath $Organ.Cwd
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Organ.Executable
    $startInfo.Arguments = Join-WindowsArguments -Arguments $Organ.Arguments
    $startInfo.WorkingDirectory = $Organ.Cwd
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    $timeoutSeconds = [Math]::Max(60, $Organ.TimeoutMinutes * 60)
    if (-not $process.WaitForExit($timeoutSeconds * 1000)) {
      $timedOut = $true
      cmd /c "taskkill /PID $($process.Id) /T /F" | Out-Null
      $process.WaitForExit()
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [System.IO.File]::WriteAllText($stdoutPath, $stdout, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($stderrPath, $stderr, [System.Text.UTF8Encoding]::new($false))
    $exitCode = if ($timedOut) { 124 } elseif ($null -eq $process.ExitCode) { 0 } else { $process.ExitCode }
  } catch {
    Set-Content -LiteralPath $stderrPath -Encoding UTF8 -Value ($_ | Out-String)
    $exitCode = 1
  } finally {
    Pop-Location
  }
  $finishedAt = [DateTime]::UtcNow
  $stdout = ""
  if (Test-Path -LiteralPath $stdoutPath) {
    $stdout = [string](Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8)
  }
  if ($null -eq $stdout) {
    $stdout = ""
  }
  $stderr = ""
  if (Test-Path -LiteralPath $stderrPath) {
    $stderr = [string](Get-Content -LiteralPath $stderrPath -Raw -Encoding UTF8)
  }
  if ($null -eq $stderr) {
    $stderr = ""
  }
  $combined = @(
    "exitCode=$exitCode"
    "timedOut=$timedOut"
    "stdout:"
    $stdout.Trim()
    "stderr:"
    $stderr.Trim()
  ) -join [Environment]::NewLine
  [System.IO.File]::WriteAllText($logPath, $combined.Trim(), [System.Text.UTF8Encoding]::new($false))
  Write-BootstrapLog "invoke-organ finish id=$($Organ.Id) status=$(if ($timedOut) { 'timed_out' } elseif ($exitCode -eq 0) { 'ok' } else { 'failed' }) exit=$exitCode"

  return [pscustomobject]@{
    id = $Organ.Id
    label = $Organ.Label
    startedAt = $startedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    durationSeconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 2)
    exitCode = $exitCode
    status = if ($timedOut) { "timed_out" } elseif ($exitCode -eq 0) { "ok" } else { "failed" }
    logPath = $logPath
  }
}

function Test-OrchestratorLock {
  if (-not (Test-Path -LiteralPath $lockPath)) {
    return $false
  }
  $lock = Read-JsonFile -Path $lockPath
  if ($null -eq $lock -or [string]::IsNullOrWhiteSpace($lock.startedAt)) {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    return $false
  }
  $startedAt = [datetime]::Parse($lock.startedAt).ToUniversalTime()
  $lockPid = if ($lock.PSObject.Properties["pid"]) { [int]$lock.pid } else { 0 }
  $lockAgeMinutes = (([DateTime]::UtcNow) - $startedAt).TotalMinutes
  if ($lockPid -gt 0) {
    $lockProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $lockPid" -ErrorAction SilentlyContinue
    if ($null -eq $lockProcess) {
      Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
      return $false
    }
    if ($lockAgeMinutes -gt 2) {
      $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        [int]$_.ParentProcessId -eq $lockPid -and $_.Name -ne "conhost.exe"
      })
      if ($children.Count -eq 0) {
        Stop-Process -Id $lockPid -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        return $false
      }
    }
  }
  if ((([DateTime]::UtcNow) - $startedAt).TotalMinutes -gt 45) {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    return $false
  }
  return $true
}

function Acquire-OrchestratorLock {
  $directory = Split-Path -Parent $lockPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null

  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read)
      $payload = @{
        pid = $PID
        startedAt = ([DateTime]::UtcNow).ToString("o")
      } | ConvertTo-Json -Depth 4
      $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($payload)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
      return $stream
    } catch [System.IO.IOException] {
      if (Test-OrchestratorLock) {
        return $null
      }
    }
  }

  return $null
}

function Test-AgentSwarmPaused {
  if (-not (Test-Path -LiteralPath $agentSwarmPausePath)) {
    return $false
  }
  try {
    $pause = Read-JsonFile -Path $agentSwarmPausePath
    if ($null -eq $pause) {
      return $true
    }
    if ($pause.PSObject.Properties["paused"] -and $pause.paused -eq $false) {
      return $false
    }
    return $true
  } catch {
    return $true
  }
}

New-Item -ItemType Directory -Force -Path $statusDir, $logDir | Out-Null
Write-BootstrapLog "script-start only=$($Only -join ',') force=$Force"
$lockHandle = Acquire-OrchestratorLock
if ($null -eq $lockHandle) {
  Write-BootstrapLog "lock-already-active"
  exit 0
}

$startedAt = [DateTime]::UtcNow
Write-BootstrapLog "lock-created path=$lockPath"

try {
  $config = Read-DotEnv -Path (Join-Path $repoRoot ".env")
  $state = Read-JsonFile -Path $statePath
  if ($null -eq $state) {
    $state = [pscustomobject]@{ organs = [pscustomobject]@{} }
  }
  if ($null -eq $state.organs) {
    $state | Add-Member -NotePropertyName organs -NotePropertyValue ([pscustomobject]@{})
  }

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $now = [DateTime]::UtcNow
  $agentSwarmPaused = Test-AgentSwarmPaused
  $agentSwarmOrganIds = @{
    "bifrost-dispatch" = $true
    "void-moderation-heartbeat" = $true
    "void-moderation-rumination" = $true
  }
  $onlySet = @{}
  $onlyValues = @()
  if ($null -ne $Only) {
    $onlyValues = $Only
  }
  foreach ($name in $onlyValues) {
    $onlySet[$name.ToLowerInvariant()] = $true
  }

  $organs = @(
    [pscustomobject]@{
      Id = "bifrost-dispatch"
      Label = "Bifrost agent dispatch"
      IntervalMinutes = 1
      TimeoutMinutes = 5
      Cwd = $bifrostRoot
      Executable = $node
      Arguments = @((Join-Path $bifrostRoot "tools\dispatch-agent-requests.mjs"), "dispatch", "--repo", "*", "--max", "1")
    },
    [pscustomobject]@{
      Id = "voidbot-swarm-surface"
      Label = "VoidBot swarm surface"
      IntervalMinutes = 1
      TimeoutMinutes = 5
      Cwd = $repoRoot
      Executable = $node
      Arguments = @((Join-Path $PSScriptRoot "render-voidbot-swarm-dashboard.mjs"))
    },
    [pscustomobject]@{
      Id = "void-moderation-heartbeat"
      Label = "Void rules moderation heartbeat"
      IntervalMinutes = Get-ConfigInt -Config $config -Name "VOIDBOT_MODERATION_HEARTBEAT_INTERVAL_MINUTES" -Default 1 -Minimum 1
      TimeoutMinutes = Get-ConfigInt -Config $config -Name "VOIDBOT_MODERATION_HEARTBEAT_TIMEOUT_MINUTES" -Default 3 -Minimum 1
      Cwd = $repoRoot
      Executable = $powershell
      Arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "run-void-moderator-rumination.ps1"), "-ModerationHeartbeatOnly")
    },
    [pscustomobject]@{
      Id = "void-moderation-rumination"
      Label = "Void moderation rumination"
      IntervalMinutes = Get-ConfigInt -Config $config -Name "VOIDBOT_MODERATION_INTERVAL_MINUTES" -Default 15 -Minimum 15
      TimeoutMinutes = 20
      Cwd = $repoRoot
      Executable = $powershell
      Arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "run-void-moderator-rumination.ps1"))
    },
    [pscustomobject]@{
      Id = "voidbot-operations-watchdog"
      Label = "VoidBot operations watchdog"
      IntervalMinutes = Get-ConfigInt -Config $config -Name "VOIDBOT_HEALTHCHECK_INTERVAL_MINUTES" -Default 60 -Minimum 15
      TimeoutMinutes = 5
      Cwd = $repoRoot
      Executable = $powershell
      Arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "check-voidbot-operations.ps1"), "-NotifyOwner", "-FailOnIssues")
    }
  )

  $runs = @()
  foreach ($organ in $organs) {
    if ($onlySet.Count -gt 0 -and -not $onlySet.ContainsKey($organ.Id.ToLowerInvariant())) {
      continue
    }
    if ($organ.Id -eq "bifrost-dispatch" -and -not (Get-ConfigBool -Config $config -Name "BIFROST_DISPATCH_ENABLED" -Default $false)) {
      Set-SkippedOrganState -State $state -Organ $organ -Now $now -Status "skipped_disabled"
      Write-JsonFile -Path $statePath -Data $state
      continue
    }
    if ($organ.Id -eq "void-moderation-heartbeat" -and -not (Get-ConfigBool -Config $config -Name "VOIDBOT_MODERATION_HEARTBEAT_ENABLED" -Default $true)) {
      Set-SkippedOrganState -State $state -Organ $organ -Now $now -Status "skipped_disabled"
      Write-JsonFile -Path $statePath -Data $state
      continue
    }
    if ($organ.Id -eq "void-moderation-rumination" -and -not (Get-ConfigBool -Config $config -Name "VOIDBOT_MODERATION_RUMINATION_ENABLED" -Default $true)) {
      Set-SkippedOrganState -State $state -Organ $organ -Now $now -Status "skipped_disabled"
      Write-JsonFile -Path $statePath -Data $state
      continue
    }
    if ($organ.Id -eq "voidbot-operations-watchdog" -and -not (Get-ConfigBool -Config $config -Name "VOIDBOT_OPERATIONS_WATCHDOG_ENABLED" -Default $true)) {
      Set-SkippedOrganState -State $state -Organ $organ -Now $now -Status "skipped_disabled"
      Write-JsonFile -Path $statePath -Data $state
      continue
    }
    if (-not (Test-Due -State $state -Id $organ.Id -IntervalMinutes $organ.IntervalMinutes -Now $now)) {
      continue
    }

    if ($agentSwarmPaused -and $agentSwarmOrganIds.ContainsKey($organ.Id)) {
      Set-SkippedOrganState -State $state -Organ $organ -Now $now -Status "skipped_agent_swarm_paused" -LogPath $agentSwarmPausePath
      Write-JsonFile -Path $statePath -Data $state
      continue
    }

    $result = Invoke-Organ -Organ $organ -Now $now
    $serverState = $null
    $runs += $result
    $organState = [pscustomobject]@{
      label = $organ.Label
      intervalMinutes = $organ.IntervalMinutes
      lastStartedAt = $result.startedAt
      lastFinishedAt = $result.finishedAt
      lastExitCode = $result.exitCode
      lastStatus = $result.status
      lastLogPath = $result.logPath
    }
    if ($null -ne $serverState) {
      $organState | Add-Member -NotePropertyName cultMeshServer -NotePropertyValue $serverState -Force
    }
    Set-OrganState -State $state -Id $organ.Id -Value $organState
    Write-JsonFile -Path $statePath -Data $state
  }

  $finishedAt = [DateTime]::UtcNow
  $failedRuns = @($runs | Where-Object { $_.exitCode -ne 0 })
  $summary = [pscustomobject]@{
    ok = $failedRuns.Count -eq 0
    startedAt = $startedAt.ToString("o")
    finishedAt = $finishedAt.ToString("o")
    durationSeconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 2)
    ranCount = $runs.Count
    runs = $runs
    statePath = $statePath
  }
  Write-JsonFile -Path (Join-Path $statusDir "gamecult-orchestrator-last-run.json") -Data $summary
  Write-JsonFile -Path $statePath -Data $state
  Write-BootstrapLog "summary-written ok=$($summary.ok) ran=$($summary.ranCount)"
  Publish-IdunnRudpHealth -Summary $summary

  if (-not $summary.ok) {
    Write-BootstrapLog "script-exit-failed"
    exit 1
  }
  Write-BootstrapLog "script-exit-ok"
} finally {
  if ($null -ne $lockHandle) {
    $lockHandle.Dispose()
  }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  Write-BootstrapLog "lock-removed"
}
