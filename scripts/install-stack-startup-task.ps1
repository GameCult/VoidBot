param(
  [string] $TaskName,
  [switch] $RunNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$startScript = Join-Path $PSScriptRoot "start-voidbot-stack.ps1"
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
} elseif ($config.ContainsKey("VOIDBOT_STACK_STARTUP_TASK_NAME") -and -not [string]::IsNullOrWhiteSpace($config["VOIDBOT_STACK_STARTUP_TASK_NAME"])) {
  $config["VOIDBOT_STACK_STARTUP_TASK_NAME"]
} else {
  "VoidBot Stack Startup"
}

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //nologo `"$hiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$action.WorkingDirectory = $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = "PT2M"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Starts the VoidBot stack when this workstation user logs on so bot and worker do not stay dead after a reboot."

Register-ScheduledTask -TaskName $taskNameValue -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $taskNameValue"
Write-Host "Trigger: at logon for $($env:USERDOMAIN)\$($env:USERNAME)"
Write-Host "Task runs as: $($env:USERDOMAIN)\$($env:USERNAME)"
Write-Host "Logon mode: Interactive"
Write-Host "Launcher: wscript.exe hidden PowerShell shim"
Write-Host "Execution time limit: 30 minutes"

if ($RunNow) {
  Start-ScheduledTask -TaskName $taskNameValue
  Write-Host "Started task immediately."
}
