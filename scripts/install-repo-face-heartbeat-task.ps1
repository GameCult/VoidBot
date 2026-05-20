param(
  [string] $TaskName,
  [int] $IntervalMinutes,
  [switch] $RunNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$runnerScript = Join-Path $PSScriptRoot "run-repo-face-heartbeats.ts"
$runnerWrapper = Join-Path $PSScriptRoot "run-repo-face-heartbeats.ps1"
$hiddenLauncher = Join-Path $PSScriptRoot "run-hidden-powershell.vbs"

function Read-DotEnv {
  param([Parameter(Mandatory = $true)][string] $Path)
  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }
  foreach ($line in Get-Content -Path $Path) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) {
      continue
    }
    $separatorIndex = $line.IndexOf("=")
    if ($separatorIndex -lt 1) {
      continue
    }
    $values[$line.Substring(0, $separatorIndex).Trim()] = $line.Substring($separatorIndex + 1)
  }
  return $values
}

$config = Read-DotEnv -Path $envFile
$taskNameValue = if (-not [string]::IsNullOrWhiteSpace($TaskName)) {
  $TaskName
} elseif ($config.ContainsKey("REPO_FACE_HEARTBEAT_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["REPO_FACE_HEARTBEAT_TASK_NAME"])) {
  $config["REPO_FACE_HEARTBEAT_TASK_NAME"]
} else {
  "VoidBot Repo Face Heartbeats"
}
$intervalMinutesValue = if ($PSBoundParameters.ContainsKey("IntervalMinutes")) {
  $IntervalMinutes
} elseif ($config.ContainsKey("REPO_FACE_HEARTBEAT_INTERVAL_MINUTES") -and -not [string]::IsNullOrWhiteSpace($config["REPO_FACE_HEARTBEAT_INTERVAL_MINUTES"])) {
  [int]$config["REPO_FACE_HEARTBEAT_INTERVAL_MINUTES"]
} else {
  15
}

if ($intervalMinutesValue -lt 1) {
  throw "REPO_FACE_HEARTBEAT_INTERVAL_MINUTES must be at least 1."
}

$tsxCliPath = Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path -LiteralPath $tsxCliPath)) {
  throw "Missing tsx CLI at $tsxCliPath. Run npm install first."
}
if (-not (Test-Path -LiteralPath $runnerWrapper)) {
  throw "Missing repo Face heartbeat PowerShell wrapper at $runnerWrapper."
}
if (-not (Test-Path -LiteralPath $hiddenLauncher)) {
  throw "Missing hidden PowerShell launcher at $hiddenLauncher."
}

$startAt = (Get-Date).AddMinutes(3)
$action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "//B //nologo `"$hiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerWrapper`"" `
  -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutesValue) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Runs VoidBot's repo Face initiative scheduler every $intervalMinutesValue minute(s)."

Register-ScheduledTask -TaskName $taskNameValue -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $taskNameValue"
Write-Host "Schedule: every $intervalMinutesValue minute(s), starting at $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Working directory: $repoRoot"
Write-Host "Runner script: $runnerScript"

if ($RunNow) {
  Start-ScheduledTask -TaskName $taskNameValue
  Write-Host "Started task immediately."
}
