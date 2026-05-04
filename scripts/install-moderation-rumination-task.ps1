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
$runnerScript = Join-Path $PSScriptRoot "run-void-moderator-rumination.ps1"
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
} elseif ($config.ContainsKey("VOIDBOT_MODERATION_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_MODERATION_TASK_NAME"])) {
  $config["VOIDBOT_MODERATION_TASK_NAME"]
} else {
  "Void Moderator Rumination"
}
$intervalMinutesValue = if ($PSBoundParameters.ContainsKey("IntervalMinutes")) {
  $IntervalMinutes
} elseif ($config.ContainsKey("VOIDBOT_MODERATION_INTERVAL_MINUTES") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_MODERATION_INTERVAL_MINUTES"])) {
  [int]$config["VOIDBOT_MODERATION_INTERVAL_MINUTES"]
} else {
  15
}

if ($intervalMinutesValue -lt 15) {
  throw "VOIDBOT_MODERATION_INTERVAL_MINUTES must be at least 15."
}

$startAt = (Get-Date).AddMinutes(2)
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //nologo `"$hiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerScript`""
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutesValue) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Runs Void's scheduled moderation-participation loop from the VoidBot workspace every $intervalMinutesValue minutes with real Codex tooling and local bot-voice output."

Register-ScheduledTask -TaskName $taskNameValue -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $taskNameValue"
Write-Host "Schedule: every $intervalMinutesValue minute(s), starting at $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Task runs as: $($env:USERDOMAIN)\$($env:USERNAME)"
Write-Host "Logon mode: Interactive"
Write-Host "Launcher: wscript.exe hidden PowerShell shim"
Write-Host "Execution time limit: 14 minutes"
Write-Host "Runner script: $runnerScript"

if ($RunNow) {
  Start-ScheduledTask -TaskName $taskNameValue
  Write-Host "Started task immediately."
}
