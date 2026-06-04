Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-rumination-bifrost-transport-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$operationPath = Join-Path $tempRoot "operation.json"
$fakeBridgePath = Join-Path $tempRoot "fake-bifrost-bridge.mjs"
$fixtureStatusDir = Join-Path $tempRoot "status"
$fixtureLogDir = Join-Path $tempRoot "logs"
$statusPath = Join-Path $fixtureStatusDir "moderation-rumination.json"
$checkPath = Join-Path $tempRoot "check-bifrost-transport.mjs"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $fakeBridgeSource = @'
import { readFileSync } from "node:fs";

const command = process.argv[2];
const contentFileIndex = process.argv.indexOf("--content-file");
const content = contentFileIndex >= 0 ? readFileSync(process.argv[contentFileIndex + 1], "utf8").trim() : "";

if (command === "discord-post") {
  const channelIndex = process.argv.indexOf("--channel-id");
  const replyIndex = process.argv.indexOf("--reply-to-message-id");
  process.stdout.write(JSON.stringify({
    action: "discord-post",
    ok: true,
    channelId: process.argv[channelIndex + 1],
    messageId: "fixture-bifrost-message",
    transport: "webhook",
    replyToMessageId: replyIndex >= 0 ? process.argv[replyIndex + 1] : undefined,
    preview: content.slice(0, 280),
  }) + "\n");
} else if (command === "discord-dm") {
  const recipientIndex = process.argv.indexOf("--recipient-id");
  process.stdout.write(JSON.stringify({
    action: "discord-dm",
    ok: true,
    recipientId: process.argv[recipientIndex + 1],
    channelId: "fixture-bifrost-dm-channel",
    messageId: "fixture-bifrost-dm-message",
    transport: "bot",
    preview: content.slice(0, 280),
  }) + "\n");
} else {
  console.error(`unexpected fake bridge command ${command}`);
  process.exit(2);
}
'@
  [System.IO.File]::WriteAllText($fakeBridgePath, $fakeBridgeSource, [System.Text.UTF8Encoding]::new($false))

  $cursorOperation = @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-future-cursor"
    lastReviewedTimestamp = "2099-06-04T00:00:00.000Z"
  }
  $cursorOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $operationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $operationPath | Out-Null

  $candidateOperation = @{
    operation = "queue_candidate_intervention"
    intervention = @{
      interventionId = "fixture-bifrost-candidate"
      kind = "direct_reply"
      status = "queued"
      target = @{
        kind = "room"
        id = "fixture-channel"
        label = "Fixture channel"
      }
      summary = "Bifrost should own public Discord transport."
      draft = "Bifrost owns this public crossing; Void just brought the sentence."
      deliveryTarget = @{
        mode = "channel"
        channelId = "fixture-channel-id"
        replyToMessageId = "fixture-reply-id"
        personaName = "Void"
      }
      priority = 0.9
      mustEventuallyShare = $false
      createdAt = "2026-06-04T10:00:00.000Z"
      updatedAt = "2026-06-04T10:00:00.000Z"
      tags = @("fixture")
    }
  }
  $candidateOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $operationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $operationPath | Out-Null

  $statusOperation = @{
    operation = "upsert_moderation_user_status"
    status = @{
      userId = "fixture-user-id"
      userName = "Fixture User"
      status = "active"
      summary = "Fixture user needs a status notice."
      strikes = @(
        @{
          strikeId = "fixture-active-strike"
          reason = "posting a fixture rule violation"
          ruleRef = "fixture-rule"
          issuedAt = "2026-06-04T10:00:00.000Z"
          expiresAt = "2026-06-11T10:00:00.000Z"
          tags = @("fixture")
        }
      )
      pendingNotices = @(
        @{
          noticeId = "fixture-status-notice"
          kind = "strike_added"
          summary = "Strike added"
          body = "Moderation status update: fixture strike added."
          createdAt = "2026-06-04T10:00:00.000Z"
          tags = @("fixture")
        }
      )
      updatedAt = "2026-06-04T10:00:00.000Z"
      tags = @("fixture")
    }
  }
  $statusOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $operationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $operationPath | Out-Null

  $previousStatusDir = $env:VOID_RUMINATION_STATUS_DIR
  $previousLogDir = $env:VOID_RUMINATION_LOG_DIR
  $previousTransport = $env:VOID_DISCORD_TRANSPORT
  $previousBridgeScript = $env:VOID_BIFROST_BRIDGE_SCRIPT
  $previousDisableRepoCursorAdvance = $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE

  try {
    $env:VOID_RUMINATION_STATUS_DIR = $fixtureStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $fixtureLogDir
    $env:VOID_DISCORD_TRANSPORT = "bifrost"
    $env:VOID_BIFROST_BRIDGE_SCRIPT = $fakeBridgePath
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = "1"

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $stateFilePath -SkipModel | Out-Null
  } finally {
    $env:VOID_RUMINATION_STATUS_DIR = $previousStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $previousLogDir
    $env:VOID_DISCORD_TRANSPORT = $previousTransport
    $env:VOID_BIFROST_BRIDGE_SCRIPT = $previousBridgeScript
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = $previousDisableRepoCursorAdvance
  }

  $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  if ($status.status -ne "ok") {
    throw "Rumination did not finish ok: $($status.status)"
  }
  if ($status.discordTransport -ne "bifrost") {
    throw "Expected bifrost transport, got $($status.discordTransport)."
  }
  if ([int]$status.deliveredCandidateCount -ne 1) {
    throw "Expected one delivered candidate, got $($status.deliveredCandidateCount)."
  }
  if ([int]$status.deliveredModerationStatusNoticeCount -ne 1) {
    throw "Expected one delivered moderation status notice, got $($status.deliveredModerationStatusNoticeCount)."
  }

  $checkSource = @'
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const coreDistPath = resolve(process.cwd(), "packages/core/dist/index.js");
if (!existsSync(coreDistPath)) {
  throw new Error(`Missing built core package at ${coreDistPath}. Run npm run build first.`);
}
const { loadVoidSelfStateTypedDocuments } = require(coreDistPath);
const state = await loadVoidSelfStateTypedDocuments({ canonicalPath: process.argv[2] });
const candidate = state.candidateInterventions.interventions.find((entry) => entry.interventionId === "fixture-bifrost-candidate");
if (candidate) {
  throw new Error("Bifrost-delivered candidate stayed live.");
}
const receipt = state.speechReceipts.recentReceipts.find((entry) => entry.candidateInterventionId === "fixture-bifrost-candidate");
if (!receipt || receipt.transport !== "webhook" || receipt.channelId !== "fixture-channel-id") {
  throw new Error("Bifrost candidate receipt was not recorded correctly.");
}
const status = state.moderationCursor.userStatuses.find((entry) => entry.userId === "fixture-user-id");
const notice = status?.pendingNotices.find((entry) => entry.noticeId === "fixture-status-notice");
if (!notice?.sentAt || notice.channelId !== "fixture-bifrost-dm-channel" || notice.messageId !== "fixture-bifrost-dm-message") {
  throw new Error("Bifrost moderation notice receipt was not recorded correctly.");
}
process.stdout.write(JSON.stringify({ ok: true, receiptTransport: receipt.transport, noticeChannelId: notice.channelId }) + "\n");
'@
  [System.IO.File]::WriteAllText($checkPath, $checkSource, [System.Text.UTF8Encoding]::new($false))
  node $checkPath $stateFilePath | Out-Null

  Write-Host "Void Bifrost transport fixture passed: public speech and moderation DM receipts came from Bifrost."
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
