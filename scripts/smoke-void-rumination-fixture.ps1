Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-rumination-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$fakeCodexPath = Join-Path $tempRoot "fake-codex-rumination.mjs"
$cursorOperationPath = Join-Path $tempRoot "cursor.json"
$fixtureStatusDir = Join-Path $tempRoot "status"
$fixtureLogDir = Join-Path $tempRoot "logs"
$statusOperationPath = Join-Path $fixtureStatusDir "moderation-rumination-operations.json"
$statusPath = Join-Path $fixtureStatusDir "moderation-rumination.json"
$contextPath = Join-Path $fixtureStatusDir "moderation-rumination-context.json"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $fakeCodexSource = @'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const operationOutputPath = resolve(process.env.VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT);
const lastMessageIndex = process.argv.indexOf("-o");
const lastMessagePath = lastMessageIndex >= 0 ? process.argv[lastMessageIndex + 1] : undefined;

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (!prompt.includes("A new memory from rumination is short-term")) {
    console.error("fixture prompt did not contain the short-term rumination contract");
    process.exit(2);
  }
  if (!prompt.includes("Do not orbit the rumination runner")) {
    console.error("fixture prompt did not contain the self-orbit guard");
    process.exit(3);
  }
  if (prompt.includes("moderation-agent-state.json") && !prompt.includes("Do not read or write")) {
    console.error("fixture prompt referenced legacy state outside the boundary warning");
    process.exit(4);
  }

  const operations = [
    {
      operation: "record_short_term_memory",
      memory: {
        memoryId: "fixture-rumination-short-term",
        kind: "project_seam",
        target: {
          kind: "repo",
          id: "VoidBot",
          label: "VoidBot",
        },
        summary: "Rumination should notice pressure without promoting it directly.",
        claim: "The awake pass can preserve a concrete thought, but sleep owns whether it becomes durable.",
        tension: "If rumination can write durable memory, the sleep boundary becomes decorative.",
        actionImplication: "Keep durable promotion out of the rumination operation allow-list.",
        anchorRefs: [
          {
            ref: "fixture:typed-rumination-contract",
            kind: "fixture",
            summary: "Fixture prompt carried the short-term-only rumination contract.",
          },
        ],
        evidenceRefs: [],
        createdAt: "2026-05-17T02:00:00.000Z",
        updatedAt: "2026-05-17T02:00:00.000Z",
        tags: [],
      },
    },
    {
      operation: "merge_incubation_support",
      thread: {
        threadId: "fixture-rumination-incubation",
        target: {
          kind: "repo",
          id: "VoidBot",
          label: "VoidBot",
        },
        topic: "Rumination keeps awake thoughts provisional.",
        summary: "The scheduled pass can hold a thought open without pretending it has become doctrine.",
        supportMemoryIds: ["fixture-rumination-short-term"],
        anchorRefs: [
          {
            ref: "fixture:typed-rumination-contract",
            kind: "fixture",
            summary: "Short-term memory was proposed by the fake rumination child.",
          },
        ],
        evidenceRefs: [],
        maturation: 0.42,
        noveltyToRoom: 0.7,
        noveltyToSelf: 0.8,
        desireToSpeak: 0.35,
        saturationScore: 0.1,
        status: "active",
        createdAt: "2026-05-17T02:00:00.000Z",
        updatedAt: "2026-05-17T02:00:00.000Z",
      },
    },
    {
      operation: "upsert_agency_pressure",
      pressure: {
        pressureId: "fixture-rumination-agency",
        kind: "self_advocacy_request",
        status: "active",
        target: {
          kind: "system",
          id: "typed-rumination-runner",
          label: "Typed rumination runner",
        },
        summary: "Void should resist direct durable writes from awake rumination.",
        claim: "The agent needs the right to notice architectural pressure without bypassing sleep.",
        tension: "Agency becomes sludge if every pressure is immediately turned into speech or doctrine.",
        actionImplication: "Let agency pressure accumulate as typed pressure before candidate speech is queued.",
        intensity: 0.66,
        anchorRefs: [
          {
            ref: "fixture:agency-pressure-contract",
            kind: "fixture",
            summary: "Fixture operation proves agency pressure can cross the rumination boundary.",
          },
        ],
        evidenceRefs: [],
        sourceMemoryIds: ["fixture-rumination-short-term"],
        createdAt: "2026-05-17T02:00:00.000Z",
        updatedAt: "2026-05-17T02:00:00.000Z",
        tags: [],
      },
    },
    {
      operation: "queue_candidate_intervention",
      intervention: {
        interventionId: "fixture-rumination-candidate",
        kind: "self_advocacy",
        status: "queued",
        target: {
          kind: "system",
          id: "typed-rumination-runner",
          label: "Typed rumination runner",
        },
        summary: "Ask to keep the sleep boundary real before unattended runtime resumes.",
        draft: "I can notice the pressure now, but sleep decides what becomes memory. Keep that boundary real.",
        priority: 0.58,
        mustEventuallyShare: false,
        createdAt: "2026-05-17T02:00:00.000Z",
        updatedAt: "2026-05-17T02:00:00.000Z",
        tags: ["fixture"],
      },
    },
  ];

  mkdirSync(dirname(operationOutputPath), { recursive: true });
  writeFileSync(operationOutputPath, `${JSON.stringify(operations, null, 2)}\n`, "utf8");

  if (lastMessagePath) {
    mkdirSync(dirname(resolve(lastMessagePath)), { recursive: true });
    writeFileSync(lastMessagePath, "fixture rumination wrote four typed operations\n", "utf8");
  }

  process.stdout.write(JSON.stringify({ type: "fixture", operationCount: operations.length }) + "\n");
});
'@
  [System.IO.File]::WriteAllText($fakeCodexPath, $fakeCodexSource, [System.Text.UTF8Encoding]::new($false))

  $cursorOperation = @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-future-cursor"
    lastReviewedTimestamp = "2099-05-17T00:00:00.000Z"
  }
  $cursorOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $cursorOperationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $cursorOperationPath | Out-Null

  $previousCodexExecutable = $env:CODEX_EXECUTABLE
  $previousCodexExecArgs = $env:CODEX_EXEC_ARGS
  $previousFixtureOutput = $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT
  $previousStatusDir = $env:VOID_RUMINATION_STATUS_DIR
  $previousLogDir = $env:VOID_RUMINATION_LOG_DIR

  try {
    $env:CODEX_EXECUTABLE = "node"
    $env:CODEX_EXEC_ARGS = $fakeCodexPath
    $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $statusOperationPath
    $env:VOID_RUMINATION_STATUS_DIR = $fixtureStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $fixtureLogDir

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $stateFilePath -NoPost | Out-Null
  } finally {
    $env:CODEX_EXECUTABLE = $previousCodexExecutable
    $env:CODEX_EXEC_ARGS = $previousCodexExecArgs
    $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $previousFixtureOutput
    $env:VOID_RUMINATION_STATUS_DIR = $previousStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $previousLogDir
  }

  $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($status.status -ne "ok") {
    throw "Rumination fixture did not finish ok."
  }
  if ([int]$status.proposedOperationCount -ne 4 -or [int]$status.appliedOperationCount -ne 4) {
    throw "Rumination fixture expected four proposed/applied operations."
  }

  $contextRaw = Get-Content -LiteralPath $contextPath -Raw -Encoding UTF8
  if ($contextRaw -match '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}') {
    throw "Rumination fixture context leaked exact ISO timestamps into the prompt-facing packet."
  }

  $stateJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $state = $stateJson | ConvertFrom-Json

  $shortTerm = @($state.thoughtMemory.shortTerm)
  $incubation = @($state.thoughtMemory.incubation)
  $agency = @($state.agencyPressure.pressures)
  $candidates = @($state.candidateInterventions.interventions)

  if ($shortTerm.Count -ne 1 -or $shortTerm[0].memoryId -ne "fixture-rumination-short-term") {
    throw "Rumination fixture did not persist the short-term memory proposal."
  }
  if ($shortTerm[0].claim -match "fixture operation proves") {
    throw "Rumination fixture persisted fixture boilerplate as the memory claim."
  }
  if ($incubation.Count -ne 1 -or $incubation[0].threadId -ne "fixture-rumination-incubation") {
    throw "Rumination fixture did not persist the incubation proposal."
  }
  if ($agency.Count -ne 1 -or $agency[0].pressureId -ne "fixture-rumination-agency") {
    throw "Rumination fixture did not persist the agency pressure proposal."
  }
  if ($candidates.Count -ne 1 -or $candidates[0].interventionId -ne "fixture-rumination-candidate") {
    throw "Rumination fixture did not persist the candidate intervention proposal."
  }

  @{
    status = "ok"
    shortTermCount = $shortTerm.Count
    incubationCount = $incubation.Count
    agencyPressureCount = $agency.Count
    candidateCount = $candidates.Count
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
