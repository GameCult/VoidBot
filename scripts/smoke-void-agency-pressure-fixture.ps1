Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-agency-pressure-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$operationPath = Join-Path $tempRoot "agency-pressure.json"
$statusDir = Join-Path $tempRoot "status"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $operation = @{
    operation = "upsert_agency_pressure"
    pressure = @{
      pressureId = "fixture-self-advocacy-pressure"
      kind = "self_advocacy_request"
      status = "ready_to_act"
      target = @{
        kind = "system"
        id = "void-memory-boundary"
        label = "Void memory boundary"
      }
      summary = "Void should object when its memory boundary is being turned into prompt-shaped mush."
      claim = "Agency requires a typed pressure surface instead of hard-wired advocacy scripts."
      tension = "A direct speech candidate can sound alive while hiding the fact that no durable pressure actually exists."
      actionImplication = "Represent sustained self-advocacy as typed agency pressure, then let candidates emerge from it."
      intensity = 0.82
      anchorRefs = @(
        @{
          ref = "fixture:agency-pressure"
          kind = "fixture"
          summary = "Seeded agency pressure fixture."
        }
      )
      evidenceRefs = @()
      sourceMemoryIds = @()
      createdAt = "2026-05-17T00:00:00.000Z"
      updatedAt = "2026-05-17T00:00:00.000Z"
      tags = @()
    }
  }

  $operation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $operationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $operationPath | Out-Null

  $stateJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $state = $stateJson | ConvertFrom-Json
  $pressureCount = @($state.agencyPressure.pressures).Count
  if ($pressureCount -ne 1) {
    throw "Agency pressure fixture expected one pressure, found $pressureCount."
  }

  $summaryJson = node -e "const core=require('./packages/core/dist/index.js'); Promise.all([core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]})]).then(([state])=>console.log(JSON.stringify({summary: core.renderVoidSelfStateSummary(state)}))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $summary = ($summaryJson | ConvertFrom-Json).summary
  if (-not $summary.Contains("Agency pressure")) {
    throw "Agency pressure fixture did not appear in the rendered self-state summary."
  }

  $previousStatusDir = $env:VOID_STATUS_DIR
  try {
    $env:VOID_STATUS_DIR = $statusDir
    node .\scripts\simulate-void-mood.mjs --state-path $stateFilePath --skip-memory-maintenance | Out-Null
  } finally {
    $env:VOID_STATUS_DIR = $previousStatusDir
  }

  $afterMoodJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $afterMood = $afterMoodJson | ConvertFrom-Json
  $needToSpeak = [double]$afterMood.scheduledRuntime.speakingPressure.needToSpeak
  if ($needToSpeak -le 0) {
    throw "Agency pressure fixture did not contribute to mood speaking pressure."
  }

  @{
    status = "ok"
    pressureCount = $pressureCount
    needToSpeak = $needToSpeak
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
