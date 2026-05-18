Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-rumination-speech-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$fakeCodexPath = Join-Path $tempRoot "fake-codex-rumination-speech.mjs"
$fakeSendPath = Join-Path $tempRoot "fake-send-discord-message.mjs"
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

  $fakeSendSource = @'
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const statusDir = resolve(process.env.VOID_STATUS_DIR);
const contentFileIndex = process.argv.indexOf("--content-file");
const channelIndex = process.argv.indexOf("--channel-id");
const replyIndex = process.argv.indexOf("--reply-to");
const personaIndex = process.argv.indexOf("--persona-name");

if (contentFileIndex < 0 || channelIndex < 0) {
  console.error("fake sender expected --content-file and --channel-id");
  process.exit(2);
}

const content = readFileSync(resolve(process.argv[contentFileIndex + 1]), "utf8");
const channelId = process.argv[channelIndex + 1];
const replyToMessageId = replyIndex >= 0 ? process.argv[replyIndex + 1] : undefined;
const personaName = personaIndex >= 0 ? process.argv[personaIndex + 1] : undefined;
const payload = {
  sentAt: "2026-05-17T03:01:00.000Z",
  mode: "channel",
  transport: personaName ? "webhook" : "bot",
  channelId,
  replyToMessageId,
  personaName,
  contentLength: content.trim().length,
  chunkCount: 1,
  preview: content.trim().slice(0, 280),
};

mkdirSync(statusDir, { recursive: true });
writeFileSync(resolve(statusDir, "void-last-speech.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
writeFileSync(resolve(statusDir, "void-speech-log.jsonl"), `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "a" });
process.stdout.write(JSON.stringify({ ok: true, mode: "channel", channelId }) + "\n");
'@
  [System.IO.File]::WriteAllText($fakeSendPath, $fakeSendSource, [System.Text.UTF8Encoding]::new($false))

  $cursorOperation = @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-future-cursor"
    lastReviewedTimestamp = "2099-05-17T00:00:00.000Z"
  }
  $cursorOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $cursorOperationPath -Encoding UTF8
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
  $previousSendScript = $env:VOID_SEND_DISCORD_SCRIPT
  $previousDisableRepoCursorAdvance = $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE

  try {
    $env:CODEX_EXECUTABLE = "node"
    $env:CODEX_EXEC_ARGS = $fakeCodexPath
    $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $statusOperationPath
    $env:VOID_RUMINATION_STATUS_DIR = $fixtureStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $fixtureLogDir
    $env:VOID_SEND_DISCORD_SCRIPT = $fakeSendPath
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = "1"

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $stateFilePath | Out-Null
  } finally {
    $env:CODEX_EXECUTABLE = $previousCodexExecutable
    $env:CODEX_EXEC_ARGS = $previousCodexExecArgs
    $env:VOID_RUMINATION_FIXTURE_OPERATION_OUTPUT = $previousFixtureOutput
    $env:VOID_RUMINATION_STATUS_DIR = $previousStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $previousLogDir
    $env:VOID_SEND_DISCORD_SCRIPT = $previousSendScript
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = $previousDisableRepoCursorAdvance
  }

  $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($status.status -ne "ok") {
    throw "Speech fixture did not finish ok."
  }
  if ([int]$status.proposedOperationCount -ne 3 -or [int]$status.appliedOperationCount -ne 5 -or [int]$status.deliveredCandidateCount -ne 1) {
    throw "Speech fixture expected three proposals, five applied operations, and one delivered candidate."
  }

  $stateJson = node -e "const core=require('./packages/core/dist/index.js'); core.loadVoidSelfStateTypedDocuments({canonicalPath: process.argv[1]}).then((state)=>console.log(JSON.stringify(state))).catch((error)=>{ console.error(error); process.exit(1); })" $stateFilePath
  $state = $stateJson | ConvertFrom-Json
  $candidate = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-parent-owned-speech" })[0]
  $duplicateCandidate = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-duplicate-same-reply-target" })[0]
  $alreadyAnsweredCandidate = @($state.candidateInterventions.interventions | Where-Object { $_.interventionId -eq "fixture-already-answered-reply-target" })[0]
  $receipt = @(
    $state.speechReceipts.recentReceipts |
      Where-Object {
        $property = $_.PSObject.Properties["candidateInterventionId"]
        $null -ne $property -and $property.Value -eq "fixture-parent-owned-speech"
      }
  )[0]

  if ($candidate.status -ne "spoken") {
    throw "Speech fixture did not mark the candidate spoken."
  }
  if ($duplicateCandidate.status -ne "retired") {
    throw "Speech fixture did not retire the duplicate same-target candidate."
  }
  if ($alreadyAnsweredCandidate.status -ne "retired") {
    throw "Speech fixture did not retire the already-answered reply target candidate."
  }
  if ($receipt.channelId -ne "fixture-channel-id" -or $receipt.replyToMessageId -ne "fixture-message-id") {
    throw "Speech fixture did not preserve the delivery receipt target."
  }
  if ($receipt.candidateInterventionId -ne "fixture-parent-owned-speech") {
    throw "Speech fixture did not link the delivery receipt back to the spoken candidate."
  }
  $lastMessage = Get-Content -LiteralPath (Join-Path $fixtureStatusDir "moderation-rumination-last-message.txt") -Raw -Encoding UTF8
  if ($lastMessage -notmatch "deliveredCandidates=1") {
    throw "Speech fixture did not refresh the final rumination message summary."
  }

  @{
    status = "ok"
    candidateStatus = $candidate.status
    staleDuplicateStatus = $alreadyAnsweredCandidate.status
    receiptCount = @($state.speechReceipts.recentReceipts).Count
    deliveredCandidateCount = [int]$status.deliveredCandidateCount
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
