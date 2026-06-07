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
$checkScript = Join-Path $PSScriptRoot "check-voidbot-operations.ps1"
$hiddenLauncher = Join-Path $PSScriptRoot "run-hidden-powershell.vbs"

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

$config = Read-DotEnv -Path $envFile
$taskNameValue = if (-not [string]::IsNullOrWhiteSpace($TaskName)) {
  $TaskName
} elseif ($config.ContainsKey("VOIDBOT_HEALTHCHECK_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_HEALTHCHECK_TASK_NAME"])) {
  $config["VOIDBOT_HEALTHCHECK_TASK_NAME"]
} else {
  "VoidBot Operations Watchdog"
}
$intervalMinutesValue = if ($PSBoundParameters.ContainsKey("IntervalMinutes")) {
  $IntervalMinutes
} elseif ($config.ContainsKey("VOIDBOT_HEALTHCHECK_INTERVAL_MINUTES") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_HEALTHCHECK_INTERVAL_MINUTES"])) {
  [int]$config["VOIDBOT_HEALTHCHECK_INTERVAL_MINUTES"]
} else {
  60
}

if ($intervalMinutesValue -lt 15) {
  throw "VOIDBOT_HEALTHCHECK_INTERVAL_MINUTES must be at least 15."
}

$startAt = (Get-Date).AddMinutes(5)
# Use WSH as a GUI host so the interactive task can stay hidden without flashing a console.
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //nologo `"$hiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$checkScript`" -FailOnIssues"
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutesValue) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Runs the legacy VoidBot operations probe. Idunn owns watchdog recovery and operator escalation."

Register-ScheduledTask -TaskName $taskNameValue -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $taskNameValue"
Write-Host "Schedule: every $intervalMinutesValue minute(s), starting at $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Task runs as: $($env:USERDOMAIN)\$($env:USERNAME)"
Write-Host "Logon mode: Interactive"
Write-Host "Launcher: wscript.exe hidden PowerShell shim"
Write-Host "Execution time limit: 15 minutes"
Write-Host "Operator escalation: owned by Idunn Local Keepalive, not this legacy probe task"

if ($RunNow) {
  Start-ScheduledTask -TaskName $taskNameValue
  Write-Host "Started task immediately."
}
