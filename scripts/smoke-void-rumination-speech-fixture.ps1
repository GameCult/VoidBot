Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-rumination-speech-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$fakeCodexPath = Join-Path $tempRoot "fake-codex-rumination-speech.mjs"
$fakeBridgePath = Join-Path $tempRoot "fake-bifrost-bridge.mjs"
$cursorOperationPath = Join-Path $tempRoot "cursor.json"
$fixtureStatusDir = Join-Path $tempRoot "status"
$fixtureLogDir = Join-Path $tempRoot "logs"
$statusOperationPath = Join-Path $fixtureStatusDir "moderation-rumination-operations.json"
$statusPath = Join-Path $fixtureStatusDir "moderation-rumination.json"

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
  if (!prompt.includes("The parent runner owns posting and receipts")) {
    console.error("fixture prompt did not contain the parent-owned speech contract");
    process.exit(2);
  }

  const operations = [
    {
      operation: "queue_candidate_intervention",
      intervention: {
        interventionId: "fixture-parent-owned-speech",
        kind: "ripe_thought_share",
        status: "queued",
        target: {
          kind: "room",
          id: "fixture-channel",
          label: "Fixture channel",
        },
        summary: "Parent-owned speech should close the action loop.",
        draft: "This is a fixture sentence proving the parent owns the mouth.",
        deliveryTarget: {
          mode: "channel",
          channelId: "fixture-channel-id",
          replyToMessageId: "fixture-message-id",
          personaName: "Void",
        },
        priority: 0.9,
        mustEventuallyShare: false,
        createdAt: "2026-05-17T03:00:00.000Z",
        updatedAt: "2026-05-17T03:00:00.000Z",
        tags: ["fixture"],
      },
    },
    {
      operation: "queue_candidate_intervention",
      intervention: {
        interventionId: "fixture-duplicate-same-reply-target",
        kind: "direct_reply",
        status: "queued",
        target: {
          kind: "room",
          id: "fixture-channel",
          label: "Fixture channel",
        },
        summary: "Duplicate same-target candidate should retire when the sibling speaks.",
        draft: "This duplicate should never be delivered after the same reply target is answered.",
        deliveryTarget: {
          mode: "channel",
          channelId: "fixture-channel-id",
          replyToMessageId: "fixture-message-id",
          personaName: "Void",
        },
        priority: 0.7,
        mustEventuallyShare: false,
        createdAt: "2026-05-17T03:00:01.000Z",
        updatedAt: "2026-05-17T03:00:01.000Z",
        tags: ["fixture", "duplicate"],
      },
    },
    {
      operation: "queue_candidate_intervention",
      intervention: {
        interventionId: "fixture-already-answered-reply-target",
        kind: "direct_reply",
        status: "queued",
        target: {
          kind: "room",
          id: "fixture-channel",
          label: "Fixture channel",
        },
        summary: "Already-answered reply target should retire before delivery.",
        draft: "This should retire because the reply target already has a receipt.",
        deliveryTarget: {
          mode: "channel",
          channelId: "fixture-channel-id",
          replyToMessageId: "fixture-answered-message-id",
          personaName: "Void",
        },
        priority: 0.95,
        mustEventuallyShare: false,
        createdAt: "2026-05-17T03:00:02.000Z",
        updatedAt: "2026-05-17T03:00:02.000Z",
        tags: ["fixture", "already-answered"],
      },
    },
  ];

  mkdirSync(dirname(operationOutputPath), { recursive: true });
  writeFileSync(operationOutputPath, `${JSON.stringify(operations, null, 2)}\n`, "utf8");

  if (lastMessagePath) {
    mkdirSync(dirname(resolve(lastMessagePath)), { recursive: true });
    writeFileSync(lastMessagePath, "fixture rumination queued one deliverable candidate\n", "utf8");
  }

  process.stdout.write(JSON.stringify({ type: "fixture", operationCount: operations.length }) + "\n");
});
'@
  [System.IO.File]::WriteAllText($fakeCodexPath, $fakeCodexSource, [System.Text.UTF8Encoding]::new($false))

  $fakeBridgeSource = @'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const command = process.argv[2];
const contentFileIndex = process.argv.indexOf("--content-file");
const channelIndex = process.argv.indexOf("--channel-id");
const replyIndex = process.argv.indexOf("--reply-to-message-id");
const personaIndex = process.argv.indexOf("--persona-name");
const personaAvatarIndex = process.argv.indexOf("--persona-avatar-url");

if (command !== "discord-post" || contentFileIndex < 0 || channelIndex < 0) {
  console.error("fake Bifrost bridge expected discord-post, --content-file, and --channel-id");
  process.exit(2);
}

const content = readFileSync(resolve(process.argv[contentFileIndex + 1]), "utf8");
const channelId = process.argv[channelIndex + 1];
const replyToMessageId = replyIndex >= 0 ? process.argv[replyIndex + 1] : undefined;
const personaName = personaIndex >= 0 ? process.argv[personaIndex + 1] : undefined;
const personaAvatarUrl = personaAvatarIndex >= 0 ? process.argv[personaAvatarIndex + 1] : undefined;
const payload = {
  action: "discord-post",
  ok: true,
  channelId,
  messageId: "fixture-bifrost-speech-message",
  transport: personaName ? "webhook" : "bot",
  replyToMessageId,
  personaName,
  personaAvatarUrl,
  preview: content.trim().slice(0, 280),
};

process.stdout.write(JSON.stringify(payload) + "\n");
'@
  [System.IO.File]::WriteAllText($fakeBridgePath, $fakeBridgeSource, [System.Text.UTF8Encoding]::new($false))

  $cursorOperation = @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-future-cursor"
    lastReviewedTimestamp = "2099-05-17T00:00:00.000Z"
  }
  $cursorOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $cursorOperationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $cursorOperationPath | Out-Null

  $openCaseOperation = @{
    operation = "upsert_open_case"
    case = @{
      sourceMessageId = "fixture-answered-message-id"
      status = "pending"
      summary = "Metacrat asked a fixture question, and Void has not answered yet."
      authorId = "fixture-author"
      authorName = "Metacrat"
      channelId = "fixture-channel-id"
      createdAt = "2026-05-17T02:57:00.000Z"
      lastTouchedAt = "2026-05-17T02:57:00.000Z"
      tags = @("fixture")
    }
  }
  $openCaseOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $cursorOperationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $cursorOperationPath | Out-Null

  $priorReceiptOperation = @{
    operation = "record_delivery_receipt"
    receipt = @{
      receiptKey = "fixture-previous-answer"
      sentAt = "2026-05-17T02:58:00.000Z"
      mode = "channel"
      transport = "webhook"
      channelId = "fixture-channel-id"
      replyToMessageId = "fixture-answered-message-id"
      personaName = "Void"
      preview = "An earlier answer already closed this exact reply target."
      contentLength = 56
      chunkCount = 1
    }
  }
  $priorReceiptOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $cursorOperationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $cursorOperationPath | Out-Null

  $previousCodexExecutable = $env:CODEX_EXECUTABLE
  $previousCodexExecArgs = $env:CODEX_EXEC_ARGS
  $previousFixtureOutput = $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT
  $previousStatusDir = $env:VOID_RUMINATION_STATUS_DIR
  $previousLogDir = $env:VOID_RUMINATION_LOG_DIR
  $previousBridgeScript = $env:VOID_BIFROST_BRIDGE_SCRIPT
  $previousDiscordTransport = $env:VOID_DISCORD_TRANSPORT
  $previousDisableRepoCursorAdvance = $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE
  $previousVoidAvatarUrl = $env:DISCORD_PERSONA_AVATAR_URL_VOID

  try {
    $env:CODEX_EXECUTABLE = "node"
    $env:CODEX_EXEC_ARGS = $fakeCodexPath
    $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $statusOperationPath
    $env:VOID_RUMINATION_STATUS_DIR = $fixtureStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $fixtureLogDir
    $env:VOID_BIFROST_BRIDGE_SCRIPT = $fakeBridgePath
    $env:VOID_DISCORD_TRANSPORT = "bifrost"
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = "1"
    $env:DISCORD_PERSONA_AVATAR_URL_VOID = "https://example.invalid/void-fixture-avatar.png"

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $stateFilePath | Out-Null
  } finally {
    $env:CODEX_EXECUTABLE = $previousCodexExecutable
    $env:CODEX_EXEC_ARGS = $previousCodexExecArgs
    $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $previousFixtureOutput
    $env:VOID_RUMINATION_STATUS_DIR = $previousStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $previousLogDir
    $env:VOID_BIFROST_BRIDGE_SCRIPT = $previousBridgeScript
    $env:VOID_DISCORD_TRANSPORT = $previousDiscordTransport
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = $previousDisableRepoCursorAdvance
    $env:DISCORD_PERSONA_AVATAR_URL_VOID = $previousVoidAvatarUrl
  }

  $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($status.status -ne "ok") {
    $failureMessage = if ($null -ne $status.PSObject.Properties["failureMessage"]) { [string]$status.failureMessage } else { "(no failure message)" }
    throw "Speech fixture did not finish ok: $failureMessage"
  }
  if ([int]$status.proposedOperationCount -ne 3 -or [int]$status.appliedOperationCount -ne 5 -or [int]$status.deliveredCandidateCount -ne 1) {
    throw "Speech fixture expected three proposals, five applied operations, and one delivered candidate."
  }

  $stateJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $state = $stateJson | ConvertFrom-Json
  $candidate = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-parent-owned-speech" }) | Select-Object -First 1
  $duplicateCandidate = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-duplicate-same-reply-target" }) | Select-Object -First 1
  $alreadyAnsweredCandidate = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-already-answered-reply-target" }) | Select-Object -First 1
  $receipt = @(
    $state.speechReceipts.recentReceipts |
      Where-Object {
        $property = $_.PSObject.Properties["candidateInterventionId"]
        $null -ne $property -and $property.Value -eq "fixture-parent-owned-speech"
      }
  ) | Select-Object -First 1

  if ($null -ne $candidate) {
    throw "Speech fixture left the delivered candidate in current state."
  }
  if ($null -ne $duplicateCandidate) {
    throw "Speech fixture left the duplicate same-target candidate in current state."
  }
  if ($null -ne $alreadyAnsweredCandidate) {
    throw "Speech fixture left the already-answered reply target candidate in current state."
  }
  if ($receipt.channelId -ne "fixture-channel-id" -or $receipt.replyToMessageId -ne "fixture-message-id") {
    throw "Speech fixture did not preserve the delivery receipt target."
  }
  if ($receipt.personaName -ne "Void" -or $receipt.personaAvatarUrl -ne "https://example.invalid/void-fixture-avatar.png") {
    throw "Speech fixture did not resolve the configured Void persona avatar at delivery time."
  }
  if ($receipt.candidateInterventionId -ne "fixture-parent-owned-speech") {
    throw "Speech fixture did not link the delivery receipt back to the spoken candidate."
  }
  $answeredCase = @($state.moderationCursor.openCases | Where-Object { $_.sourceMessageId -eq "fixture-answered-message-id" }) | Select-Object -First 1
  if ($null -ne $answeredCase) {
    throw "Speech fixture left an answered open case in current state."
  }
  $lastMessage = Get-Content -LiteralPath (Join-Path $fixtureStatusDir "moderation-rumination-last-message.txt") -Raw -Encoding UTF8
  if ($lastMessage -notmatch "deliveredCandidates=1") {
    throw "Speech fixture did not refresh the final rumination message summary."
  }

  @{
    status = "ok"
    candidateRetained = $null -ne $candidate
    staleDuplicateRetained = $null -ne $alreadyAnsweredCandidate
    receiptCount = @($state.speechReceipts.recentReceipts).Count
    deliveredCandidateCount = [int]$status.deliveredCandidateCount
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
