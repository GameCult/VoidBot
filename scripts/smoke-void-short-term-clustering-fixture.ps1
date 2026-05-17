Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-short-term-clustering-fixture-" + [guid]::NewGuid().ToString("n"))
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

try {
  $first = @{
    operation = "record_short_term_memory"
    memory = @{
      memoryId = "short-aquasynth-boundary-a"
      kind = "project_seam"
      target = @{ kind = "repo"; id = "AquaSynth"; label = "AquaSynth" }
      summary = "AquaSynth owns the compiler boundary."
      claim = "Compiler-facing work belongs behind AquaSynth's runtime surface."
      tension = "Aquarium still has host code that can look like a side door."
      actionImplication = "Inspect the host boundary before writing another architectural sermon."
      anchorRefs = @(
        @{
          ref = "fixture:aquasynth-doc"
          kind = "fixture"
          summary = "AquaSynth boundary note."
        }
      )
      evidenceRefs = @()
      createdAt = "2026-05-17T03:00:00.000Z"
      updatedAt = "2026-05-17T03:00:00.000Z"
      tags = @("repo:AquaSynth", "repo:Aquarium-Engine", "topic:synth-boundary")
    }
  }

  $second = @{
    operation = "record_short_term_memory"
    memory = @{
      memoryId = "short-aquasynth-boundary-b"
      kind = "project_seam"
      target = @{ kind = "repo"; id = "Aquarium-Engine"; label = "Aquarium Engine" }
      summary = "The next synth-boundary move is inside AquariumSynthHost."
      claim = "The remaining question is whether compiler lifetime and render helpers still belong in Aquarium's host."
      tension = "Moving too much hides host responsibility; moving too little leaves the old side door open."
      actionImplication = "Open AquariumSynthHost and either move the authority or write the explicit host-only justification."
      anchorRefs = @(
        @{
          ref = "fixture:aquarium-host"
          kind = "fixture"
          summary = "AquariumSynthHost fixture anchor."
        }
      )
      evidenceRefs = @()
      createdAt = "2026-05-17T03:05:00.000Z"
      updatedAt = "2026-05-17T03:05:00.000Z"
      tags = @("repo:AquaSynth", "repo:Aquarium-Engine", "topic:synth-boundary")
    }
  }

  $third = @{
    operation = "record_short_term_memory"
    memory = @{
      memoryId = "short-aquasynth-docs"
      kind = "project_seam"
      target = @{ kind = "repo"; id = "AquaSynth"; label = "AquaSynth" }
      summary = "AquaSynth documentation should describe its extension format plainly."
      claim = "CultCache uses .cc files, and docs that imply a different extension mislead future tool builders."
      tension = "This is adjacent to AquaSynth work but not the same synth-boundary thought."
      actionImplication = "Keep documentation-extension cleanup separate from compiler-boundary pressure."
      anchorRefs = @(
        @{
          ref = "fixture:cultcache-extension"
          kind = "fixture"
          summary = "CultCache extension fixture anchor."
        }
      )
      evidenceRefs = @()
      createdAt = "2026-05-17T03:10:00.000Z"
      updatedAt = "2026-05-17T03:10:00.000Z"
      tags = @("repo:AquaSynth", "topic:cultcache-extension")
    }
  }

  foreach ($entry in @(
    @{ Operation = $first; Name = "first.json" },
    @{ Operation = $second; Name = "second.json" },
    @{ Operation = $third; Name = "third.json" }
  )) {
    $path = Write-OperationFile -Operation $entry.Operation -Name $entry.Name
    Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $stateFilePath, "--operation-file", $path) | Out-Null
  }

  $stateJson = Invoke-NodeChecked -Arguments @("-e", "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })", $stateFilePath)
  $state = $stateJson | ConvertFrom-Json
  $shortTerm = @($state.thoughtMemory.shortTerm)
  $cluster = @($shortTerm | Where-Object { $_.memoryId -eq "short-aquasynth-boundary-a" })[0]
  $separate = @($shortTerm | Where-Object { $_.memoryId -eq "short-aquasynth-docs" })[0]

  if ($shortTerm.Count -ne 2) {
    throw "Expected two short-term memories after clustering; found $($shortTerm.Count)."
  }
  if ($null -eq $cluster) {
    throw "Cluster did not preserve the original short-term memory id."
  }
  if ($cluster.summary -ne "The next synth-boundary move is inside AquariumSynthHost.") {
    throw "Cluster did not keep the incoming, narrowed thought."
  }
  if (@($cluster.anchorRefs).Count -ne 2) {
    throw "Cluster did not preserve anchors from both short-term records."
  }
  if (-not @($cluster.tags).Contains("cluster:short-term")) {
    throw "Cluster did not mark the short-term cluster."
  }
  if ($null -eq $separate) {
    throw "Different topic in the same repo was merged too aggressively."
  }

  @{
    status = "ok"
    shortTermCount = $shortTerm.Count
    clusteredMemoryId = $cluster.memoryId
    clusteredAnchorCount = @($cluster.anchorRefs).Count
    separateMemoryId = $separate.memoryId
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
