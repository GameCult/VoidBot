Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-moderation-heartbeat-policy-fixture-" + [guid]::NewGuid().ToString("n"))
$fakeCodexPath = Join-Path $tempRoot "fake-codex-heartbeat-policy.mjs"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Set-TestEnvironment {
  param(
    [Parameter(Mandatory = $true)][string] $OperationOutputPath,
    [Parameter(Mandatory = $true)][string] $StatusDir,
    [Parameter(Mandatory = $true)][string] $LogDir
  )

  $script:previousCodexExecutable = $env:CODEX_EXECUTABLE
  $script:previousCodexExecArgs = $env:CODEX_EXEC_ARGS
  $script:previousFixtureOutput = $env:VOID_HEARTBEAT_FIXTURE_OPERATION_OUTPUT
  $script:previousStatusDir = $env:VOID_RUMINATION_STATUS_DIR
  $script:previousLogDir = $env:VOID_RUMINATION_LOG_DIR
  $script:previousPolicyDryRun = $env:VOID_MODERATION_POLICY_DRY_RUN
  $script:previousPolicyMode = $env:VOID_MODERATION_ENFORCEMENT_MODE

  $env:CODEX_EXECUTABLE = "node"
  $env:CODEX_EXEC_ARGS = $fakeCodexPath
  $env:VOID_HEARTBEAT_FIXTURE_OPERATION_OUTPUT = $OperationOutputPath
  $env:VOID_RUMINATION_STATUS_DIR = $StatusDir
  $env:VOID_RUMINATION_LOG_DIR = $LogDir
  $env:VOID_MODERATION_POLICY_DRY_RUN = "1"
  $env:VOID_MODERATION_ENFORCEMENT_MODE = "policy"
}

function Restore-TestEnvironment {
  $env:CODEX_EXECUTABLE = $script:previousCodexExecutable
  $env:CODEX_EXEC_ARGS = $script:previousCodexExecArgs
  $env:VOID_HEARTBEAT_FIXTURE_OPERATION_OUTPUT = $script:previousFixtureOutput
  $env:VOID_RUMINATION_STATUS_DIR = $script:previousStatusDir
  $env:VOID_RUMINATION_LOG_DIR = $script:previousLogDir
  $env:VOID_MODERATION_POLICY_DRY_RUN = $script:previousPolicyDryRun
  $env:VOID_MODERATION_ENFORCEMENT_MODE = $script:previousPolicyMode
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

const operationOutputPath = resolve(process.env.VOID_HEARTBEAT_FIXTURE_OPERATION_OUTPUT);
const lastMessageIndex = process.argv.indexOf("-o");
const lastMessagePath = lastMessageIndex >= 0 ? process.argv[lastMessageIndex + 1] : undefined;

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  for (const required of ["Void Moderation Heartbeat", "config/discord-server-rules.md", "infringement:<type>"]) {
    if (!prompt.includes(required)) {
      console.error(`heartbeat prompt missing ${required}`);
      process.exit(2);
    }
  }
  for (const forbidden of ["repoActivity", "shortTermMemories", "candidateInterventions", "styles/void-default.md"]) {
    if (prompt.includes(forbidden)) {
      console.error(`heartbeat prompt included forbidden rumination surface ${forbidden}`);
      process.exit(3);
    }
  }

  const operations = [{
    operation: "upsert_open_case",
    case: {
      sourceMessageId: "1513515503329480734",
      status: "pending",
      summary: "Lobo declared war on Metacrat and framed the conflict as a katana fight in #general.",
      authorId: "1511062277254545499",
      authorName: "Lobo",
      channelId: "113786069023064068",
      messageUrl: "https://discord.com/channels/113786069023064068/113786069023064068/1513515503329480734",
      whyItMatters: "The policy treats credible threats and weaponized declarations of violent conflict as instant-ban safety violations.",
      createdAt: "2026-06-08T12:10:15.752Z",
      lastTouchedAt: "2026-06-08T12:10:15.752Z",
      tags: [
        "safety:urgent",
        "infringement:safety_threat",
        "moderation:instaban",
        "fixture:lobo-threat"
      ]
    }
  }];

  mkdirSync(dirname(operationOutputPath), { recursive: true });
  writeFileSync(operationOutputPath, `${JSON.stringify(operations, null, 2)}\n`, "utf8");

  if (lastMessagePath) {
    mkdirSync(dirname(resolve(lastMessagePath)), { recursive: true });
    writeFileSync(lastMessagePath, "fixture heartbeat policy\n", "utf8");
  }

  process.stdout.write(JSON.stringify({ type: "fixture", operationCount: operations.length }) + "\n");
});
'@
  [System.IO.File]::WriteAllText($fakeCodexPath, $fakeCodexSource, [System.Text.UTF8Encoding]::new($false))

  $fixtureRoot = Join-Path $tempRoot "handled"
  $stateFilePath = Join-Path $fixtureRoot "void-self-state.cc"
  $statusDir = Join-Path $fixtureRoot "status"
  $logDir = Join-Path $fixtureRoot "logs"
  New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
  New-SeededState -StateFilePath $stateFilePath

  try {
    Set-TestEnvironment -OperationOutputPath (Join-Path $statusDir "moderation-heartbeat-operations.json") -StatusDir $statusDir -LogDir $logDir
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $stateFilePath -ModerationHeartbeatOnly -NoPost | Out-Null
  } finally {
    Restore-TestEnvironment
  }

  $status = Get-Content -LiteralPath (Join-Path $statusDir "moderation-heartbeat.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($status.status -ne "ok" -or $status.mode -ne "moderation_heartbeat") {
    throw "Heartbeat policy fixture did not finish in moderation_heartbeat mode."
  }
  $action = @($status.moderationEnforcement.actions | Where-Object { $_.status -eq "instaban_applied" }) | Select-Object -First 1
  if ($null -eq $action -or $action.moderationResult.dryRun -ne $true -or $action.moderationResult.action -ne "ban") {
    throw "Heartbeat policy fixture did not produce a dry-run instaban action."
  }

  $stateJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $state = $stateJson | ConvertFrom-Json
  $case = @($state.moderationCursor.openCases | Where-Object { $_.sourceMessageId -eq "1513515503329480734" }) | Select-Object -First 1
  if ($null -eq $case -or -not @($case.tags).Contains("infringement:safety_threat")) {
    throw "Heartbeat policy fixture did not persist the tagged infringement case."
  }

  @{
    status = "ok"
    mode = $status.mode
    enforcementStatus = $action.status
    action = $action.moderationResult.action
    dryRun = $action.moderationResult.dryRun
  } | ConvertTo-Json -Compress
} finally {
  Restore-TestEnvironment
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
