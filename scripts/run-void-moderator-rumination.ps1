param(
  [switch] $NoPost
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$stateFilePath = Join-Path $repoRoot ".voidbot\private\void-self-state.cc"
$statusDir = Join-Path $repoRoot ".voidbot\status"
$logDir = Join-Path $repoRoot ".voidbot\logs"
$statusPath = Join-Path $statusDir "moderation-rumination.json"
$summaryLogPath = Join-Path $logDir "moderation-rumination.log"
$lockPath = Join-Path $statusDir "moderation-rumination.lock"
$recentHistoryScriptPath = Join-Path $repoRoot "scripts\export-recent-discord-history.mjs"
$selfStateScriptPath = Join-Path $repoRoot "scripts\void-self-state.mjs"
$startedAtUtc = [DateTime]::UtcNow

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    $Data
  )

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $json = $Data | ConvertTo-Json -Depth 12
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Append-RunLog {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Line
  )

  $timestamped = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Line
  Add-Content -Path $summaryLogPath -Value $timestamped -Encoding UTF8
}

function Invoke-NodeJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments
  )

  $output = & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node helper failed: node $($Arguments -join ' ')"
  }
  if ([string]::IsNullOrWhiteSpace($output)) {
    return $null
  }
  return $output | ConvertFrom-Json
}

function Get-TypedModerationCursor {
  $script = @"
const core = require('./packages/core/dist');
core.loadVoidSelfStateTypedDocuments({ canonicalPath: process.argv[1] })
  .then((state) => {
    console.log(JSON.stringify({
      lastReviewedMessageId: state.moderationCursor.lastReviewedMessageId ?? null,
      lastReviewedTimestamp: state.moderationCursor.lastReviewedTimestamp ?? null
    }));
  })
  .catch((error) => { console.error(error); process.exit(1); });
"@
  $output = & node -e $script $stateFilePath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read typed self-state cursor."
  }
  return $output | ConvertFrom-Json
}

function Apply-TypedOperation {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable] $Operation
  )

  $operationJson = $Operation | ConvertTo-Json -Compress -Depth 20
  [void](Invoke-NodeJson -Arguments @(
    $selfStateScriptPath,
    "apply-operation",
    "--canonical", $stateFilePath,
    "--operation", $operationJson
  ))
}

trap {
  $finishedAtUtc = [DateTime]::UtcNow
  $failureMessage = $_.Exception.Message

  Write-JsonFile -Path $statusPath -Data @{
    status = "failed"
    startedAt = $startedAtUtc.ToString("o")
    finishedAt = $finishedAtUtc.ToString("o")
    durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
    failureMessage = $failureMessage
    noPost = [bool]$NoPost
    stateFile = $stateFilePath
  }

  Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
  throw
}

New-Item -ItemType Directory -Force -Path $statusDir, $logDir, (Split-Path -Parent $stateFilePath) | Out-Null

if (Test-Path $lockPath) {
  $lockAge = [DateTime]::UtcNow - (Get-Item $lockPath).LastWriteTimeUtc
  if ($lockAge.TotalMinutes -lt 20) {
    Write-JsonFile -Path $statusPath -Data @{
      status = "skipped"
      reason = "lock_present"
      observedAt = ([DateTime]::UtcNow.ToString("o"))
      stateFile = $stateFilePath
    }
    return
  }
  Remove-Item -LiteralPath $lockPath -Force
}

Write-JsonFile -Path $lockPath -Data @{
  pid = $PID
  startedAt = $startedAtUtc.ToString("o")
}

if (-not (Test-Path $recentHistoryScriptPath)) {
  throw "Missing recent history helper at $recentHistoryScriptPath"
}
if (-not (Test-Path $selfStateScriptPath)) {
  throw "Missing typed self-state helper at $selfStateScriptPath"
}

$priorCursor = Get-TypedModerationCursor
$historyArgs = @($recentHistoryScriptPath)
if ($null -ne $priorCursor -and -not [string]::IsNullOrWhiteSpace([string]$priorCursor.lastReviewedTimestamp)) {
  $historyArgs += @("--after", [string]$priorCursor.lastReviewedTimestamp, "--limit", "120")
} else {
  $historyArgs += @("--hours", "6", "--limit", "120")
}

$history = Invoke-NodeJson -Arguments $historyArgs
$observedCursor = $priorCursor
$messageCount = 0

if ($null -ne $history.messages) {
  $messageCount = $history.messages.Count
}

if ($messageCount -gt 0) {
  $latestObservedMessage = $history.messages[$messageCount - 1]
  $observedCursor = [pscustomobject]@{
    lastReviewedMessageId = $latestObservedMessage.id
    lastReviewedTimestamp = $latestObservedMessage.timestamp
  }

  if (
    -not [string]::IsNullOrWhiteSpace([string]$observedCursor.lastReviewedMessageId) -and
    -not [string]::IsNullOrWhiteSpace([string]$observedCursor.lastReviewedTimestamp)
  ) {
    Apply-TypedOperation -Operation @{
      operation = "record_reviewed_messages"
      lastReviewedMessageId = [string]$observedCursor.lastReviewedMessageId
      lastReviewedTimestamp = [string]$observedCursor.lastReviewedTimestamp
    }
  }
}

$finishedAtUtc = [DateTime]::UtcNow
Write-JsonFile -Path $statusPath -Data @{
  status = "ok"
  mode = "typed_cursor_only"
  startedAt = $startedAtUtc.ToString("o")
  finishedAt = $finishedAtUtc.ToString("o")
  durationSeconds = [Math]::Round(($finishedAtUtc - $startedAtUtc).TotalSeconds, 2)
  noPost = [bool]$NoPost
  stateFile = $stateFilePath
  observedMessageCount = $messageCount
  previousCursor = $priorCursor
  observedCursor = $observedCursor
  note = "Legacy Codex rumination is offline. This runner only advances typed chronology until the typed phase machine is rebuilt."
}

Append-RunLog ("mode=typed_cursor_only messages={0} cursor={1}" -f $messageCount, ([string]$observedCursor.lastReviewedTimestamp))
Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
