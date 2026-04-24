param(
  [string] $TaskName,
  [string] $TaskTime,
  [switch] $RunNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$syncScript = Join-Path $PSScriptRoot "sync-voidbot-backup-offsite.ps1"

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
} elseif ($config.ContainsKey("OFFSITE_BACKUP_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_TASK_NAME"])) {
  $config["OFFSITE_BACKUP_TASK_NAME"]
} else {
  "VoidBot Offsite Backup"
}
$taskTimeValue = if (-not [string]::IsNullOrWhiteSpace($TaskTime)) {
  $TaskTime
} elseif ($config.ContainsKey("OFFSITE_BACKUP_TASK_TIME") -and -not [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_TASK_TIME"])) {
  $config["OFFSITE_BACKUP_TASK_TIME"]
} else {
  "04:30"
}

if (-not ($config.ContainsKey("OFFSITE_BACKUP_SSH_TARGET")) -or [string]::IsNullOrWhiteSpace($config["OFFSITE_BACKUP_SSH_TARGET"])) {
  throw "OFFSITE_BACKUP_SSH_TARGET must be configured in .env before installing the scheduled task."
}

$runAt = [DateTime]::ParseExact($taskTimeValue, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$syncScript`""
$trigger = New-ScheduledTaskTrigger -Daily -At $runAt
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Runs VoidBot offsite backup sync to the Qwen box. Interactive logon required so the SSH key material is available."

Register-ScheduledTask -TaskName $taskNameValue -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $taskNameValue"
Write-Host "Schedule: daily at $taskTimeValue"
Write-Host "Task runs as: $($env:USERDOMAIN)\$($env:USERNAME)"
Write-Host "Logon mode: Interactive"

if ($RunNow) {
  Start-ScheduledTask -TaskName $taskNameValue
  Write-Host "Started task immediately."
}
