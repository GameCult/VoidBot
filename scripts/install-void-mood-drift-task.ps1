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
$runnerScript = Join-Path $PSScriptRoot "run-void-mood-drift.ps1"
$hiddenLauncher = Join-Path $PSScriptRoot "run-hidden-powershell.vbs"

function Read-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $values = @{}

  if (-not (Test-Path $Path)) {
    return $values
  }

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
} elseif ($config.ContainsKey("VOIDBOT_MOOD_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_MOOD_TASK_NAME"])) {
  $config["VOIDBOT_MOOD_TASK_NAME"]
} else {
  "Void Mood Drift"
}
$intervalMinutesValue = if ($PSBoundParameters.ContainsKey("IntervalMinutes")) {
  $IntervalMinutes
} elseif ($config.ContainsKey("VOIDBOT_MOOD_INTERVAL_MINUTES") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_MOOD_INTERVAL_MINUTES"])) {
  [int]$config["VOIDBOT_MOOD_INTERVAL_MINUTES"]
} else {
  5
}

if ($intervalMinutesValue -lt 5) {
  throw "VOIDBOT_MOOD_INTERVAL_MINUTES must be at least 5."
}

$startAt = (Get-Date).AddMinutes(1)
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //nologo `"$hiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerScript`""
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutesValue) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Runs Void's background mood-drift pass every $intervalMinutesValue minutes so current activations and speaking pressure do not stay emotionally flat between moderation loops."

Register-ScheduledTask -TaskName $taskNameValue -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $taskNameValue"
Write-Host "Schedule: every $intervalMinutesValue minute(s), starting at $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Task runs as: $($env:USERDOMAIN)\$($env:USERNAME)"
Write-Host "Execution time limit: 3 minutes"
Write-Host "Runner script: $runnerScript"

if ($RunNow) {
  Start-ScheduledTask -TaskName $taskNameValue
  Write-Host "Started task immediately."
}
