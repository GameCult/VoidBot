Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-memory-lifecycle-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$seedPath = Join-Path $tempRoot "seed-memory.json"
$revisePath = Join-Path $tempRoot "revise-memory.json"
$crystallizePath = Join-Path $tempRoot "crystallize-memory.json"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Invoke-NodeChecked {
  param([Parameter(Mandatory = $true)][string[]] $Arguments)

  $output = & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node command failed: node $($Arguments -join ' ')"
  }
  return $output
}

try {
  $anchor = @{
    ref = "fixture:memory-lifecycle"
    kind = "fixture"
    summary = "Seeded memory lifecycle fixture."
  }
  $seed = @{
    operation = "record_short_term_memory"
    memory = @{
      memoryId = "short-term-lifecycle"
      kind = "project_seam"
      target = @{ kind = "system"; id = "void-memory"; label = "Void memory" }
      summary = "Long-term memory should survive sleep without becoming immutable."
      claim = "Durable memory needs plasticity."
      tension = "If durable memory silently overwrites itself, identity drift gets hidden."
      actionImplication = "Represent revision and crystallization as explicit typed operations."
      anchorRefs = @($anchor)
      evidenceRefs = @()
      createdAt = "2026-05-17T00:00:00.000Z"
      updatedAt = "2026-05-17T00:00:00.000Z"
      tags = @()
    }
  }
  $revision = @{
    operation = "revise_durable_memory"
    sourceMemoryIds = @("durable-lifecycle-a")
    memory = @{
      memoryId = "durable-lifecycle-b"
      kind = "project_seam"
      target = @{ kind = "system"; id = "void-memory"; label = "Void memory" }
      summary = "Long-term memory is durable, revisable thought."
      claim = "A memory can survive sleep and still be revised, merged, contradicted, retired, or crystallized later."
      tension = "Plasticity must be explicit enough that Void does not erase itself by accident."
      actionImplication = "Use lifecycle operations instead of treating durable memory as immutable."
      anchorRefs = @($anchor)
      evidenceRefs = @()
      createdAt = "2026-05-17T00:00:00.000Z"
      updatedAt = "2026-05-17T01:00:00.000Z"
      tags = @()
    }
    revisedAt = "2026-05-17T01:00:00.000Z"
    reason = "newer thought clarified that durability is not immutability"
  }
  $crystallize = @{
    operation = "crystallize_memory_into_identity"
    sourceMemoryIds = @("durable-lifecycle-b")
    memory = @{
      memoryId = "identity-memory-plasticity"
      kind = "identity_seam"
      target = @{ kind = "self"; id = "void"; label = "Void" }
      summary = "Void treats memory as durable, revisable self-continuity."
      claim = "A coherent self preserves what matters while allowing older thoughts to be revised or retired."
      tension = "Rigidity protects continuity badly when it prevents correction."
      actionImplication = "Prefer explicit reconsolidation over silent overwrite."
      anchorRefs = @($anchor)
      evidenceRefs = @()
      createdAt = "2026-05-17T00:00:00.000Z"
      updatedAt = "2026-05-17T02:00:00.000Z"
      tags = @("memory:lifecycle")
    }
    value = @{
      id = "memory-plasticity"
      label = "Durable memory stays plastic"
      priority = 0.72
      summary = "Void should revise, retire, or crystallize memories explicitly instead of treating survival as permanence."
    }
    crystallizedAt = "2026-05-17T02:00:00.000Z"
    reason = "the lifecycle rule is stable enough to become self-doctrine"
  }

  $seed | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $seedPath -Encoding UTF8
  Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $stateFilePath, "--operation-file", $seedPath) | Out-Null

  $promote = @{
    operation = "apply_memory_distillation"
    proposalId = "fixture-promote-lifecycle"
    sourceMemoryIds = @("short-term-lifecycle")
    memory = @{
      memoryId = "durable-lifecycle-a"
      kind = "project_seam"
      target = @{ kind = "system"; id = "void-memory"; label = "Void memory" }
      summary = "Long-term memory should survive sleep without becoming immutable."
      claim = "Durable memory needs plasticity."
      tension = "If durable memory silently overwrites itself, identity drift gets hidden."
      actionImplication = "Represent revision and crystallization as explicit typed operations."
      anchorRefs = @($anchor)
      evidenceRefs = @()
      createdAt = "2026-05-17T00:00:00.000Z"
      updatedAt = "2026-05-17T00:30:00.000Z"
      tags = @()
    }
    appliedAt = "2026-05-17T00:30:00.000Z"
  }
  $promotePath = Join-Path $tempRoot "promote-memory.json"
  $promote | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $promotePath -Encoding UTF8
  Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $stateFilePath, "--operation-file", $promotePath) | Out-Null

  $revision | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $revisePath -Encoding UTF8
  Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $stateFilePath, "--operation-file", $revisePath) | Out-Null

  $crystallize | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $crystallizePath -Encoding UTF8
  Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $stateFilePath, "--operation-file", $crystallizePath) | Out-Null

  $stateJson = Invoke-NodeChecked -Arguments @("-e", "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })", $stateFilePath)
  $state = $stateJson | ConvertFrom-Json
  $activeMemories = @($state.thoughtMemory.memories | Where-Object { $null -eq $_.PSObject.Properties["retiredAt"] -or [string]::IsNullOrWhiteSpace([string]$_.retiredAt) })
  $retiredMemories = @($state.thoughtMemory.memories | Where-Object { $null -ne $_.PSObject.Properties["retiredAt"] -and -not [string]::IsNullOrWhiteSpace([string]$_.retiredAt) })
  $identityMemory = @($activeMemories | Where-Object { $_.kind -eq "identity_seam" })[0]
  $value = @($state.selfProfile.values | Where-Object { $_.id -eq "memory-plasticity" })[0]

  if (@($state.thoughtMemory.shortTerm).Count -ne 0) {
    throw "Memory lifecycle fixture left short-term memories behind."
  }
  if ($activeMemories.Count -ne 1 -or $identityMemory.memoryId -ne "identity-memory-plasticity") {
    throw "Memory lifecycle fixture expected one active crystallized identity memory."
  }
  if ($retiredMemories.Count -lt 2) {
    throw "Memory lifecycle fixture expected superseded durable memories to be retired."
  }
  if ($null -eq $value) {
    throw "Memory lifecycle fixture did not crystallize a self-profile value."
  }

  @{
    status = "ok"
    activeMemoryCount = $activeMemories.Count
    retiredMemoryCount = $retiredMemories.Count
    value = $value.label
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
