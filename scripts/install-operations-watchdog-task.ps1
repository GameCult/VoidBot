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

if (-not ($config.ContainsKey("DISCORD_BOT_TOKEN")) -or [string]::IsNullOrWhiteSpace($config["DISCORD_BOT_TOKEN"])) {
  throw "DISCORD_BOT_TOKEN must be configured in .env before installing the watchdog task."
}

if (-not ($config.ContainsKey("DISCORD_OWNER_ID")) -or [string]::IsNullOrWhiteSpace($config["DISCORD_OWNER_ID"])) {
  throw "DISCORD_OWNER_ID must be configured in .env before installing the watchdog task."
}

$startAt = (Get-Date).AddMinutes(5)
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$checkScript`" -NotifyOwner -FailOnIssues"
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutesValue) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Runs the VoidBot operations watchdog on a repeating interval and DMs the owner when the stack or backup path drifts into the swamp."

Register-ScheduledTask -TaskName $taskNameValue -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $taskNameValue"
Write-Host "Schedule: every $intervalMinutesValue minute(s), starting at $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Task runs as: $($env:USERDOMAIN)\$($env:USERNAME)"
Write-Host "Logon mode: Interactive"

if ($RunNow) {
  Start-ScheduledTask -TaskName $taskNameValue
  Write-Host "Started task immediately."
}
