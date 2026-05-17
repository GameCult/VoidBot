Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-memory-maintenance-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$fakeCodexPath = Join-Path $tempRoot "fake-codex-memory-maintenance.mjs"
$recordOperationPath = Join-Path $tempRoot "record-short-term.json"
$sleepOperationPath = Join-Path $tempRoot "sleep-cycle.json"
$fixtureStatusDir = Join-Path $tempRoot "status"
$fixtureLogDir = Join-Path $tempRoot "logs"
$statusOperationPath = Join-Path $fixtureStatusDir "void-memory-maintenance-operations.json"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $fakeCodexSource = @'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const operationOutputPath = resolve(process.env.VOID_MEMORY_FIXTURE_OPERATION_OUTPUT);
const lastMessageIndex = process.argv.indexOf("-o");
const lastMessagePath = lastMessageIndex >= 0 ? process.argv[lastMessageIndex + 1] : undefined;

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (!prompt.includes("Sleep forces distillation")) {
    console.error("fixture prompt did not contain the sleep distillation contract");
    process.exit(2);
  }

  const operation = {
    operation: "apply_memory_distillation",
    proposalId: "fixture-sleep-distillation",
    sourceMemoryIds: ["fixture-short-term-memory"],
    memory: {
      memoryId: "fixture-durable-memory",
      kind: "project_seam",
      target: {
        kind: "repo",
        id: "AquariumSynthCSharp",
        label: "AquariumSynthCSharp",
      },
      summary: "Workflow cannot own the body.",
      claim: "Runtime state should be owned by the implementation boundary rather than by workflow scripts.",
      tension: "Workflow scripts can orchestrate a pass, but they become compensators when they own the organism's body.",
      actionImplication: "Move authority into typed runtime state before adding more maintenance scripts.",
      anchorRefs: [
        {
          ref: "fixture:aquarium-body-workflow",
          kind: "fixture",
          summary: "Seeded short-term memory for the sleep-maintenance fixture.",
        },
      ],
      evidenceRefs: [],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T01:00:00.000Z",
      tags: [],
    },
    appliedAt: "2026-05-17T01:00:00.000Z",
  };

  mkdirSync(dirname(operationOutputPath), { recursive: true });
  writeFileSync(operationOutputPath, `${JSON.stringify([operation], null, 2)}\n`, "utf8");

  if (lastMessagePath) {
    mkdirSync(dirname(resolve(lastMessagePath)), { recursive: true });
    writeFileSync(lastMessagePath, "fixture memory maintenance wrote one sleep distillation operation\n", "utf8");
  }

  process.stdout.write(JSON.stringify({ type: "fixture", operationCount: 1 }) + "\n");
});
'@
  [System.IO.File]::WriteAllText($fakeCodexPath, $fakeCodexSource, [System.Text.UTF8Encoding]::new($false))

  $recordOperation = @{
    operation = "record_short_term_memory"
    memory = @{
      memoryId = "fixture-short-term-memory"
      kind = "project_seam"
      target = @{
        kind = "repo"
        id = "AquariumSynthCSharp"
        label = "AquariumSynthCSharp"
      }
      summary = "Workflow cannot own the body."
      claim = "Runtime state should be owned by the implementation boundary rather than by workflow scripts."
      tension = "Workflow scripts can orchestrate a pass, but they become compensators when they own the organism's body."
      actionImplication = "Move authority into typed runtime state before adding more maintenance scripts."
      anchorRefs = @(
        @{
          ref = "fixture:aquarium-body-workflow"
          kind = "fixture"
          summary = "Seeded short-term memory for the sleep-maintenance fixture."
        }
      )
      evidenceRefs = @()
      createdAt = "2026-05-17T00:00:00.000Z"
      updatedAt = "2026-05-17T00:00:00.000Z"
      tags = @()
    }
  }
  $sleepOperation = @{
    operation = "update_sleep_cycle"
    sleepCycle = @{
      isNapping = $true
      currentNapStartedAt = "2026-05-17T00:00:00.000Z"
      currentNapEndsAt = "2099-05-17T01:00:00.000Z"
      nextNapStartsAt = "2099-05-17T04:00:00.000Z"
      activeDreamThemes = @("fixture-distillation")
    }
  }

  $recordOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $recordOperationPath -Encoding UTF8
  $sleepOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $sleepOperationPath -Encoding UTF8

  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $recordOperationPath | Out-Null
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $sleepOperationPath | Out-Null

  $previousCodexExecutable = $env:CODEX_EXECUTABLE
  $previousCodexExecArgs = $env:CODEX_EXEC_ARGS
  $previousFixtureOutput = $env:VOID_MEMORY_FIXTURE_OPERATION_OUTPUT
  $previousStatusDir = $env:VOID_STATUS_DIR
  $previousMaintenanceStatusDir = $env:VOID_MEMORY_MAINTENANCE_STATUS_DIR
  $previousMaintenanceLogDir = $env:VOID_MEMORY_MAINTENANCE_LOG_DIR

  try {
    $env:CODEX_EXECUTABLE = "node"
    $env:CODEX_EXEC_ARGS = $fakeCodexPath
    $env:VOID_MEMORY_FIXTURE_OPERATION_OUTPUT = $statusOperationPath
    $env:VOID_STATUS_DIR = $fixtureStatusDir
    $env:VOID_MEMORY_MAINTENANCE_STATUS_DIR = $fixtureStatusDir
    $env:VOID_MEMORY_MAINTENANCE_LOG_DIR = $fixtureLogDir

    node .\scripts\simulate-void-mood.mjs --state-path $stateFilePath --force-memory-maintenance | Out-Null
  } finally {
    $env:CODEX_EXECUTABLE = $previousCodexExecutable
    $env:CODEX_EXEC_ARGS = $previousCodexExecArgs
    $env:VOID_MEMORY_FIXTURE_OPERATION_OUTPUT = $previousFixtureOutput
    $env:VOID_STATUS_DIR = $previousStatusDir
    $env:VOID_MEMORY_MAINTENANCE_STATUS_DIR = $previousMaintenanceStatusDir
    $env:VOID_MEMORY_MAINTENANCE_LOG_DIR = $previousMaintenanceLogDir
  }

  $stateJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $state = $stateJson | ConvertFrom-Json
  $shortTermCount = @($state.thoughtMemory.shortTerm).Count
  $durableCount = @($state.thoughtMemory.memories).Count

  if ($shortTermCount -ne 0) {
    throw "Sleep fixture left $shortTermCount short-term memories behind."
  }
  if ($durableCount -ne 1) {
    throw "Sleep fixture expected one durable memory, found $durableCount."
  }

  $durableMemory = @($state.thoughtMemory.memories)[0]
  if ($durableMemory.summary -ne "Workflow cannot own the body.") {
    throw "Sleep fixture distorted the memory summary."
  }
  if ([string]::IsNullOrWhiteSpace($durableMemory.claim) -or [string]::IsNullOrWhiteSpace($durableMemory.tension) -or [string]::IsNullOrWhiteSpace($durableMemory.actionImplication)) {
    throw "Sleep fixture produced a durable memory without claim, tension, and action implication."
  }
  if (@($durableMemory.anchorRefs).Count -lt 1) {
    throw "Sleep fixture produced a durable memory without anchor refs."
  }

  @{
    status = "ok"
    shortTermCount = $shortTermCount
    durableCount = $durableCount
    durableSummary = $durableMemory.summary
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
