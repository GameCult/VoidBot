function Get-VoidBotDashboardProperty {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    $InputObject,
    [Parameter(Mandatory = $true)]
    [string] $PropertyName
  )

  if ($null -eq $InputObject) {
    return $null
  }

  $property = $InputObject.PSObject.Properties[$PropertyName]

  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function Read-VoidBotDashboardJson {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return [PSCustomObject]@{
      _path = $Path
      _missing = $true
    }
  }

  try {
    $content = Get-Content -LiteralPath $Path -Raw

    if ([string]::IsNullOrWhiteSpace($content)) {
      return [PSCustomObject]@{
        _path = $Path
        _missing = $true
      }
    }

    $parsed = $content | ConvertFrom-Json
    Add-Member -InputObject $parsed -NotePropertyName "_path" -NotePropertyValue $Path -Force
    return $parsed
  } catch {
    return [PSCustomObject]@{
      _path = $Path
      _error = $_.Exception.Message
    }
  }
}

function ConvertTo-VoidBotDashboardText {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    $Value
  )

  if ($null -eq $Value) {
    return "missing"
  }

  if ($Value -is [bool]) {
    return $(if ($Value) { "yes" } else { "no" })
  }

  if ($Value -is [DateTime]) {
    return $Value.ToString("yyyy-MM-dd HH:mm:ss")
  }

  if ($Value -is [DateTimeOffset]) {
    return $Value.ToString("yyyy-MM-dd HH:mm:ss zzz")
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $items = @($Value)
    if ($items.Count -eq 0) {
      return "none"
    }

    if ($items | Where-Object { $_ -is [string] -or $_ -is [ValueType] }) {
      return ($items | ForEach-Object { [string]$_ }) -join ", "
    }

    return ($Value | ConvertTo-Json -Depth 6 -Compress)
  }

  return [string]$Value
}

function Escape-VoidBotDashboardHtml {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    $Value
  )

  return [System.Net.WebUtility]::HtmlEncode((ConvertTo-VoidBotDashboardText -Value $Value))
}

function ConvertTo-VoidBotDashboardFileUri {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  return ([System.Uri]::new($Path)).AbsoluteUri
}

function New-VoidBotDashboardFileLink {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $false)]
    [string] $Label
  )

  $text = if ([string]::IsNullOrWhiteSpace($Label)) { $Path } else { $Label }
  return "<a class='file-link' href='" + (Escape-VoidBotDashboardHtml (ConvertTo-VoidBotDashboardFileUri -Path $Path)) + "'>" + (Escape-VoidBotDashboardHtml $text) + "</a>"
}

function Get-VoidBotDashboardTone {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [string] $State
  )

  if ([string]::IsNullOrWhiteSpace($State)) {
    return "neutral"
  }

  switch ($State.ToLowerInvariant()) {
    "healthy" { return "good" }
    "passed" { return "good" }
    "completed" { return "good" }
    "ready" { return "good" }
    "enabled" { return "good" }
    "ok" { return "good" }
    "warning" { return "warn" }
    "running" { return "info" }
    "starting" { return "info" }
    "compressing" { return "info" }
    "uploading" { return "info" }
    "pruning" { return "info" }
    "bootstrapping" { return "info" }
    "build" { return "info" }
    "bot_start" { return "info" }
    "worker_start" { return "info" }
    "already_running" { return "warn" }
    "failed" { return "bad" }
    "error" { return "bad" }
    "disabled" { return "bad" }
    "stalled" { return "bad" }
    "missing" { return "bad" }
    default { return "neutral" }
  }
}

function New-VoidBotDashboardBadge {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [string] $State,
    [Parameter(Mandatory = $false)]
    [string] $Label
  )

  $text = if ([string]::IsNullOrWhiteSpace($Label)) {
    if ([string]::IsNullOrWhiteSpace($State)) { "unknown" } else { $State }
  } else {
    $Label
  }
  $tone = Get-VoidBotDashboardTone -State $State
  return "<span class='badge badge-" + $tone + "'>" + (Escape-VoidBotDashboardHtml $text) + "</span>"
}

function Get-VoidBotDashboardRelativeTime {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [string] $Timestamp
  )

  if ([string]::IsNullOrWhiteSpace($Timestamp)) {
    return "unknown"
  }

  try {
    $target = [DateTimeOffset]::Parse($Timestamp)
    $delta = [DateTimeOffset]::Now - $target

    if ($delta.TotalSeconds -lt 60) {
      return "{0}s ago" -f [Math]::Max([int][Math]::Round($delta.TotalSeconds), 0)
    }

    if ($delta.TotalMinutes -lt 60) {
      return "{0}m ago" -f [int][Math]::Round($delta.TotalMinutes)
    }

    if ($delta.TotalHours -lt 48) {
      return "{0}h ago" -f [int][Math]::Round($delta.TotalHours)
    }

    return "{0}d ago" -f [int][Math]::Round($delta.TotalDays)
  } catch {
    return "unknown"
  }
}

function Get-VoidBotDashboardElapsedTime {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [string] $StartedAt
  )

  if ([string]::IsNullOrWhiteSpace($StartedAt)) {
    return "unknown"
  }

  try {
    $delta = [DateTimeOffset]::Now - [DateTimeOffset]::Parse($StartedAt)

    if ($delta.TotalMinutes -lt 1) {
      return "{0}s" -f [Math]::Max([int][Math]::Round($delta.TotalSeconds), 0)
    }

    if ($delta.TotalHours -lt 1) {
      return "{0}m" -f [int][Math]::Round($delta.TotalMinutes)
    }

    return "{0}h {1}m" -f [int][Math]::Floor($delta.TotalHours), $delta.Minutes
  } catch {
    return "unknown"
  }
}

function New-VoidBotDashboardFactRow {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Label,
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string] $ValueHtml
  )

  return "<tr><th>" + (Escape-VoidBotDashboardHtml $Label) + "</th><td>" + $ValueHtml + "</td></tr>"
}

function New-VoidBotDashboardFactSection {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Title,
    [Parameter(Mandatory = $true)]
    [string[]] $Rows
  )

  $body = if ($Rows.Count -gt 0) {
    ($Rows -join [Environment]::NewLine)
  } else {
    "<tr><td colspan='2'><span class='muted'>Nothing here yet.</span></td></tr>"
  }

  return @"
<section class='panel'>
  <h2>$(Escape-VoidBotDashboardHtml $Title)</h2>
  <table class='facts'>
    <tbody>
$body
    </tbody>
  </table>
</section>
"@
}

function New-VoidBotDashboardCard {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Title,
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [string] $State,
    [Parameter(Mandatory = $true)]
    [string] $Subtitle,
    [Parameter(Mandatory = $false)]
    [string] $Meta = ""
  )

  $metaHtml = if ([string]::IsNullOrWhiteSpace($Meta)) {
    ""
  } else {
    "<div class='card-meta'>" + (Escape-VoidBotDashboardHtml $Meta) + "</div>"
  }

  return @"
<article class='card'>
  <div class='card-head'>
    <h2>$(Escape-VoidBotDashboardHtml $Title)</h2>
    $(New-VoidBotDashboardBadge -State $State)
  </div>
  <p class='card-subtitle'>$(Escape-VoidBotDashboardHtml $Subtitle)</p>
  $metaHtml
</article>
"@
}

function Update-VoidBotOperationsDashboard {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,
    [Parameter(Mandatory = $true)]
    [string] $StorageRoot
  )

  $statusDir = Join-Path $StorageRoot "status"
  $logsDir = Join-Path $StorageRoot "logs"
  $dashboardPath = Join-Path $statusDir "operations-dashboard.html"
  $snapshotPath = Join-Path $statusDir "operations-dashboard.json"
  New-Item -ItemType Directory -Force -Path $statusDir | Out-Null

  $runtimePath = Join-Path $statusDir "runtime-stack.json"
  $operationsPath = Join-Path $statusDir "operations-health.json"
  $watchdogPath = Join-Path $statusDir "operations-watchdog.json"
  $offsitePath = Join-Path $statusDir "offsite-backup.json"

  $runtime = Read-VoidBotDashboardJson -Path $runtimePath
  $operations = Read-VoidBotDashboardJson -Path $operationsPath
  $watchdog = Read-VoidBotDashboardJson -Path $watchdogPath
  $offsite = Read-VoidBotDashboardJson -Path $offsitePath

  $operationsState = [string](Get-VoidBotDashboardProperty -InputObject $operations -PropertyName "status")
  if ([string]::IsNullOrWhiteSpace($operationsState)) {
    $operationsState = if (Get-VoidBotDashboardProperty -InputObject $operations -PropertyName "_missing") { "missing" } else { "unknown" }
  }

  $runtimeState = if (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "_missing") {
    "missing"
  } elseif ([bool](Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "ready")) {
    "ready"
  } else {
    $stageValue = [string](Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "stage")
    if ([string]::IsNullOrWhiteSpace($stageValue)) { "starting" } else { $stageValue }
  }

  $watchdogRunStatus = [string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "runStatus")
  $watchdogStartedAt = [string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "startedAt")
  $watchdogStep = [string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "currentStep")
  $watchdogLimitMinutes = Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "executionTimeLimitMinutes"
  $watchdogReportStatus = [string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "reportStatus")
  $watchdogState = if ([string]::IsNullOrWhiteSpace($watchdogRunStatus)) {
    if (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "_missing") { "missing" } else { $operationsState }
  } elseif ($watchdogRunStatus -eq "running" -and -not [string]::IsNullOrWhiteSpace($watchdogStartedAt)) {
    try {
      $elapsedMinutes = ([DateTimeOffset]::Now - [DateTimeOffset]::Parse($watchdogStartedAt)).TotalMinutes
      $limitValue = if ($watchdogLimitMinutes -is [ValueType]) { [double]$watchdogLimitMinutes } else { 15.0 }
      if ($elapsedMinutes -gt $limitValue) { "stalled" } else { "running" }
    } catch {
      "running"
    }
  } elseif ($watchdogRunStatus -eq "completed" -and -not [string]::IsNullOrWhiteSpace($watchdogReportStatus)) {
    $watchdogReportStatus
  } else {
    $watchdogRunStatus
  }

  $offsiteState = [string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "status")
  if ([string]::IsNullOrWhiteSpace($offsiteState)) {
    $offsiteState = if (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "_missing") { "missing" } else { "unknown" }
  }

  $operationsSummary = Get-VoidBotDashboardProperty -InputObject $operations -PropertyName "summary"
  $operationsSubtitle = if ($null -ne $operationsSummary) {
    "{0} failed, {1} warning, {2} passed" -f `
      (Get-VoidBotDashboardProperty -InputObject $operationsSummary -PropertyName "failed"), `
      (Get-VoidBotDashboardProperty -InputObject $operationsSummary -PropertyName "warning"), `
      (Get-VoidBotDashboardProperty -InputObject $operationsSummary -PropertyName "passed")
  } else {
    "No health report yet."
  }

  $watchdogSubtitle = if ($watchdogRunStatus -eq "running") {
    "Current step: {0}" -f $(if ([string]::IsNullOrWhiteSpace($watchdogStep)) { "working" } else { $watchdogStep })
  } elseif ($watchdogState -eq "stalled") {
    "Still marked running after {0}" -f (Get-VoidBotDashboardElapsedTime -StartedAt $watchdogStartedAt)
  } elseif ($watchdogRunStatus -eq "failed") {
    "Watchdog run crashed before finishing."
  } elseif ($watchdogState -eq "healthy") {
    "Watchdog run completed cleanly."
  } elseif ($watchdogState -eq "warning") {
    "Watchdog run finished with warnings."
  } elseif ($watchdogState -eq "failed") {
    "Watchdog run finished with failed checks."
  } else {
    "No active watchdog run."
  }

  $runtimeSubtitle = if ($runtimeState -eq "ready") {
    "Bot and worker reported ready."
  } elseif ($runtimeState -eq "missing") {
    "Runtime stack has not written status yet."
  } else {
    "Current stage: {0}" -f $runtimeState
  }

  $offsiteSubtitle = if ($offsiteState -eq "completed") {
    "Latest offsite sync finished."
  } elseif ($offsiteState -eq "missing") {
    "No offsite sync status yet."
  } else {
    "Current phase: {0}" -f $offsiteState
  }

  $cardsHtml = @(
    New-VoidBotDashboardCard -Title "Operations Health" -State $operationsState -Subtitle $operationsSubtitle -Meta ("Checked " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $operations -PropertyName "checkedAt"))))
    New-VoidBotDashboardCard -Title "Watchdog Run" -State $watchdogState -Subtitle $watchdogSubtitle -Meta ("Started " + (Get-VoidBotDashboardRelativeTime -Timestamp $watchdogStartedAt))
    New-VoidBotDashboardCard -Title "Runtime Stack" -State $runtimeState -Subtitle $runtimeSubtitle -Meta ("Updated " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "completedAt"))))
    New-VoidBotDashboardCard -Title "Offsite Backup" -State $offsiteState -Subtitle $offsiteSubtitle -Meta ("Updated " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "completedAt"))))
  ) -join [Environment]::NewLine

  $runtimeRows = @(
    New-VoidBotDashboardFactRow -Label "Status file" -ValueHtml (New-VoidBotDashboardFileLink -Path $runtimePath)
    New-VoidBotDashboardFactRow -Label "Ready" -ValueHtml (New-VoidBotDashboardBadge -State $runtimeState -Label ([string](Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "ready")))
    New-VoidBotDashboardFactRow -Label "Stage" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "stage")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Bot PID" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "bot") -PropertyName "pid")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Bot log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "bot") -PropertyName "log") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "bot") -PropertyName "log")) } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Worker PID" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "worker") -PropertyName "pid")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Worker log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "worker") -PropertyName "log") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "worker") -PropertyName "log")) } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Completed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "completedAt"))
  )

  $watchdogRows = @(
    New-VoidBotDashboardFactRow -Label "Status file" -ValueHtml (New-VoidBotDashboardFileLink -Path $watchdogPath)
    New-VoidBotDashboardFactRow -Label "Run status" -ValueHtml (New-VoidBotDashboardBadge -State $watchdogState -Label $watchdogState)
    New-VoidBotDashboardFactRow -Label "Current step" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $watchdogStep) + "</span>")
    New-VoidBotDashboardFactRow -Label "Started" -ValueHtml (Escape-VoidBotDashboardHtml $watchdogStartedAt)
    New-VoidBotDashboardFactRow -Label "Elapsed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardElapsedTime -StartedAt $watchdogStartedAt))
    New-VoidBotDashboardFactRow -Label "Completed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "completedAt"))
    New-VoidBotDashboardFactRow -Label "Last report status" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "reportStatus")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "reportStatus")))
    New-VoidBotDashboardFactRow -Label "Notification" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "lastNotificationReason"))
    New-VoidBotDashboardFactRow -Label "Last run error" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "lastRunError"))
    New-VoidBotDashboardFactRow -Label "Watchdog log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "logPath") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "logPath")) } else { "<span class='muted'>missing</span>" })
  )

  $offsiteRows = @(
    New-VoidBotDashboardFactRow -Label "Status file" -ValueHtml (New-VoidBotDashboardFileLink -Path $offsitePath)
    New-VoidBotDashboardFactRow -Label "Status" -ValueHtml (New-VoidBotDashboardBadge -State $offsiteState -Label $offsiteState)
    New-VoidBotDashboardFactRow -Label "Started" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "startedAt"))
    New-VoidBotDashboardFactRow -Label "Completed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "completedAt"))
    New-VoidBotDashboardFactRow -Label "Backup directory" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "backupDirectory"))
    New-VoidBotDashboardFactRow -Label "Archive path" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "archivePath"))
    New-VoidBotDashboardFactRow -Label "Remote file" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "remoteFile") -PropertyName "path"))
    New-VoidBotDashboardFactRow -Label "Error" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "error"))
    New-VoidBotDashboardFactRow -Label "Offsite log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "logPath") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "logPath")) } else { New-VoidBotDashboardFileLink -Path (Join-Path $logsDir "offsite-backup.log") })
  )

  $fileRows = @(
    New-VoidBotDashboardFactRow -Label "Dashboard HTML" -ValueHtml (New-VoidBotDashboardFileLink -Path $dashboardPath)
    New-VoidBotDashboardFactRow -Label "Dashboard snapshot" -ValueHtml (New-VoidBotDashboardFileLink -Path $snapshotPath)
    New-VoidBotDashboardFactRow -Label "Operations report" -ValueHtml (New-VoidBotDashboardFileLink -Path $operationsPath)
    New-VoidBotDashboardFactRow -Label "Operations log" -ValueHtml (New-VoidBotDashboardFileLink -Path (Join-Path $logsDir "operations-watchdog.log"))
    New-VoidBotDashboardFactRow -Label "Repo root" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $RepoRoot) + "</span>")
    New-VoidBotDashboardFactRow -Label "Storage root" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $StorageRoot) + "</span>")
  )

  $checkRows = @()
  foreach ($check in @((Get-VoidBotDashboardProperty -InputObject $operations -PropertyName "checks"))) {
    $checkRows += "<tr><td>" + (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $check -PropertyName "status")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $check -PropertyName "status"))) + "</td><td class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $check -PropertyName "name")) + "</td><td>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $check -PropertyName "detail")) + "</td></tr>"
  }

  if ($checkRows.Count -eq 0) {
    $checkRows = @("<tr><td colspan='3'><span class='muted'>No watchdog checks have been written yet.</span></td></tr>")
  }

  $checksSection = @"
<section class='panel'>
  <h2>Watchdog Checks</h2>
  <table class='checks'>
    <thead>
      <tr><th>Status</th><th>Check</th><th>Detail</th></tr>
    </thead>
    <tbody>
$($checkRows -join [Environment]::NewLine)
    </tbody>
  </table>
</section>
"@

  $snapshot = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    dashboardPath = $dashboardPath
    repoRoot = $RepoRoot
    storageRoot = $StorageRoot
    states = [ordered]@{
      operations = $operationsState
      runtime = $runtimeState
      watchdog = $watchdogState
      offsite = $offsiteState
    }
    files = [ordered]@{
      runtime = $runtimePath
      operations = $operationsPath
      watchdog = $watchdogPath
      offsite = $offsitePath
      operationsLog = Join-Path $logsDir "operations-watchdog.log"
      offsiteLog = Join-Path $logsDir "offsite-backup.log"
    }
  }
  $snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $snapshotPath -Encoding utf8

  $html = @"
<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'>
  <meta http-equiv='refresh' content='10'>
  <title>VoidBot Operations Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe7;
      --paper: rgba(255,255,255,0.88);
      --ink: #1f2430;
      --muted: #5b6472;
      --line: rgba(31,36,48,0.12);
      --good: #1f7a4a;
      --warn: #8f6200;
      --bad: #a6342b;
      --info: #1d5e8a;
      --neutral: #596574;
      --shadow: 0 18px 50px rgba(31,36,48,0.12);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      background:
        radial-gradient(circle at top left, rgba(237, 190, 123, 0.28), transparent 34%),
        radial-gradient(circle at top right, rgba(130, 176, 210, 0.22), transparent 28%),
        linear-gradient(180deg, #f8f4ee 0%, #efe7dc 100%);
      color: var(--ink);
      font: 15px/1.5 "Aptos", "Segoe UI Variable", "Trebuchet MS", sans-serif;
    }

    h1, h2, h3, p { margin: 0; }
    a { color: inherit; }
    .shell {
      max-width: 1400px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }

    .hero, .panel, .card {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }

    .hero {
      padding: 28px;
      display: grid;
      gap: 10px;
    }

    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .hero p {
      color: var(--muted);
      max-width: 80ch;
    }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
    }

    .card {
      padding: 18px;
      display: grid;
      gap: 12px;
    }

    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
    }

    .card-head h2 {
      font-size: 16px;
    }

    .card-subtitle, .card-meta, .muted {
      color: var(--muted);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }

    .panel {
      padding: 20px;
      display: grid;
      gap: 14px;
    }

    .panel h2 {
      font-size: 18px;
    }

    .facts, .checks {
      width: 100%;
      border-collapse: collapse;
    }

    .facts th,
    .facts td,
    .checks th,
    .checks td {
      padding: 10px 12px;
      border-top: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    .facts th,
    .checks th {
      color: var(--muted);
      font-weight: 600;
      width: 180px;
    }

    .checks thead th {
      border-top: none;
    }

    .mono {
      font-family: "Consolas", "Cascadia Mono", monospace;
      font-size: 13px;
      word-break: break-word;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: white;
      white-space: nowrap;
    }

    .badge-good { background: var(--good); }
    .badge-warn { background: var(--warn); }
    .badge-bad { background: var(--bad); }
    .badge-info { background: var(--info); }
    .badge-neutral { background: var(--neutral); }

    .file-link {
      text-decoration: none;
      border-bottom: 1px dashed rgba(29, 94, 138, 0.4);
    }

    @media (max-width: 720px) {
      body { padding: 16px; }
      .hero, .panel, .card { border-radius: 16px; }
      .facts th, .checks th { width: 120px; }
    }
  </style>
</head>
<body>
  <main class='shell'>
    <section class='hero'>
      <div class='eyebrow'>VoidBot Operations Dashboard</div>
      <h1>Status files, but with fewer lies.</h1>
      <p>This page is regenerated from the live JSON status files under <span class='mono'>$(Escape-VoidBotDashboardHtml $statusDir)</span> and refreshes itself every 10 seconds. If a hidden task hangs, it should stay frozen here with the last step it managed to confess.</p>
      <div class='muted'>Generated $(Escape-VoidBotDashboardHtml (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"))</div>
    </section>

    <section class='cards'>
$cardsHtml
    </section>

    <section class='grid'>
$(New-VoidBotDashboardFactSection -Title "Runtime Stack" -Rows $runtimeRows)
$(New-VoidBotDashboardFactSection -Title "Watchdog Run" -Rows $watchdogRows)
$(New-VoidBotDashboardFactSection -Title "Offsite Backup" -Rows $offsiteRows)
$(New-VoidBotDashboardFactSection -Title "Useful Files" -Rows $fileRows)
    </section>

$checksSection
  </main>
</body>
</html>
"@

  Set-Content -LiteralPath $dashboardPath -Value $html -Encoding utf8

  return [PSCustomObject]@{
    DashboardPath = $dashboardPath
    SnapshotPath = $snapshotPath
  }
}
