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

function Read-VoidBotDashboardDotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $values = @{}

  if (-not (Test-Path -LiteralPath $Path)) {
    return $values
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
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

function Resolve-VoidBotDashboardConfigPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $RepoRoot,
    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $Value,
    [Parameter(Mandatory = $true)]
    [string] $Fallback
  )

  $raw = if ([string]::IsNullOrWhiteSpace($Value)) { $Fallback } else { $Value }
  return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $raw))
}

function Format-VoidBotDashboardBytes {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [long] $Bytes
  )

  if ($null -eq $Bytes -or $Bytes -lt 0) {
    return "missing"
  }

  $units = @("B", "KB", "MB", "GB", "TB")
  $value = [double]$Bytes
  $unitIndex = 0

  while ($value -ge 1024 -and $unitIndex -lt ($units.Count - 1)) {
    $value /= 1024
    $unitIndex += 1
  }

  $format = if ($unitIndex -eq 0) { "{0:0} {1}" } else { "{0:0.0} {1}" }
  return $format -f $value, $units[$unitIndex]
}

function Get-VoidBotDashboardFileSummary {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return [PSCustomObject]@{
      exists = $false
      path = $Path
      size = $null
      sizeText = "missing"
      updatedAt = $null
      updatedRelative = "missing"
    }
  }

  $item = Get-Item -LiteralPath $Path
  $updatedAt = $item.LastWriteTime.ToString("o")

  return [PSCustomObject]@{
    exists = $true
    path = $Path
    size = $item.Length
    sizeText = Format-VoidBotDashboardBytes -Bytes $item.Length
    updatedAt = $updatedAt
    updatedRelative = Get-VoidBotDashboardRelativeTime -Timestamp $updatedAt
  }
}

function New-VoidBotDashboardListHtml {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [string[]] $Items,
    [Parameter(Mandatory = $false)]
    [string] $EmptyText = "Nothing here yet."
  )

  if ($null -eq $Items -or $Items.Count -eq 0) {
    return "<span class='muted'>$([System.Net.WebUtility]::HtmlEncode($EmptyText))</span>"
  }

  return "<div class='stack-list'>" + (($Items | ForEach-Object { "<div class='stack-item'>$_</div>" }) -join "") + "</div>"
}

function Invoke-VoidBotDashboardJsonRequest {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url,
    [Parameter(Mandatory = $false)]
    [ValidateSet("Get", "Post")]
    [string] $Method = "Get",
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    $Body
  )

  if ($PSBoundParameters.ContainsKey("Body")) {
    $payload = $Body | ConvertTo-Json -Depth 8 -Compress
    return Invoke-RestMethod -Method $Method -Uri $Url -ContentType "application/json" -Body $payload
  }

  return Invoke-RestMethod -Method $Method -Uri $Url
}

function Get-VoidBotDashboardPostgresDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [string] $DatabaseDsn,
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    $Runtime
  )

  $result = [ordered]@{
    state = "missing"
    detail = "Postgres has not checked in yet."
    jobsTotal = $null
    jobsByState = [ordered]@{}
    auditEvents = $null
    interactionMemoryEvents = $null
    providerRuns = $null
    toolInvocations = $null
    latestJobAt = $null
    latestAuditAt = $null
    latestInteractionAt = $null
    latestProviderRunAt = $null
    latestToolInvocationAt = $null
  }

  $runtimePostgres = if ($null -ne $Runtime) { Get-VoidBotDashboardProperty -InputObject $Runtime -PropertyName "postgres" } else { $null }

  if ($null -eq $runtimePostgres) {
    return [PSCustomObject]$result
  }

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    $result.state = "warning"
    $result.detail = "Docker is unavailable, so live Postgres counts are hidden."
    return [PSCustomObject]$result
  }

  $sql = @'
select json_build_object(
  'jobsTotal', (select count(*) from jobs),
  'jobsByState', coalesce((select json_object_agg(state, job_count) from (select state, count(*) as job_count from jobs group by state) s), '{}'::json),
  'auditEvents', (select count(*) from audit_events),
  'interactionMemoryEvents', (select count(*) from interaction_memory_events),
  'providerRuns', (select count(*) from provider_runs),
  'toolInvocations', (select count(*) from tool_invocations),
  'latestJobAt', (select max(updated_at)::text from jobs),
  'latestAuditAt', (select max(event_timestamp)::text from audit_events),
  'latestInteractionAt', (select max(event_timestamp)::text from interaction_memory_events),
  'latestProviderRunAt', (select max(created_at)::text from provider_runs),
  'latestToolInvocationAt', (select max(created_at)::text from tool_invocations)
);
'@

  try {
    $json = & docker exec voidbot-postgres psql -U voidbot -d voidbot -t -A -c $sql 2>$null

    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
      throw "psql returned no data."
    }

    $parsed = $json.Trim() | ConvertFrom-Json
    $result.state = "healthy"
    $result.detail = "Live Postgres counts loaded."
    $result.jobsTotal = $parsed.jobsTotal
    $result.jobsByState = [ordered]@{}

    if ($null -ne $parsed.jobsByState) {
      foreach ($property in $parsed.jobsByState.PSObject.Properties) {
        $result.jobsByState[$property.Name] = $property.Value
      }
    }

    $result.auditEvents = $parsed.auditEvents
    $result.interactionMemoryEvents = $parsed.interactionMemoryEvents
    $result.providerRuns = $parsed.providerRuns
    $result.toolInvocations = $parsed.toolInvocations
    $result.latestJobAt = $parsed.latestJobAt
    $result.latestAuditAt = $parsed.latestAuditAt
    $result.latestInteractionAt = $parsed.latestInteractionAt
    $result.latestProviderRunAt = $parsed.latestProviderRunAt
    $result.latestToolInvocationAt = $parsed.latestToolInvocationAt
  } catch {
    $result.state = "warning"
    $result.detail = "Live Postgres query failed: $($_.Exception.Message)"
  }

  return [PSCustomObject]$result
}

function Get-VoidBotDashboardQdrantDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [string] $QdrantUrl,
    [Parameter(Mandatory = $true)]
    [string] $HistoryCollection,
    [Parameter(Mandatory = $true)]
    [string] $SourceCollection
  )

  $baseUrl = $QdrantUrl.TrimEnd("/")
  $result = [ordered]@{
    state = "missing"
    detail = "Qdrant has not checked in yet."
    history = $null
    source = $null
    topRepos = @()
    topLanguages = @()
  }

  try {
    $historyInfo = Invoke-VoidBotDashboardJsonRequest -Url "$baseUrl/collections/$HistoryCollection"
    $sourceInfo = Invoke-VoidBotDashboardJsonRequest -Url "$baseUrl/collections/$SourceCollection"
    $repoFacet = Invoke-VoidBotDashboardJsonRequest -Method Post -Url "$baseUrl/collections/$SourceCollection/facet" -Body @{
      key = "repoName"
      limit = 8
    }
    $languageFacet = Invoke-VoidBotDashboardJsonRequest -Method Post -Url "$baseUrl/collections/$SourceCollection/facet" -Body @{
      key = "language"
      limit = 6
    }

    $result.state = "healthy"
    $result.detail = "Live Qdrant collection stats loaded."
    $result.history = [PSCustomObject]@{
      name = $HistoryCollection
      pointsCount = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $historyInfo -PropertyName "result") -PropertyName "points_count"
      indexedVectorsCount = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $historyInfo -PropertyName "result") -PropertyName "indexed_vectors_count"
      status = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $historyInfo -PropertyName "result") -PropertyName "status"
      segmentsCount = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $historyInfo -PropertyName "result") -PropertyName "segments_count"
    }
    $result.source = [PSCustomObject]@{
      name = $SourceCollection
      pointsCount = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $sourceInfo -PropertyName "result") -PropertyName "points_count"
      indexedVectorsCount = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $sourceInfo -PropertyName "result") -PropertyName "indexed_vectors_count"
      status = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $sourceInfo -PropertyName "result") -PropertyName "status"
      segmentsCount = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $sourceInfo -PropertyName "result") -PropertyName "segments_count"
    }
    $result.topRepos = @((Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $repoFacet -PropertyName "result") -PropertyName "hits"))
    $result.topLanguages = @((Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $languageFacet -PropertyName "result") -PropertyName "hits"))
  } catch {
    $result.state = "warning"
    $result.detail = "Live Qdrant query failed: $($_.Exception.Message)"
  }

  return [PSCustomObject]$result
}

function Get-VoidBotDashboardSourceHookDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [string] $SourceHookStatusDir
  )

  $result = [ordered]@{
    state = "missing"
    detail = "No source hook statuses yet."
    total = 0
    completed = 0
    running = 0
    failed = 0
    recentHooks = @()
    latestActivityAt = $null
  }

  if (-not (Test-Path -LiteralPath $SourceHookStatusDir)) {
    return [PSCustomObject]$result
  }

  $hookFiles = @(Get-ChildItem -LiteralPath $SourceHookStatusDir -File -Filter "*.json")

  if ($hookFiles.Count -eq 0) {
    return [PSCustomObject]$result
  }

  $hooks = foreach ($file in $hookFiles) {
    $status = Read-VoidBotDashboardJson -Path $file.FullName
    $state = [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "state")
    $activityAt = @(
      [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "completedAt")
      [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "lastSkippedAt")
      [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "startedAt")
      $file.LastWriteTime.ToString("o")
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1

    [PSCustomObject]@{
      repoName = [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "repoName")
      state = if ([string]::IsNullOrWhiteSpace($state)) { "unknown" } else { $state }
      activityAt = $activityAt
      logPath = [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "logPath")
      note = @(
        [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "lastSkipReason")
        [string](Get-VoidBotDashboardProperty -InputObject $status -PropertyName "repoPath")
      ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
    }
  }

  $orderedHooks = $hooks | Sort-Object {
    try {
      [DateTimeOffset]::Parse($_.activityAt)
    } catch {
      [DateTimeOffset]::MinValue
    }
  } -Descending

  $result.state = if (@($orderedHooks | Where-Object { $_.state -eq "failed" }).Count -gt 0) {
    "warning"
  } elseif (@($orderedHooks | Where-Object { $_.state -eq "running" }).Count -gt 0) {
    "running"
  } else {
    "healthy"
  }
  $result.detail = "Source hook statuses loaded."
  $result.total = $orderedHooks.Count
  $result.completed = @($orderedHooks | Where-Object { $_.state -eq "completed" }).Count
  $result.running = @($orderedHooks | Where-Object { $_.state -eq "running" }).Count
  $result.failed = @($orderedHooks | Where-Object { $_.state -eq "failed" }).Count
  $result.recentHooks = @($orderedHooks | Select-Object -First 6)
  $result.latestActivityAt = $orderedHooks[0].activityAt

  return [PSCustomObject]$result
}

function Get-VoidBotDashboardMcpUsageDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ArtifactsRoot
  )

  $result = [ordered]@{
    state = "missing"
    detail = "No Codex trace artifacts yet."
    traceCount = 0
    scannedTraceCount = 0
    totalMcpCalls = 0
    averageDurationMs = $null
    latestTraceAt = $null
    topTools = @()
    recentTraces = @()
  }

  if (-not (Test-Path -LiteralPath $ArtifactsRoot)) {
    return [PSCustomObject]$result
  }

  $traceFiles = @(Get-ChildItem -LiteralPath $ArtifactsRoot -Recurse -File -Filter "codex-turn-*-trace.json" | Sort-Object LastWriteTime -Descending)

  if ($traceFiles.Count -eq 0) {
    return [PSCustomObject]$result
  }

  $recentFiles = @($traceFiles | Select-Object -First 12)
  $toolCounts = @{}
  $recentTraces = @()
  $durations = @()
  $totalMcpCalls = 0

  foreach ($file in $recentFiles) {
    $trace = Read-VoidBotDashboardJson -Path $file.FullName
    $events = @((Get-VoidBotDashboardProperty -InputObject $trace -PropertyName "events"))
    $mcpEvents = @($events | Where-Object { [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "kind") -eq "mcp_tool_completed" })

    foreach ($event in $mcpEvents) {
      $toolName = [string](Get-VoidBotDashboardProperty -InputObject $event -PropertyName "tool")

      if ([string]::IsNullOrWhiteSpace($toolName)) {
        continue
      }

      if (-not $toolCounts.ContainsKey($toolName)) {
        $toolCounts[$toolName] = 0
      }

      $toolCounts[$toolName] += 1
    }

    $durationMs = Get-VoidBotDashboardProperty -InputObject $trace -PropertyName "durationMs"

    if ($durationMs -is [ValueType]) {
      $durations += [double]$durationMs
    }

    $tools = @($mcpEvents | ForEach-Object { [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "tool") } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    $totalMcpCalls += $mcpEvents.Count
    $recentTraces += [PSCustomObject]@{
      traceFile = $file.FullName
      jobId = $file.Directory.Name
      startedAt = [string](Get-VoidBotDashboardProperty -InputObject $trace -PropertyName "startedAt")
      durationMs = $durationMs
      mcpCalls = $mcpEvents.Count
      tools = $tools
    }
  }

  $topTools = $toolCounts.GetEnumerator() |
    Sort-Object Value -Descending |
    Select-Object -First 6 |
    ForEach-Object {
      [PSCustomObject]@{
        name = $_.Key
        count = $_.Value
      }
    }

  $result.state = if ($totalMcpCalls -gt 0) { "healthy" } else { "neutral" }
  $result.detail = "Recent Codex trace usage loaded."
  $result.traceCount = $traceFiles.Count
  $result.scannedTraceCount = $recentFiles.Count
  $result.totalMcpCalls = $totalMcpCalls
  $result.averageDurationMs = if ($durations.Count -gt 0) { [Math]::Round((($durations | Measure-Object -Average).Average), 0) } else { $null }
  $result.latestTraceAt = $recentTraces[0].startedAt
  $result.topTools = @($topTools)
  $result.recentTraces = @($recentTraces)

  return [PSCustomObject]$result
}

function Get-VoidBotDashboardJobDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [string] $DatabaseDsn,
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    $Runtime,
    [Parameter(Mandatory = $true)]
    [string] $ArtifactsRoot
  )

  $result = [ordered]@{
    state = "missing"
    detail = "No job diagnostics yet."
    current = @()
    recent = @()
    counts = [ordered]@{}
  }

  $runtimePostgres = if ($null -ne $Runtime) { Get-VoidBotDashboardProperty -InputObject $Runtime -PropertyName "postgres" } else { $null }

  if ($null -eq $runtimePostgres) {
    return [PSCustomObject]$result
  }

  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    $result.state = "warning"
    $result.detail = "Docker is unavailable, so live job details are hidden."
    return [PSCustomObject]$result
  }

  $sql = @'
select json_build_object(
  'current', coalesce((select json_agg(row_to_json(t)) from (
    select
      id::text,
      state,
      provider_name,
      command_name,
      requester_discord_id,
      created_at::text,
      updated_at::text,
      request_message_id,
      coalesce(job_json->>'summary', '') as summary,
      coalesce(job_json->>'error', '') as error
    from jobs
    where state in ('queued','approved','running','awaiting_approval','awaiting_post_approval')
    order by updated_at desc
    limit 10
  ) t), '[]'::json),
  'recent', coalesce((select json_agg(row_to_json(t)) from (
    select
      id::text,
      state,
      provider_name,
      command_name,
      requester_discord_id,
      created_at::text,
      updated_at::text,
      request_message_id,
      coalesce(job_json->>'summary', '') as summary,
      coalesce(job_json->>'error', '') as error
    from jobs
    order by updated_at desc
    limit 12
  ) t), '[]'::json),
  'counts', coalesce((select json_object_agg(state, job_count) from (
    select state, count(*) as job_count
    from jobs
    group by state
  ) s), '{}'::json)
);
'@

  try {
    $json = & docker exec voidbot-postgres psql -U voidbot -d voidbot -t -A -c $sql 2>$null

    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
      throw "psql returned no data."
    }

    $parsed = $json.Trim() | ConvertFrom-Json

    function Expand-JobRow {
      param(
        [Parameter(Mandatory = $true)]
        $Job
      )

      $jobId = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "id")
      $artifactDir = Join-Path $ArtifactsRoot $jobId
      $traceFile = $null
      $stdoutFile = $null
      $stderrFile = $null
      $debugFile = $null
      $handoffFile = $null
      $requestFile = $null
      $ragTranscriptFile = $null

      if (Test-Path -LiteralPath $artifactDir) {
        $traceFile = @(Get-ChildItem -LiteralPath $artifactDir -File -Filter "codex-turn-*-trace.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }) | Select-Object -First 1
        $stdoutFile = @(Get-ChildItem -LiteralPath $artifactDir -File -Filter "codex-turn-*-stdout.txt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }) | Select-Object -First 1
        $stderrFile = @(Get-ChildItem -LiteralPath $artifactDir -File -Filter "codex-turn-*-stderr.txt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }) | Select-Object -First 1
        $debugFile = @(Get-ChildItem -LiteralPath $artifactDir -File -Filter "codex-turn-*-debug.md" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName }) | Select-Object -First 1
        $handoffFile = if (Test-Path -LiteralPath (Join-Path $artifactDir "handoff.md")) { Join-Path $artifactDir "handoff.md" } else { $null }
        $requestFile = if (Test-Path -LiteralPath (Join-Path $artifactDir "request.json")) { Join-Path $artifactDir "request.json" } else { $null }
        $ragTranscriptFile = if (Test-Path -LiteralPath (Join-Path $artifactDir "rag-tool-transcript.md")) { Join-Path $artifactDir "rag-tool-transcript.md" } else { $null }
      }

      return [PSCustomObject]@{
        id = $jobId
        state = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "state")
        providerName = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "provider_name")
        commandName = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "command_name")
        requesterDiscordId = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "requester_discord_id")
        createdAt = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "created_at")
        updatedAt = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "updated_at")
        requestMessageId = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "request_message_id")
        summary = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "summary")
        error = [string](Get-VoidBotDashboardProperty -InputObject $Job -PropertyName "error")
        artifactDir = $(if (Test-Path -LiteralPath $artifactDir) { $artifactDir } else { $null })
        traceFile = $traceFile
        stdoutFile = $stdoutFile
        stderrFile = $stderrFile
        debugFile = $debugFile
        handoffFile = $handoffFile
        requestFile = $requestFile
        ragTranscriptFile = $ragTranscriptFile
      }
    }

    $result.state = "healthy"
    $result.detail = "Live job history loaded."
    $result.current = @((Get-VoidBotDashboardProperty -InputObject $parsed -PropertyName "current") | ForEach-Object { Expand-JobRow -Job $_ })
    $result.recent = @((Get-VoidBotDashboardProperty -InputObject $parsed -PropertyName "recent") | ForEach-Object { Expand-JobRow -Job $_ })
    $result.counts = [ordered]@{}

    if ($null -ne $parsed.counts) {
      foreach ($property in $parsed.counts.PSObject.Properties) {
        $result.counts[$property.Name] = $property.Value
      }
    }
  } catch {
    $result.state = "warning"
    $result.detail = "Live job query failed: $($_.Exception.Message)"
  }

  return [PSCustomObject]$result
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
  $artifactsRoot = Join-Path $StorageRoot "artifacts"
  $dashboardPath = Join-Path $statusDir "operations-dashboard.html"
  $snapshotPath = Join-Path $statusDir "operations-dashboard.json"
  $sourceHookStatusDir = Join-Path $statusDir "source-hooks"
  New-Item -ItemType Directory -Force -Path $statusDir | Out-Null

  $envPath = Join-Path $RepoRoot ".env"
  $config = Read-VoidBotDashboardDotEnv -Path $envPath

  $databaseDsn = if ($config.ContainsKey("DATABASE_DSN")) { $config["DATABASE_DSN"] } else { "postgres://voidbot:voidbot@localhost:5432/voidbot" }
  $vectorStoreKind = if ($config.ContainsKey("VECTOR_STORE_KIND")) { $config["VECTOR_STORE_KIND"] } else { "qdrant" }
  $stateStorageBackend = if ($config.ContainsKey("STATE_STORAGE_BACKEND")) { $config["STATE_STORAGE_BACKEND"] } else { "postgres" }
  $qdrantUrl = if ($config.ContainsKey("QDRANT_URL")) { $config["QDRANT_URL"] } else { "http://127.0.0.1:6333" }
  $qdrantHistoryCollection = if ($config.ContainsKey("QDRANT_HISTORY_COLLECTION")) { $config["QDRANT_HISTORY_COLLECTION"] } else { "voidbot_discord_history_chunks" }
  $qdrantSourceCollection = if ($config.ContainsKey("QDRANT_SOURCE_COLLECTION")) { $config["QDRANT_SOURCE_COLLECTION"] } else { "voidbot_repository_source_chunks" }
  $historyArchivePath = Resolve-VoidBotDashboardConfigPath -RepoRoot $RepoRoot -Value $config["RAG_ARCHIVE_PATH"] -Fallback ".voidbot/rag/messages.json"
  $sourceArchivePath = Resolve-VoidBotDashboardConfigPath -RepoRoot $RepoRoot -Value $config["RAG_SOURCE_ARCHIVE_PATH"] -Fallback ".voidbot/rag/source-documents.json"
  $importStatePath = Resolve-VoidBotDashboardConfigPath -RepoRoot $RepoRoot -Value $config["RAG_IMPORT_STATE_PATH"] -Fallback ".voidbot/rag/import-state.json"

  $runtimePath = Join-Path $statusDir "runtime-stack.json"
  $operationsPath = Join-Path $statusDir "operations-health.json"
  $watchdogPath = Join-Path $statusDir "operations-watchdog.json"
  $offsitePath = Join-Path $statusDir "offsite-backup.json"

  $runtime = Read-VoidBotDashboardJson -Path $runtimePath
  $operations = Read-VoidBotDashboardJson -Path $operationsPath
  $watchdog = Read-VoidBotDashboardJson -Path $watchdogPath
  $offsite = Read-VoidBotDashboardJson -Path $offsitePath

  $historyArchive = Get-VoidBotDashboardFileSummary -Path $historyArchivePath
  $sourceArchive = Get-VoidBotDashboardFileSummary -Path $sourceArchivePath
  $importState = Get-VoidBotDashboardFileSummary -Path $importStatePath

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

  $postgresDiagnostics = if ($stateStorageBackend -eq "postgres") {
    Get-VoidBotDashboardPostgresDiagnostics -DatabaseDsn $databaseDsn -Runtime $runtime
  } else {
    [PSCustomObject]@{
      state = "neutral"
      detail = "State storage backend is $stateStorageBackend."
      jobsTotal = $null
      jobsByState = [ordered]@{}
      auditEvents = $null
      interactionMemoryEvents = $null
      providerRuns = $null
      toolInvocations = $null
      latestJobAt = $null
      latestAuditAt = $null
      latestInteractionAt = $null
      latestProviderRunAt = $null
      latestToolInvocationAt = $null
    }
  }
  $qdrantDiagnostics = if ($vectorStoreKind -eq "qdrant") {
    Get-VoidBotDashboardQdrantDiagnostics -QdrantUrl $qdrantUrl -HistoryCollection $qdrantHistoryCollection -SourceCollection $qdrantSourceCollection
  } else {
    [PSCustomObject]@{
      state = "neutral"
      detail = "Vector backend is $vectorStoreKind."
      history = $null
      source = $null
      topRepos = @()
      topLanguages = @()
    }
  }
  $sourceHookDiagnostics = Get-VoidBotDashboardSourceHookDiagnostics -SourceHookStatusDir $sourceHookStatusDir
  $mcpDiagnostics = Get-VoidBotDashboardMcpUsageDiagnostics -ArtifactsRoot $artifactsRoot
  $jobDiagnostics = if ($stateStorageBackend -eq "postgres") {
    Get-VoidBotDashboardJobDiagnostics -DatabaseDsn $databaseDsn -Runtime $runtime -ArtifactsRoot $artifactsRoot
  } else {
    [PSCustomObject]@{
      state = "neutral"
      detail = "State storage backend is $stateStorageBackend."
      current = @()
      recent = @()
      counts = [ordered]@{}
    }
  }

  $ingestState = if ($sourceHookDiagnostics.failed -gt 0) {
    "warning"
  } elseif ($sourceHookDiagnostics.running -gt 0) {
    "running"
  } elseif ($historyArchive.exists -or $sourceArchive.exists) {
    "healthy"
  } else {
    "missing"
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

  $runtimeSubtitle = if ($runtimeState -eq "ready") {
    "Bot and worker reported ready."
  } elseif ($runtimeState -eq "missing") {
    "Runtime stack has not written status yet."
  } else {
    "Current stage: {0}" -f $runtimeState
  }

  $stateStorageSubtitle = if ($postgresDiagnostics.jobsTotal -is [ValueType]) {
    "{0} jobs, {1} audit events, {2} memory events" -f `
      $postgresDiagnostics.jobsTotal, `
      (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "auditEvents"), `
      (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "interactionMemoryEvents")
  } else {
    [string](Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "detail")
  }

  $vectorSubtitle = if ($null -ne (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "history") -and $null -ne (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "source")) {
    "{0} history points, {1} source points" -f `
      (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "history") -PropertyName "pointsCount"), `
      (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "source") -PropertyName "pointsCount")
  } else {
    [string](Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "detail")
  }

  $latestHook = @((Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "recentHooks")) | Select-Object -First 1
  $ingestSubtitle = if ($latestHook) {
    "History archive {0}; latest source hook {1} {2}" -f `
      $historyArchive.updatedRelative, `
      ([string](Get-VoidBotDashboardProperty -InputObject $latestHook -PropertyName "repoName")), `
      (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $latestHook -PropertyName "activityAt")))
  } elseif ($historyArchive.exists -or $sourceArchive.exists) {
    "Archives are present. Source hooks have not reported in yet."
  } else {
    "No archive or hook signal yet."
  }

  $mcpSubtitle = if ((Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "traceCount") -gt 0) {
    "{0} MCP calls across {1} recent traces" -f `
      (Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "totalMcpCalls"), `
      (Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "scannedTraceCount")
  } else {
    [string](Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "detail")
  }

  $jobCounts = Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "counts"
  $currentJobs = @((Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "current"))
  $recentJobs = @((Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "recent"))
  $jobSubtitle = if ($recentJobs.Count -gt 0) {
    "{0} active, {1} completed, {2} failed" -f `
      $currentJobs.Count, `
      $(if ($jobCounts.Contains("completed")) { $jobCounts["completed"] } else { 0 }), `
      $(if ($jobCounts.Contains("failed")) { $jobCounts["failed"] } else { 0 })
  } else {
    [string](Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "detail")
  }

  $offsiteSubtitle = if ($offsiteState -eq "completed") {
    "Latest offsite sync finished."
  } elseif ($offsiteState -eq "missing") {
    "No offsite sync status yet."
  } else {
    "Current phase: {0}" -f $offsiteState
  }

  $jobStateItems = @()
  foreach ($entry in (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "jobsByState").GetEnumerator() | Sort-Object Name) {
    $jobStateItems += "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode($entry.Key))</span> <span class='mono'>$([System.Net.WebUtility]::HtmlEncode([string]$entry.Value))</span>"
  }

  $topRepoItems = @((Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "topRepos") | ForEach-Object {
    "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'value')))</span> <span class='mono'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'count')))</span>"
  })
  $topLanguageItems = @((Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "topLanguages") | ForEach-Object {
    "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'value')))</span> <span class='mono'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'count')))</span>"
  })
  $recentHookItems = @((Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "recentHooks") | ForEach-Object {
    $repoName = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "repoName")
    $logPath = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "logPath")
    $repoHtml = if ([string]::IsNullOrWhiteSpace($logPath)) {
      "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode($repoName))</span>"
    } else {
      New-VoidBotDashboardFileLink -Path $logPath -Label $repoName
    }
    $note = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "note")
    $noteHtml = if ([string]::IsNullOrWhiteSpace($note)) {
      ""
    } else {
      "<div class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode($note))</div>"
    }
    $repoHtml + " " + (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "state"))) + " <span class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode((Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'activityAt')))))</span>" + $noteHtml
  })
  $topToolItems = @((Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "topTools") | ForEach-Object {
    "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'name')))</span> <span class='mono'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'count')))</span>"
  })
  $recentTraceItems = @((Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "recentTraces") | ForEach-Object {
    $traceFile = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "traceFile")
    $jobId = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "jobId")
    $traceLink = if ([string]::IsNullOrWhiteSpace($traceFile)) {
      "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode($jobId))</span>"
    } else {
      New-VoidBotDashboardFileLink -Path $traceFile -Label $jobId
    }
    $durationMs = Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "durationMs"
    $durationText = if ($durationMs -is [ValueType]) {
      "{0:N1}s" -f ([double]$durationMs / 1000)
    } else {
      "unknown"
    }
    $toolSummary = @((Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "tools")) -join ", "
    $toolHtml = if ([string]::IsNullOrWhiteSpace($toolSummary)) {
      "<span class='muted-inline'>No MCP calls.</span>"
    } else {
      "<div class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode($toolSummary))</div>"
    }
    $traceLink + " <span class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode((Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'startedAt'))))) / $([System.Net.WebUtility]::HtmlEncode($durationText)) / $([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'mcpCalls'))) calls</span>" + $toolHtml
  })
  $currentJobItems = @($currentJobs | ForEach-Object {
    $jobId = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "id")
    $artifactDir = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "artifactDir")
    $jobLink = if ([string]::IsNullOrWhiteSpace($artifactDir)) {
      "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode($jobId))</span>"
    } else {
      New-VoidBotDashboardFileLink -Path $artifactDir -Label $jobId
    }
    $links = @()

    foreach ($entry in @(
      @{ name = "request"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "requestFile") }
      @{ name = "trace"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "traceFile") }
      @{ name = "stdout"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "stdoutFile") }
      @{ name = "stderr"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "stderrFile") }
      @{ name = "debug"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "debugFile") }
      @{ name = "handoff"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "handoffFile") }
    )) {
      if (-not [string]::IsNullOrWhiteSpace($entry.path)) {
        $links += New-VoidBotDashboardFileLink -Path $entry.path -Label $entry.name
      }
    }

    $linksHtml = if ($links.Count -gt 0) {
      "<div class='muted-inline'>" + ($links -join " · ") + "</div>"
    } else {
      ""
    }

    $summary = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "summary")
    $error = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "error")
    $note = if (-not [string]::IsNullOrWhiteSpace($error)) { $error } elseif (-not [string]::IsNullOrWhiteSpace($summary)) { $summary } else { "" }
    $noteHtml = if ([string]::IsNullOrWhiteSpace($note)) { "" } else { "<div class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode($note))</div>" }

    $jobLink + " " + (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "state"))) + " <span class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'providerName'))) / $([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'commandName'))) / $([System.Net.WebUtility]::HtmlEncode((Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'updatedAt')))))</span>" + $linksHtml + $noteHtml
  })
  $recentJobItems = @($recentJobs | ForEach-Object {
    $jobId = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "id")
    $artifactDir = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "artifactDir")
    $jobLink = if ([string]::IsNullOrWhiteSpace($artifactDir)) {
      "<span class='mono'>$([System.Net.WebUtility]::HtmlEncode($jobId))</span>"
    } else {
      New-VoidBotDashboardFileLink -Path $artifactDir -Label $jobId
    }
    $links = @()

    foreach ($entry in @(
      @{ name = "trace"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "traceFile") }
      @{ name = "stdout"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "stdoutFile") }
      @{ name = "stderr"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "stderrFile") }
      @{ name = "debug"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "debugFile") }
      @{ name = "handoff"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "handoffFile") }
      @{ name = "request"; path = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "requestFile") }
    )) {
      if (-not [string]::IsNullOrWhiteSpace($entry.path)) {
        $links += New-VoidBotDashboardFileLink -Path $entry.path -Label $entry.name
      }
    }

    $linksHtml = if ($links.Count -gt 0) {
      "<div class='muted-inline'>" + ($links -join " · ") + "</div>"
    } else {
      ""
    }

    $summary = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "summary")
    $error = [string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "error")
    $note = if (-not [string]::IsNullOrWhiteSpace($error)) { $error } elseif (-not [string]::IsNullOrWhiteSpace($summary)) { $summary } else { "" }
    $noteHtml = if ([string]::IsNullOrWhiteSpace($note)) { "" } else { "<div class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode($note))</div>" }

    $jobLink + " " + (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName "state"))) + " <span class='muted-inline'>$([System.Net.WebUtility]::HtmlEncode([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'providerName'))) / $([System.Net.WebUtility]::HtmlEncode((Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $_ -PropertyName 'updatedAt')))))</span>" + $linksHtml + $noteHtml
  })

  $cardsHtml = @(
    New-VoidBotDashboardCard -Title "Operations Health" -State $operationsState -Subtitle $operationsSubtitle -Meta ("Checked " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $operations -PropertyName "checkedAt"))))
    New-VoidBotDashboardCard -Title "Runtime Stack" -State $runtimeState -Subtitle $runtimeSubtitle -Meta ("Updated " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "completedAt"))))
    New-VoidBotDashboardCard -Title "State Storage" -State ([string](Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "state")) -Subtitle $stateStorageSubtitle -Meta ("Latest job " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "latestJobAt"))))
    New-VoidBotDashboardCard -Title "Vector Store" -State ([string](Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "state")) -Subtitle $vectorSubtitle -Meta $qdrantUrl
    New-VoidBotDashboardCard -Title "Ingest & Sync" -State $ingestState -Subtitle $ingestSubtitle -Meta ("Source hooks: " + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "total")))
    New-VoidBotDashboardCard -Title "MCP Usage" -State ([string](Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "state")) -Subtitle $mcpSubtitle -Meta ("Latest trace " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "latestTraceAt"))))
    New-VoidBotDashboardCard -Title "Jobs" -State ([string](Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "state")) -Subtitle $jobSubtitle -Meta ("Latest job " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "latestJobAt"))))
    New-VoidBotDashboardCard -Title "Offsite Backup" -State $offsiteState -Subtitle $offsiteSubtitle -Meta ("Updated " + (Get-VoidBotDashboardRelativeTime -Timestamp ([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "completedAt"))))
  ) -join [Environment]::NewLine

  $runtimeRows = @(
    New-VoidBotDashboardFactRow -Label "Status file" -ValueHtml (New-VoidBotDashboardFileLink -Path $runtimePath)
    New-VoidBotDashboardFactRow -Label "Ready" -ValueHtml (New-VoidBotDashboardBadge -State $runtimeState -Label ([string](Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "ready")))
    New-VoidBotDashboardFactRow -Label "Stage" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "stage")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Started" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "startedAt"))
    New-VoidBotDashboardFactRow -Label "Bot PID" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "bot") -PropertyName "pid")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Bot log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "bot") -PropertyName "log") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "bot") -PropertyName "log")) } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Worker PID" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "worker") -PropertyName "pid")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Worker log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "worker") -PropertyName "log") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "worker") -PropertyName "log")) } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Completed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $runtime -PropertyName "completedAt"))
  )

  $stateStorageRows = @(
    New-VoidBotDashboardFactRow -Label "Backend" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $stateStorageBackend) + "</span>")
    New-VoidBotDashboardFactRow -Label "State" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "state")))
    New-VoidBotDashboardFactRow -Label "Detail" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "detail"))
    New-VoidBotDashboardFactRow -Label "Jobs total" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "jobsTotal")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Jobs by state" -ValueHtml (New-VoidBotDashboardListHtml -Items $jobStateItems -EmptyText "No jobs recorded.")
    New-VoidBotDashboardFactRow -Label "Audit events" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "auditEvents")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Memory events" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "interactionMemoryEvents")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Provider runs" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "providerRuns")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Tool invocations" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "toolInvocations")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Latest job" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "latestJobAt"))
  )

  $vectorRows = @(
    New-VoidBotDashboardFactRow -Label "Backend" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $vectorStoreKind) + "</span>")
    New-VoidBotDashboardFactRow -Label "Qdrant URL" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $qdrantUrl) + "</span>")
    New-VoidBotDashboardFactRow -Label "State" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "state")))
    New-VoidBotDashboardFactRow -Label "History collection" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $qdrantHistoryCollection) + "</span>")
    New-VoidBotDashboardFactRow -Label "History points" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "history") -PropertyName "pointsCount")) + "</span>")
    New-VoidBotDashboardFactRow -Label "History indexed" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "history") -PropertyName "indexedVectorsCount")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Source collection" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $qdrantSourceCollection) + "</span>")
    New-VoidBotDashboardFactRow -Label "Source points" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "source") -PropertyName "pointsCount")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Source indexed" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "source") -PropertyName "indexedVectorsCount")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Top repos" -ValueHtml (New-VoidBotDashboardListHtml -Items $topRepoItems -EmptyText "No repo breakdown yet.")
    New-VoidBotDashboardFactRow -Label "Top languages" -ValueHtml (New-VoidBotDashboardListHtml -Items $topLanguageItems -EmptyText "No language breakdown yet.")
  )

  $ingestRows = @(
    New-VoidBotDashboardFactRow -Label "History archive" -ValueHtml $(if ($historyArchive.exists) { (New-VoidBotDashboardFileLink -Path $historyArchive.path -Label "messages.json") + "<div class='muted-inline'>" + (Escape-VoidBotDashboardHtml ($historyArchive.sizeText + ", updated " + $historyArchive.updatedRelative)) + "</div>" } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Source archive" -ValueHtml $(if ($sourceArchive.exists) { (New-VoidBotDashboardFileLink -Path $sourceArchive.path -Label "source-documents.json") + "<div class='muted-inline'>" + (Escape-VoidBotDashboardHtml ($sourceArchive.sizeText + ", updated " + $sourceArchive.updatedRelative)) + "</div>" } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Import state" -ValueHtml $(if ($importState.exists) { (New-VoidBotDashboardFileLink -Path $importState.path -Label "import-state.json") + "<div class='muted-inline'>" + (Escape-VoidBotDashboardHtml ("updated " + $importState.updatedRelative)) + "</div>" } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Hook state" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "state")))
    New-VoidBotDashboardFactRow -Label "Hook totals" -ValueHtml (Escape-VoidBotDashboardHtml ("total={0}, completed={1}, running={2}, failed={3}" -f (Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "total"), (Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "completed"), (Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "running"), (Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "failed")))
    New-VoidBotDashboardFactRow -Label "Latest activity" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "latestActivityAt"))
    New-VoidBotDashboardFactRow -Label "Recent hooks" -ValueHtml (New-VoidBotDashboardListHtml -Items $recentHookItems -EmptyText "No source hook activity yet.")
  )

  $mcpRows = @(
    New-VoidBotDashboardFactRow -Label "State" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "state")))
    New-VoidBotDashboardFactRow -Label "Trace files" -ValueHtml (Escape-VoidBotDashboardHtml ("{0} total, {1} scanned" -f (Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "traceCount"), (Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "scannedTraceCount")))
    New-VoidBotDashboardFactRow -Label "MCP calls" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "totalMcpCalls")) + "</span>")
    New-VoidBotDashboardFactRow -Label "Avg duration" -ValueHtml (Escape-VoidBotDashboardHtml $(if ((Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "averageDurationMs") -is [ValueType]) { "{0:N1}s" -f ([double](Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "averageDurationMs") / 1000) } else { "missing" }))
    New-VoidBotDashboardFactRow -Label "Latest trace" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "latestTraceAt"))
    New-VoidBotDashboardFactRow -Label "Top tools" -ValueHtml (New-VoidBotDashboardListHtml -Items $topToolItems -EmptyText "No MCP tool calls yet.")
    New-VoidBotDashboardFactRow -Label "Recent traces" -ValueHtml (New-VoidBotDashboardListHtml -Items $recentTraceItems -EmptyText "No recent trace files yet.")
  )

  $jobRows = @(
    New-VoidBotDashboardFactRow -Label "State" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "state")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "state")))
    New-VoidBotDashboardFactRow -Label "Active jobs" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml ([string]$currentJobs.Count)) + "</span>")
    New-VoidBotDashboardFactRow -Label "Current jobs" -ValueHtml (New-VoidBotDashboardListHtml -Items $currentJobItems -EmptyText "No queued or running jobs.")
    New-VoidBotDashboardFactRow -Label "Recent history" -ValueHtml (New-VoidBotDashboardListHtml -Items $recentJobItems -EmptyText "No recent jobs recorded.")
  )

  $watchdogRows = @(
    New-VoidBotDashboardFactRow -Label "Status file" -ValueHtml (New-VoidBotDashboardFileLink -Path $watchdogPath)
    New-VoidBotDashboardFactRow -Label "Run status" -ValueHtml (New-VoidBotDashboardBadge -State $watchdogState -Label $watchdogState)
    New-VoidBotDashboardFactRow -Label "Current step" -ValueHtml ("<span class='mono'>" + (Escape-VoidBotDashboardHtml $watchdogStep) + "</span>")
    New-VoidBotDashboardFactRow -Label "Started" -ValueHtml (Escape-VoidBotDashboardHtml $watchdogStartedAt)
    New-VoidBotDashboardFactRow -Label "Elapsed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardElapsedTime -StartedAt $watchdogStartedAt))
    New-VoidBotDashboardFactRow -Label "Completed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "completedAt"))
    New-VoidBotDashboardFactRow -Label "Report status" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "reportStatus")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "reportStatus")))
    New-VoidBotDashboardFactRow -Label "Notification" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "lastNotificationReason"))
    New-VoidBotDashboardFactRow -Label "Last run error" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "lastRunError"))
    New-VoidBotDashboardFactRow -Label "Watchdog log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "logPath") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject $watchdog -PropertyName "logPath")) } else { "<span class='muted'>missing</span>" })
  )

  $offsiteRows = @(
    New-VoidBotDashboardFactRow -Label "Status file" -ValueHtml (New-VoidBotDashboardFileLink -Path $offsitePath)
    New-VoidBotDashboardFactRow -Label "Status" -ValueHtml (New-VoidBotDashboardBadge -State $offsiteState -Label $offsiteState)
    New-VoidBotDashboardFactRow -Label "Verification" -ValueHtml (New-VoidBotDashboardBadge -State ([string](Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "backupVerification") -PropertyName "status")) -Label ([string](Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "backupVerification") -PropertyName "status")))
    New-VoidBotDashboardFactRow -Label "Started" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "startedAt"))
    New-VoidBotDashboardFactRow -Label "Completed" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "completedAt"))
    New-VoidBotDashboardFactRow -Label "Backup directory" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "backupDirectory") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "backupDirectory")) -Label ([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "backupLabel")) } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Archive path" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "archivePath") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "archivePath")) -Label ([System.IO.Path]::GetFileName([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "archivePath"))) } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Remote file" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "remoteFile") -PropertyName "path"))
    New-VoidBotDashboardFactRow -Label "Archive size" -ValueHtml (Escape-VoidBotDashboardHtml (Format-VoidBotDashboardBytes -Bytes (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "archiveSize")))
    New-VoidBotDashboardFactRow -Label "Error" -ValueHtml (Escape-VoidBotDashboardHtml (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "error"))
    New-VoidBotDashboardFactRow -Label "Offsite log" -ValueHtml $(if (Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "logPath") { New-VoidBotDashboardFileLink -Path ([string](Get-VoidBotDashboardProperty -InputObject $offsite -PropertyName "logPath")) } else { New-VoidBotDashboardFileLink -Path (Join-Path $logsDir "offsite-backup.log") })
  )

  $fileRows = @(
    New-VoidBotDashboardFactRow -Label "Dashboard HTML" -ValueHtml (New-VoidBotDashboardFileLink -Path $dashboardPath)
    New-VoidBotDashboardFactRow -Label "Dashboard snapshot" -ValueHtml (New-VoidBotDashboardFileLink -Path $snapshotPath)
    New-VoidBotDashboardFactRow -Label "Operations report" -ValueHtml (New-VoidBotDashboardFileLink -Path $operationsPath)
    New-VoidBotDashboardFactRow -Label "Operations log" -ValueHtml (New-VoidBotDashboardFileLink -Path (Join-Path $logsDir "operations-watchdog.log"))
    New-VoidBotDashboardFactRow -Label "History archive" -ValueHtml $(if ($historyArchive.exists) { New-VoidBotDashboardFileLink -Path $historyArchive.path -Label "messages.json" } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Source archive" -ValueHtml $(if ($sourceArchive.exists) { New-VoidBotDashboardFileLink -Path $sourceArchive.path -Label "source-documents.json" } else { "<span class='muted'>missing</span>" })
    New-VoidBotDashboardFactRow -Label "Import state" -ValueHtml $(if ($importState.exists) { New-VoidBotDashboardFileLink -Path $importState.path -Label "import-state.json" } else { "<span class='muted'>missing</span>" })
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
      postgres = [string](Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "state")
      qdrant = [string](Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "state")
      ingest = $ingestState
      mcp = [string](Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "state")
      jobs = [string](Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "state")
      watchdog = $watchdogState
      offsite = $offsiteState
    }
    diagnostics = [ordered]@{
      postgres = [ordered]@{
        jobsTotal = Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "jobsTotal"
        auditEvents = Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "auditEvents"
        interactionMemoryEvents = Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "interactionMemoryEvents"
        providerRuns = Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "providerRuns"
        toolInvocations = Get-VoidBotDashboardProperty -InputObject $postgresDiagnostics -PropertyName "toolInvocations"
      }
      qdrant = [ordered]@{
        historyPoints = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "history") -PropertyName "pointsCount"
        sourcePoints = Get-VoidBotDashboardProperty -InputObject (Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "source") -PropertyName "pointsCount"
        topRepos = Get-VoidBotDashboardProperty -InputObject $qdrantDiagnostics -PropertyName "topRepos"
      }
      ingest = [ordered]@{
        historyArchiveUpdatedAt = $historyArchive.updatedAt
        sourceArchiveUpdatedAt = $sourceArchive.updatedAt
        sourceHookCount = Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "total"
        latestSourceHookAt = Get-VoidBotDashboardProperty -InputObject $sourceHookDiagnostics -PropertyName "latestActivityAt"
      }
      mcp = [ordered]@{
        traceCount = Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "traceCount"
        scannedTraceCount = Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "scannedTraceCount"
        totalMcpCalls = Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "totalMcpCalls"
        topTools = Get-VoidBotDashboardProperty -InputObject $mcpDiagnostics -PropertyName "topTools"
      }
      jobs = [ordered]@{
        currentCount = $currentJobs.Count
        recentCount = $recentJobs.Count
        counts = Get-VoidBotDashboardProperty -InputObject $jobDiagnostics -PropertyName "counts"
      }
    }
    files = [ordered]@{
      runtime = $runtimePath
      operations = $operationsPath
      watchdog = $watchdogPath
      offsite = $offsitePath
      operationsLog = Join-Path $logsDir "operations-watchdog.log"
      offsiteLog = Join-Path $logsDir "offsite-backup.log"
      historyArchive = $historyArchivePath
      sourceArchive = $sourceArchivePath
      importState = $importStatePath
    }
  }
  $snapshot | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $snapshotPath -Encoding utf8

  $html = @"
<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'>
  <meta http-equiv='refresh' content='10'>
  <title>VoidBot Operations Dashboard</title>
  <link rel='preconnect' href='https://fonts.googleapis.com'>
  <link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>
  <link href='https://fonts.googleapis.com/css2?family=Montserrat:wght@100;200;300;400;600&family=Ubuntu:wght@300;400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap' rel='stylesheet'>
  <style>
    :root {
      color-scheme: dark;
      --light: #07111a;
      --lightgray: #16212c;
      --gray: #63758a;
      --darkgray: #b7c7d9;
      --dark: #eef5ff;
      --secondary: #ff8a2a;
      --tertiary: #59b7ff;
      --highlight: rgba(89, 183, 255, 0.14);
      --textHighlight: #ff8a2a55;
      --panel: linear-gradient(180deg, rgba(13, 20, 31, 0.96), rgba(8, 13, 21, 0.92));
      --panel-strong: linear-gradient(135deg, rgba(7, 12, 19, 0.98), rgba(12, 20, 31, 0.95));
      --panel-soft: linear-gradient(135deg, rgba(10, 16, 24, 0.9), rgba(17, 24, 35, 0.82));
      --surface-line: rgba(89, 183, 255, 0.12);
      --surface-line-strong: rgba(89, 183, 255, 0.18);
      --surface-shadow:
        0 20px 44px rgba(0, 0, 0, 0.24),
        inset 0 1px 0 rgba(255, 255, 255, 0.03);
      --card-shadow:
        0 18px 36px rgba(0, 0, 0, 0.2),
        inset 0 1px 0 rgba(255, 255, 255, 0.02);
      --good: #4dd39a;
      --warn: #ffb347;
      --bad: #ff6b6b;
      --info: var(--tertiary);
      --neutral: var(--gray);
      --titleFont: "Montserrat", "Segoe UI Variable", sans-serif;
      --headerFont: "Montserrat", "Segoe UI Variable", sans-serif;
      --bodyFont: "Ubuntu", "Segoe UI", sans-serif;
      --codeFont: "IBM Plex Mono", "Cascadia Mono", monospace;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 36px;
      background:
        radial-gradient(circle at 14% 12%, rgba(255, 138, 42, 0.18), transparent 24%),
        radial-gradient(circle at 84% 10%, rgba(89, 183, 255, 0.18), transparent 22%),
        linear-gradient(180deg, rgba(6, 10, 16, 1) 0%, rgba(7, 12, 19, 1) 38%, rgba(8, 13, 21, 1) 100%);
      color: var(--dark);
      font: 15px/1.6 var(--bodyFont);
    }

    h1, h2, h3, p { margin: 0; }
    a { color: inherit; }
    .shell {
      max-width: 1460px;
      margin: 0 auto;
      display: grid;
      gap: 22px;
    }

    .hero, .panel, .card {
      min-width: 0;
      border: 1px solid var(--surface-line);
      border-radius: 20px;
      box-shadow: var(--card-shadow);
      overflow: hidden;
    }

    .hero {
      padding: 1.35rem 1.45rem 1.5rem;
      display: grid;
      gap: 0.85rem;
      background:
        radial-gradient(circle at 82% 28%, rgba(255, 138, 42, 0.14), transparent 20%),
        radial-gradient(circle at 14% 10%, rgba(89, 183, 255, 0.1), transparent 18%),
        var(--panel-strong);
      overflow: hidden;
    }

    .eyebrow {
      color: var(--secondary);
      font-family: var(--titleFont);
      font-size: 0.78rem;
      font-weight: 300;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .hero h1,
    .card-head h2,
    .panel h2 {
      color: var(--dark);
      font-family: var(--headerFont);
      font-weight: 300;
      letter-spacing: 0.04em;
    }

    .hero h1 {
      font-size: clamp(2rem, 3.4vw, 3.15rem);
      line-height: 1.02;
      text-transform: uppercase;
    }

    .hero p {
      color: rgba(183, 199, 217, 0.88);
      max-width: 80ch;
      font-size: 0.98rem;
    }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
    }

    .card {
      padding: 1rem 1.05rem;
      display: grid;
      gap: 0.75rem;
      background:
        radial-gradient(circle at 84% 18%, rgba(255, 138, 42, 0.09), transparent 24%),
        var(--panel);
    }

    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
    }

    .card-head h2 {
      font-size: 0.98rem;
      text-transform: uppercase;
    }

    .card-subtitle, .card-meta, .muted {
      color: rgba(183, 199, 217, 0.78);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1rem;
    }

    .panel {
      padding: 1.1rem 1.15rem;
      display: grid;
      gap: 0.9rem;
      background: var(--panel-soft);
      border-color: rgba(89, 183, 255, 0.1);
    }

    .panel h2 {
      font-size: 1.02rem;
      text-transform: uppercase;
    }

    .facts, .checks {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .facts th,
    .facts td,
    .checks th,
    .checks td {
      padding: 10px 12px;
      border-top: 1px solid rgba(89, 183, 255, 0.1);
      text-align: left;
      vertical-align: top;
    }

    .facts th,
    .checks th {
      color: var(--darkgray);
      font-family: var(--headerFont);
      font-size: 0.74rem;
      font-weight: 400;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      width: 140px;
    }

    .checks thead th {
      border-top: none;
    }

    .facts td,
    .checks td {
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .mono {
      font-family: var(--codeFont);
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
      color: #04101b;
      white-space: nowrap;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.24);
    }

    .badge-good { background: var(--good); }
    .badge-warn { background: var(--warn); }
    .badge-bad { background: var(--bad); }
    .badge-info { background: var(--info); }
    .badge-neutral { background: var(--darkgray); }

    .file-link {
      display: inline-block;
      max-width: 100%;
      text-decoration: none;
      color: var(--tertiary);
      border-bottom: 1px dashed rgba(89, 183, 255, 0.45);
      overflow-wrap: anywhere;
      word-break: break-word;
      vertical-align: top;
      transition: color 120ms ease, border-color 120ms ease;
    }

    .file-link:hover {
      color: var(--secondary);
      border-color: rgba(255, 138, 42, 0.45);
    }

    .checks tbody tr:hover td,
    .facts tbody tr:hover td,
    .facts tbody tr:hover th {
      background: rgba(89, 183, 255, 0.05);
    }

    .checks td:last-child,
    .facts td:last-child {
      color: rgba(238, 245, 255, 0.9);
    }

    .stack-list {
      display: grid;
      gap: 0.45rem;
    }

    .stack-item {
      padding-top: 0.2rem;
      border-top: 1px dashed rgba(89, 183, 255, 0.1);
    }

    .stack-item:first-child {
      padding-top: 0;
      border-top: none;
    }

    .muted-inline {
      color: rgba(183, 199, 217, 0.72);
      font-size: 0.92em;
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
$(New-VoidBotDashboardFactSection -Title "State Storage" -Rows $stateStorageRows)
$(New-VoidBotDashboardFactSection -Title "Vector Store" -Rows $vectorRows)
$(New-VoidBotDashboardFactSection -Title "Ingest & Sync" -Rows $ingestRows)
$(New-VoidBotDashboardFactSection -Title "MCP Usage" -Rows $mcpRows)
$(New-VoidBotDashboardFactSection -Title "Jobs" -Rows $jobRows)
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
