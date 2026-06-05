param(
  [string] $TaskName = "GameCult Local Orchestrator",
  [int] $IntervalMinutes = 1,
  [switch] $DisableLegacyTasks,
  [switch] $RunNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerScript = Join-Path $PSScriptRoot "run-gamecult-orchestrator.ps1"
$hiddenLauncher = Join-Path $PSScriptRoot "run-hidden-powershell.vbs"

if ($IntervalMinutes -lt 1) {
  throw "IntervalMinutes must be at least 1."
}
if (-not (Test-Path -LiteralPath $runnerScript)) {
  throw "Missing orchestrator script at $runnerScript."
}
if (-not (Test-Path -LiteralPath $hiddenLauncher)) {
  throw "Missing hidden PowerShell launcher at $hiddenLauncher."
}

$startAt = (Get-Date).AddMinutes(1)
$action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "//B //nologo `"$hiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerScript`"" `
  -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$description = "Runs the local GameCult agent pulse scheduler and records per-organ status."

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Write-Host "Schedule: every $IntervalMinutes minute(s), starting at $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Working directory: $repoRoot"
Write-Host "Runner script: $runnerScript"

if ($DisableLegacyTasks) {
  $legacyTasks = @(
    "Bifrost Agent Dispatch",
    "VoidBot Repo Persona Heartbeats",
    "Void Mood Drift",
    "Void Moderator Rumination",
    "VoidBot Operations Watchdog"
  )

  foreach ($legacyTask in $legacyTasks) {
    $task = Get-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue
    if ($null -eq $task) {
      Write-Host "Legacy task not found: $legacyTask"
      continue
    }
    Disable-ScheduledTask -TaskName $legacyTask | Out-Null
    Write-Host "Disabled legacy task: $legacyTask"
  }
}

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started task immediately."
}
