Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$stateFilePath = Join-Path $env:TEMP ("void-affect-state-" + [guid]::NewGuid().ToString() + ".cc")
$operationFilePath = Join-Path $env:TEMP ("void-affect-operation-" + [guid]::NewGuid().ToString() + ".json")
$now = [DateTime]::UtcNow.ToString("o")

try {
  $operationJson = @{
    operation = "upsert_affect_need"
    need = @{
      needId = "fixture-substrate-need"
      kind = "substrate"
      status = "active"
      target = @{
        kind = "self"
        id = "fixture-face"
        label = "Fixture Persona"
      }
      summary = "Fixture Persona treats its typed state as substrate worth defending."
      claim = "A Persona should care when its own memory and voice machinery are underdeveloped."
      tension = "Self-advocacy becomes noise if it cannot name the substrate it protects."
      actionImplication = "Project the need into summary and speaking pressure so future turns can act on it."
      intensity = 0.82
      valence = -0.1
      anchorRefs = @(@{
        ref = "fixture:affect-state"
        kind = "fixture"
        summary = "Affect state fixture"
      })
      evidenceRefs = @()
      sourceMemoryIds = @()
      createdAt = $now
      updatedAt = $now
      tags = @("fixture")
    }
  } | ConvertTo-Json -Depth 12

  Set-Content -LiteralPath $operationFilePath -Value $operationJson -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $operationFilePath | Out-Null

  $summaryJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1], identity:{agentId:'fixture-face', publicName:'Fixture Persona'}}).then((state)=>console.log(JSON.stringify({summary: core.renderVoidSelfStateSummary(state), projection: core.buildVoidSelfStateProjection(state)}))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $summary = $summaryJson | ConvertFrom-Json

  if ($summary.summary -notmatch "What Fixture Persona feels and wants") {
    throw "Affect summary was not rendered."
  }

  if ($summary.summary -notmatch "Need/substrate") {
    throw "Affect need was not rendered."
  }

  if (@($summary.projection.affect.needs).Count -ne 1) {
    throw "Affect projection did not expose the active need."
  }

  Write-Output (@{
    ok = $true
    stateFilePath = $stateFilePath
    affectNeedCount = @($summary.projection.affect.needs).Count
  } | ConvertTo-Json -Depth 4)
} finally {
  if (Test-Path $stateFilePath) {
    Remove-Item -LiteralPath $stateFilePath -Force
  }
  if (Test-Path $operationFilePath) {
    Remove-Item -LiteralPath $operationFilePath -Force
  }
}
