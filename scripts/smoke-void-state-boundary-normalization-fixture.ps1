Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-state-boundary-normalization-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Invoke-NodeChecked {
  param([Parameter(Mandatory = $true)][string[]] $Arguments)

  $output = & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node command failed: node $($Arguments -join ' ')"
  }
  return $output
}

function Write-OperationFile {
  param(
    [Parameter(Mandatory = $true)][hashtable] $Operation,
    [Parameter(Mandatory = $true)][string] $Name
  )

  $path = Join-Path $tempRoot $Name
  $Operation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $path -Encoding UTF8
  return $path
}

function Assert-NotFutureTimestamp {
  param(
    [Parameter(Mandatory = $true)][string] $Timestamp,
    [Parameter(Mandatory = $true)][string] $Label
  )

  $parsed = [DateTimeOffset]::Parse($Timestamp)
  $now = [DateTimeOffset]::UtcNow.AddSeconds(2)
  if ($parsed -gt $now) {
    throw "$Label is still in the future: $Timestamp"
  }
}

try {
  $futureMemory = @{
    operation = "record_short_term_memory"
    memory = @{
      memoryId = "fixture-future-short-term"
      kind = "project_seam"
      target = @{ kind = "repo"; id = "VoidBot"; label = "VoidBot" }
      summary = "Model-authored timestamps must not become canonical state time."
      claim = "The parent state service owns canonical timestamps for model-originated writes."
      tension = "If child timestamps are trusted, projection order can imply events that have not happened."
      actionImplication = "Stamp short-term memory writes at the typed state boundary."
      anchorRefs = @(
        @{
          ref = "fixture:future-memory"
          kind = "fixture"
          summary = "Future timestamp normalization fixture."
        }
      )
      evidenceRefs = @()
      createdAt = "2999-01-01T00:00:00.000Z"
      updatedAt = "2999-01-01T00:00:00.000Z"
      tags = @("repo:VoidBot", "topic:state-boundary")
    }
  }

  $targetlessCandidate = @{
    operation = "queue_candidate_intervention"
    intervention = @{
      interventionId = "fixture-targetless-queued"
      kind = "self_advocacy"
      status = "queued"
      target = @{ kind = "system"; id = "typed-state-boundary"; label = "Typed state boundary" }
      summary = "Queued candidate without a delivery target should not project as deliverable."
      draft = "A queued candidate needs an actual delivery target, or it is theater with a clipboard."
      priority = 0.5
      mustEventuallyShare = $false
      createdAt = "2999-01-01T00:00:00.000Z"
      updatedAt = "2999-01-01T00:00:00.000Z"
      tags = @("topic:state-boundary")
    }
  }

  foreach ($entry in @(
    @{ Operation = $futureMemory; Name = "future-memory.json" },
    @{ Operation = $targetlessCandidate; Name = "targetless-candidate.json" }
  )) {
    $path = Write-OperationFile -Operation $entry.Operation -Name $entry.Name
    Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $stateFilePath, "--operation-file", $path) | Out-Null
  }

  $stateJson = Invoke-NodeChecked -Arguments @("-e", "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })", $stateFilePath)
  $state = $stateJson | ConvertFrom-Json
  $memory = @($state.thoughtMemory.shortTerm | Where-Object { $_.memoryId -eq "fixture-future-short-term" })[0]
  $candidate = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-targetless-queued" })[0]
  $legacyCursorJson = Invoke-NodeChecked -Arguments @("-e", "const core=require('./packages/core/dist/index.js'); const parsed=core.voidModerationCursorSchema.parse({ userStatuses: [{ userId: 'fixture-user', userName: 'Fixture User', status: 'watched', summary: 'Legacy bare status patch should decode as a cursor document.', updatedAt: '2026-06-04T00:00:00.000Z' }] }); console.log(JSON.stringify(parsed));")
  $legacyCursor = $legacyCursorJson | ConvertFrom-Json

  if ($memory.createdAt -eq "2999-01-01T00:00:00.000Z" -or $memory.updatedAt -eq "2999-01-01T00:00:00.000Z") {
    throw "Short-term memory kept model-authored future timestamps."
  }
  Assert-NotFutureTimestamp -Timestamp $memory.createdAt -Label "short-term createdAt"
  Assert-NotFutureTimestamp -Timestamp $memory.updatedAt -Label "short-term updatedAt"

  if ($candidate.status -ne "deferred") {
    throw "Targetless queued candidate was not deferred; status is $($candidate.status)."
  }
  if (-not @($candidate.tags).Contains("normalized:targetless-queued-to-deferred")) {
    throw "Targetless queued candidate was deferred without a normalization tag."
  }
  if ($legacyCursor.schemaVersion -ne 1 -or @($legacyCursor.openCases).Count -ne 0 -or @($legacyCursor.repoActivityCursor).Count -ne 0) {
    throw "Legacy bare moderation userStatuses patch did not normalize to a canonical cursor document."
  }
  if ($legacyCursor.updatedAt -ne "2026-06-04T00:00:00.000Z") {
    throw "Legacy bare moderation cursor did not inherit the latest status timestamp."
  }
  Assert-NotFutureTimestamp -Timestamp $candidate.createdAt -Label "candidate createdAt"
  Assert-NotFutureTimestamp -Timestamp $candidate.updatedAt -Label "candidate updatedAt"

  @{
    status = "ok"
    shortTermMemoryId = $memory.memoryId
    candidateStatus = $candidate.status
    candidateTags = @($candidate.tags)
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
