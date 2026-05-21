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

    $timeoutSeconds = [Math]::Max(60, $Organ.TimeoutMinutes * 60)
    if (-not $process.WaitForExit($timeoutSeconds * 1000)) {
      $timedOut = $true
      cmd /c "taskkill /PID $($process.Id) /T /F" | Out-Null
      $process.WaitForExit()
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
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
  if ((([DateTime]::UtcNow) - $startedAt).TotalMinutes -gt 45) {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    return $false
  }
  return $true
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
if (Test-OrchestratorLock) {
  exit 0
}

$startedAt = [DateTime]::UtcNow
Write-JsonFile -Path $lockPath -Data @{ pid = $PID; startedAt = $startedAt.ToString("o") }

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
    "repo-face-heartbeats" = $true
    "void-mood-drift" = $true
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
      Id = "repo-face-heartbeats"
      Label = "Repo Face CTB heartbeat"
      IntervalMinutes = Get-ConfigInt -Config $config -Name "REPO_FACE_HEARTBEAT_INTERVAL_MINUTES" -Default 1 -Minimum 1
      TimeoutMinutes = 20
      Cwd = $repoRoot
      Executable = $powershell
      Arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "run-repo-face-heartbeats.ps1"))
    },
    [pscustomobject]@{
      Id = "void-mood-drift"
      Label = "Void mood drift"
      IntervalMinutes = Get-ConfigInt -Config $config -Name "VOIDBOT_MOOD_INTERVAL_MINUTES" -Default 5 -Minimum 5
      TimeoutMinutes = 10
      Cwd = $repoRoot
      Executable = $powershell
      Arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "run-void-mood-drift.ps1"))
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
    if (-not (Test-Due -State $state -Id $organ.Id -IntervalMinutes $organ.IntervalMinutes -Now $now)) {
      continue
    }

    if ($agentSwarmPaused -and $agentSwarmOrganIds.ContainsKey($organ.Id)) {
      Set-OrganState -State $state -Id $organ.Id -Value ([pscustomobject]@{
        label = $organ.Label
        intervalMinutes = $organ.IntervalMinutes
        lastStartedAt = $now.ToString("o")
        lastFinishedAt = $now.ToString("o")
        lastExitCode = 0
        lastStatus = "skipped_agent_swarm_paused"
        lastLogPath = $agentSwarmPausePath
      })
      Write-JsonFile -Path $statePath -Data $state
      continue
    }

    $result = Invoke-Organ -Organ $organ -Now $now
    $runs += $result
    Set-OrganState -State $state -Id $organ.Id -Value ([pscustomobject]@{
      label = $organ.Label
      intervalMinutes = $organ.IntervalMinutes
      lastStartedAt = $result.startedAt
      lastFinishedAt = $result.finishedAt
      lastExitCode = $result.exitCode
      lastStatus = $result.status
      lastLogPath = $result.logPath
    })
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

  if (-not $summary.ok) {
    exit 1
  }
} finally {
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
