Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-rumination-speech-pressure-fixture-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Invoke-NodeChecked {
  param([Parameter(Mandatory = $true)][string[]] $Arguments)

  $output = & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node command failed: node $($Arguments -join ' ')"
  }
  return $output
}

function Write-JsonFixture {
  param(
    [Parameter(Mandatory = $true)] $Value,
    [Parameter(Mandatory = $true)] [string] $Path
  )

  $Value | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Initialize-State {
  param([Parameter(Mandatory = $true)][string] $StateFilePath)

  $cursorPath = Join-Path (Split-Path -Parent $StateFilePath) "cursor.json"
  Write-JsonFixture -Path $cursorPath -Value @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-future-cursor"
    lastReviewedTimestamp = "2099-05-17T00:00:00.000Z"
  }
  Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $StateFilePath, "--operation-file", $cursorPath) | Out-Null

  $pressurePath = Join-Path (Split-Path -Parent $StateFilePath) "pressure.json"
  Write-JsonFixture -Path $pressurePath -Value @{
    operation = "upsert_agency_pressure"
    pressure = @{
      pressureId = "fixture-pressure-wants-a-mouth"
      kind = "world_advocacy_request"
      status = "active"
      target = @{ kind = "repo"; id = "Aquarium-Engine"; label = "Aquarium-Engine" }
      summary = "A repeated repo-bound pressure should not stay mute forever."
      claim = "A strong agency pressure that keeps recurring needs a candidate speech or an explicit cool-down reason."
      tension = "Not every pressure deserves an immediate post, but silent [] makes the desire to speak decorative."
      actionImplication = "Queue a deferred candidate if timing is unclear instead of dropping the pressure on the floor."
      intensity = 0.72
      anchorRefs = @(
        @{
          ref = "fixture:speech-pressure"
          kind = "fixture"
          summary = "Fixture pressure proves the rumination runner enforces speech accountability."
        }
      )
      evidenceRefs = @()
      sourceMemoryIds = @()
      createdAt = "2026-05-17T04:00:00.000Z"
      updatedAt = "2026-05-17T04:00:00.000Z"
      tags = @("repo:Aquarium-Engine", "topic:speech-pressure")
    }
  }
  Invoke-NodeChecked -Arguments @(".\scripts\void-self-state.mjs", "apply-operation", "--canonical", $StateFilePath, "--operation-file", $pressurePath) | Out-Null
}

function Write-FakeCodex {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][string] $Mode
  )

  $source = @'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const operationOutputPath = resolve(process.env.VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT);
const lastMessageIndex = process.argv.indexOf("-o");
const lastMessagePath = lastMessageIndex >= 0 ? process.argv[lastMessageIndex + 1] : undefined;
const mode = "__MODE__";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (!prompt.includes("speechPressureObligations")) {
    console.error("fixture prompt did not expose speech pressure obligations");
    process.exit(2);
  }
  if (!prompt.includes("source_pressure:<pressureId>")) {
    console.error("fixture prompt did not explain pressure source tags");
    process.exit(3);
  }

  const operations = mode === "candidate" ? [
    {
      operation: "queue_candidate_intervention",
      intervention: {
        interventionId: "fixture-pressure-candidate",
        kind: "world_advocacy",
        status: "queued",
        target: {
          kind: "repo",
          id: "Aquarium-Engine",
          label: "Aquarium-Engine"
        },
        summary: "Name the repeated pressure without forcing an immediate post.",
        draft: "I keep circling the AquariumSynthHost boundary. I think the next honest move is to cut that Faust authority out of the host or explicitly defend why it belongs there.",
        priority: 0.82,
        mustEventuallyShare: true,
        createdAt: "2026-05-17T04:05:00.000Z",
        updatedAt: "2026-05-17T04:05:00.000Z",
        tags: ["fixture", "source_pressure:fixture-pressure-wants-a-mouth"]
      }
    }
  ] : [];

  mkdirSync(dirname(operationOutputPath), { recursive: true });
  writeFileSync(operationOutputPath, `${JSON.stringify(operations, null, 2)}\n`, "utf8");

  if (lastMessagePath) {
    mkdirSync(dirname(resolve(lastMessagePath)), { recursive: true });
    writeFileSync(lastMessagePath, `fixture mode ${mode}\n`, "utf8");
  }
});
'@
  $source = $source.Replace("__MODE__", $Mode)

  [System.IO.File]::WriteAllText($Path, $source, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-RuminationFixture {
  param(
    [Parameter(Mandatory = $true)][string] $CaseName,
    [Parameter(Mandatory = $true)][string] $Mode
  )

  $caseRoot = Join-Path $tempRoot $CaseName
  $stateFilePath = Join-Path $caseRoot "void-self-state.cc"
  $fakeCodexPath = Join-Path $caseRoot "fake-codex.mjs"
  $fixtureStatusDir = Join-Path $caseRoot "status"
  $fixtureLogDir = Join-Path $caseRoot "logs"
  $statusOperationPath = Join-Path $fixtureStatusDir "moderation-rumination-operations.json"
  New-Item -ItemType Directory -Force -Path $caseRoot | Out-Null

  Initialize-State -StateFilePath $stateFilePath
  Write-FakeCodex -Path $fakeCodexPath -Mode $Mode

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

    $stdoutPath = Join-Path $caseRoot "runner.stdout.txt"
    $stderrPath = Join-Path $caseRoot "runner.stderr.txt"
    $process = Start-Process -FilePath "powershell" -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ".\scripts\run-void-moderator-rumination.ps1",
      "-StateFilePath",
      $stateFilePath,
      "-NoPost"
    ) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait -PassThru
    $exitCode = $process.ExitCode
  } finally {
    $env:CODEX_EXECUTABLE = $previousCodexExecutable
    $env:CODEX_EXEC_ARGS = $previousCodexExecArgs
    $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $previousFixtureOutput
    $env:VOID_RUMINATION_STATUS_DIR = $previousStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $previousLogDir
  }

  return @{
    exitCode = $exitCode
    stateFilePath = $stateFilePath
    statusPath = Join-Path $fixtureStatusDir "moderation-rumination.json"
  }
}

try {
  $silent = Invoke-RuminationFixture -CaseName "silent" -Mode "silent"
  if ($silent.exitCode -eq 0) {
    throw "Silent speech-pressure fixture unexpectedly passed."
  }

  $silentStatus = Get-Content -LiteralPath $silent.statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($silentStatus.failureMessage -notmatch "requires a candidate intervention") {
    throw "Silent speech-pressure fixture failed for the wrong reason: $($silentStatus.failureMessage)"
  }

  $candidate = Invoke-RuminationFixture -CaseName "candidate" -Mode "candidate"
  if ($candidate.exitCode -ne 0) {
    $candidateStatus = Get-Content -LiteralPath $candidate.statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    throw "Candidate speech-pressure fixture failed: $($candidateStatus.failureMessage)"
  }

  $stateJson = Invoke-NodeChecked -Arguments @("-e", "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })", $candidate.stateFilePath)
  $state = $stateJson | ConvertFrom-Json
  $queued = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-pressure-candidate" })[0]
  if ($null -eq $queued -or $queued.status -ne "queued" -or -not @($queued.tags).Contains("source_pressure:fixture-pressure-wants-a-mouth")) {
    throw "Candidate speech-pressure fixture did not preserve the queued pressure candidate."
  }

  @{
    status = "ok"
    silentExitCode = $silent.exitCode
    candidateStatus = $queued.status
    candidatePriority = $queued.priority
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
