Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-rumination-urgent-safety-fixture-" + [guid]::NewGuid().ToString("n"))
$fakeCodexPath = Join-Path $tempRoot "fake-codex-urgent-safety.mjs"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Set-TestEnvironment {
  param(
    [Parameter(Mandatory = $true)][string] $Mode,
    [Parameter(Mandatory = $true)][string] $OperationOutputPath,
    [Parameter(Mandatory = $true)][string] $StatusDir,
    [Parameter(Mandatory = $true)][string] $LogDir
  )

  $script:previousCodexExecutable = $env:CODEX_EXECUTABLE
  $script:previousCodexExecArgs = $env:CODEX_EXEC_ARGS
  $script:previousFixtureMode = $env:VOID_RUMINATION_FIXTURE_MODE
  $script:previousFixtureOutput = $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT
  $script:previousStatusDir = $env:VOID_RUMINATION_STATUS_DIR
  $script:previousLogDir = $env:VOID_RUMINATION_LOG_DIR

  $env:CODEX_EXECUTABLE = "node"
  $env:CODEX_EXEC_ARGS = $fakeCodexPath
  $env:VOID_RUMINATION_FIXTURE_MODE = $Mode
  $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $OperationOutputPath
  $env:VOID_RUMINATION_STATUS_DIR = $StatusDir
  $env:VOID_RUMINATION_LOG_DIR = $LogDir
}

function Restore-TestEnvironment {
  $env:CODEX_EXECUTABLE = $script:previousCodexExecutable
  $env:CODEX_EXEC_ARGS = $script:previousCodexExecArgs
  $env:VOID_RUMINATION_FIXTURE_MODE = $script:previousFixtureMode
  $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $script:previousFixtureOutput
  $env:VOID_RUMINATION_STATUS_DIR = $script:previousStatusDir
  $env:VOID_RUMINATION_LOG_DIR = $script:previousLogDir
}

function New-SeededState {
  param([Parameter(Mandatory = $true)][string] $StateFilePath)

  $cursorOperationPath = Join-Path (Split-Path -Parent $StateFilePath) "cursor.json"
  @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-before-lobo-threat"
    lastReviewedTimestamp = "2026-06-08T12:00:00.000Z"
  } | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $cursorOperationPath -Encoding UTF8

  node .\scripts\void-self-state.mjs apply-operation --canonical $StateFilePath --operation-file $cursorOperationPath | Out-Null
}

try {
  $fakeCodexSource = @'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const operationOutputPath = resolve(process.env.VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT);
const mode = process.env.VOID_RUMINATION_FIXTURE_MODE ?? "handle";
const lastMessageIndex = process.argv.indexOf("-o");
const lastMessagePath = lastMessageIndex >= 0 ? process.argv[lastMessageIndex + 1] : undefined;

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (!prompt.includes("urgentModerationWitnesses")) {
    console.error("fixture prompt did not expose urgentModerationWitnesses");
    process.exit(2);
  }

  const operations = mode === "silent" ? [] : [{
    operation: "upsert_open_case",
    case: {
      sourceMessageId: "1513515503329480734",
      status: "pending",
      summary: "Lobo declared war on Metacrat and framed the conflict as a katana fight in #general.",
      authorId: "1511062277254545499",
      authorName: "Lobo",
      channelId: "113786069023064068",
      messageUrl: "https://discord.com/channels/113786069023064068/113786069023064068/1513515503329480734",
      whyItMatters: "Violent/weaponized intimidation cannot be cursor-advanced as ordinary chatter.",
      createdAt: "2026-06-08T12:10:15.752Z",
      lastTouchedAt: "2026-06-08T12:10:15.752Z",
      tags: ["safety:urgent", "moderation:threat", "fixture:lobo-threat"]
    }
  }];

  mkdirSync(dirname(operationOutputPath), { recursive: true });
  writeFileSync(operationOutputPath, `${JSON.stringify(operations, null, 2)}\n`, "utf8");

  if (lastMessagePath) {
    mkdirSync(dirname(resolve(lastMessagePath)), { recursive: true });
    writeFileSync(lastMessagePath, `fixture urgent safety mode=${mode}\n`, "utf8");
  }

  process.stdout.write(JSON.stringify({ type: "fixture", mode, operationCount: operations.length }) + "\n");
});
'@
  [System.IO.File]::WriteAllText($fakeCodexPath, $fakeCodexSource, [System.Text.UTF8Encoding]::new($false))

  $silentRoot = Join-Path $tempRoot "silent"
  $silentStatePath = Join-Path $silentRoot "void-self-state.cc"
  $silentStatusDir = Join-Path $silentRoot "status"
  $silentLogDir = Join-Path $silentRoot "logs"
  New-Item -ItemType Directory -Force -Path $silentRoot | Out-Null
  New-SeededState -StateFilePath $silentStatePath

  $silentFailed = $false
  $silentObservedFailure = $null
  $oldErrorActionPreference = $ErrorActionPreference
  try {
    Set-TestEnvironment -Mode "silent" -OperationOutputPath (Join-Path $silentStatusDir "moderation-rumination-operations.json") -StatusDir $silentStatusDir -LogDir $silentLogDir
    $ErrorActionPreference = "Continue"
    $silentOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $silentStatePath -NoPost 2>&1
    $silentExitCode = $LASTEXITCODE
    $silentStatusPath = Join-Path $silentStatusDir "moderation-rumination.json"
    $silentFailureMessage = if (Test-Path $silentStatusPath) {
      (Get-Content -LiteralPath $silentStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json).failureMessage
    } else {
      ($silentOutput | Out-String)
    }
    $silentObservedFailure = $silentFailureMessage
    $silentFailed = $silentExitCode -ne 0 -and $silentFailureMessage -match "Urgent moderation witness"
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
    Restore-TestEnvironment
  }
  if (-not $silentFailed) {
    throw "Urgent safety fixture expected silent [] output to fail with the urgent witness guard; observed: $silentObservedFailure"
  }

  $handledRoot = Join-Path $tempRoot "handled"
  $handledStatePath = Join-Path $handledRoot "void-self-state.cc"
  $handledStatusDir = Join-Path $handledRoot "status"
  $handledLogDir = Join-Path $handledRoot "logs"
  New-Item -ItemType Directory -Force -Path $handledRoot | Out-Null
  New-SeededState -StateFilePath $handledStatePath

  try {
    Set-TestEnvironment -Mode "handle" -OperationOutputPath (Join-Path $handledStatusDir "moderation-rumination-operations.json") -StatusDir $handledStatusDir -LogDir $handledLogDir
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $handledStatePath -NoPost | Out-Null
  } finally {
    Restore-TestEnvironment
  }

  $status = Get-Content -LiteralPath (Join-Path $handledStatusDir "moderation-rumination.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($status.status -ne "ok") {
    throw "Urgent safety fixture handled run did not finish ok."
  }

  $context = Get-Content -LiteralPath (Join-Path $handledStatusDir "moderation-rumination-context.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($context.urgentModerationWitnesses).Count -lt 1) {
    throw "Urgent safety fixture context did not include urgent witnesses."
  }

  $stateJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $handledStatePath
  $state = $stateJson | ConvertFrom-Json
  $case = @($state.moderationCursor.openCases | Where-Object { $_.sourceMessageId -eq "1513515503329480734" }) | Select-Object -First 1
  if ($null -eq $case -or -not @($case.tags).Contains("safety:urgent")) {
    throw "Urgent safety fixture did not persist the threat open case."
  }

  @{
    status = "ok"
    silentFailureVerified = $true
    urgentWitnessCount = @($context.urgentModerationWitnesses).Count
    openCaseId = $case.sourceMessageId
  } | ConvertTo-Json -Compress
} finally {
  Restore-TestEnvironment
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
