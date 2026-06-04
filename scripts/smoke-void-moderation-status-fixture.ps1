Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-moderation-status-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$operationPath = Join-Path $tempRoot "operation.json"
$fakeBridgePath = Join-Path $tempRoot "fake-bifrost-bridge.mjs"
$fixtureStatusDir = Join-Path $tempRoot "status"
$fixtureLogDir = Join-Path $tempRoot "logs"
$statusPath = Join-Path $fixtureStatusDir "moderation-rumination.json"
$checkPath = Join-Path $tempRoot "check-moderation-status.mjs"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $fakeBridgeSource = @'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const command = process.argv[2];
const contentFileIndex = process.argv.indexOf("--content-file");
const recipientIndex = process.argv.indexOf("--recipient-id");

if (command !== "discord-dm" || contentFileIndex < 0 || recipientIndex < 0) {
  console.error("fake Bifrost bridge expected discord-dm, --content-file, and --recipient-id");
  process.exit(2);
}

const content = readFileSync(resolve(process.argv[contentFileIndex + 1]), "utf8");
const recipientId = process.argv[recipientIndex + 1];
const payload = {
  action: "discord-dm",
  ok: true,
  transport: "bot",
  channelId: "fixture-dm-channel",
  messageId: "fixture-dm-message",
  recipientId,
  preview: content.trim().slice(0, 280),
};

process.stdout.write(JSON.stringify(payload) + "\n");
'@
  [System.IO.File]::WriteAllText($fakeBridgePath, $fakeBridgeSource, [System.Text.UTF8Encoding]::new($false))

  $expiredStrikeOperation = @{
    operation = "upsert_moderation_user_status"
    status = @{
      userId = "fixture-user-id"
      userName = "Fixture User"
      status = "active"
      summary = "Fixture user had one expired strike."
      strikes = @(
        @{
          strikeId = "fixture-expired-strike"
          reason = "posting a fixture rule violation"
          ruleRef = "fixture-rule"
          sourceMessageId = "fixture-message-id"
          channelId = "fixture-channel-id"
          issuedAt = "2026-05-20T00:00:00.000Z"
          expiresAt = "2099-01-01T00:00:00.000Z"
          issuedBy = "Void"
          tags = @("fixture")
        }
      )
      pendingNotices = @()
      updatedAt = "2026-05-20T00:00:00.000Z"
      tags = @("fixture")
    }
  }
  $expiredStrikeOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $operationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $operationPath | Out-Null

  $cursorOperation = @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-future-cursor"
    lastReviewedTimestamp = "2099-06-04T00:00:00.000Z"
  }
  $cursorOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $operationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $operationPath | Out-Null

  $previousStatusDir = $env:VOID_RUMINATION_STATUS_DIR
  $previousLogDir = $env:VOID_RUMINATION_LOG_DIR
  $previousBridgeScript = $env:VOID_BIFROST_BRIDGE_SCRIPT
  $previousDiscordTransport = $env:VOID_DISCORD_TRANSPORT
  $previousDisableRepoCursorAdvance = $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE

  try {
    $env:VOID_RUMINATION_STATUS_DIR = $fixtureStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $fixtureLogDir
    $env:VOID_BIFROST_BRIDGE_SCRIPT = $fakeBridgePath
    $env:VOID_DISCORD_TRANSPORT = "bifrost"
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = "1"

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $stateFilePath -SkipModel | Out-Null
  } finally {
    $env:VOID_RUMINATION_STATUS_DIR = $previousStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $previousLogDir
    $env:VOID_BIFROST_BRIDGE_SCRIPT = $previousBridgeScript
    $env:VOID_DISCORD_TRANSPORT = $previousDiscordTransport
    $env:VOID_RUMINATION_DISABLE_REPO_CURSOR_ADVANCE = $previousDisableRepoCursorAdvance
  }

  if (-not (Test-Path $statusPath)) {
    throw "Rumination status was not written."
  }

  $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  if ($status.status -ne "ok") {
    throw "Rumination did not finish ok: $($status.status)"
  }
  if ([int]$status.deliveredModerationStatusNoticeCount -ne 1) {
    throw "Expected one delivered moderation status notice, got $($status.deliveredModerationStatusNoticeCount)."
  }

  $checkSource = @'
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd());
const require = createRequire(import.meta.url);
const coreDistPath = resolve(repoRoot, "packages/core/dist/index.js");
if (!existsSync(coreDistPath)) {
  throw new Error(`Missing built core package at ${coreDistPath}. Run npm run build first.`);
}
const { loadVoidSelfStateTypedDocuments } = require(coreDistPath);
const state = await loadVoidSelfStateTypedDocuments({ canonicalPath: process.argv[2] });
const userStatus = state.moderationCursor.userStatuses.find((entry) => entry.userId === "fixture-user-id");
if (!userStatus) {
  throw new Error("Fixture moderation user status was not retained.");
}
const strike = userStatus.strikes.find((entry) => entry.strikeId === "fixture-expired-strike");
if (!strike?.expiredAt) {
  throw new Error("Expired strike was not structurally expired.");
}
if (strike.expiresAt !== "2026-05-27T00:00:00.000Z") {
  throw new Error(`Expected canonical one-week expiry, got ${strike.expiresAt}.`);
}
const notice = userStatus.pendingNotices.find((entry) => entry.noticeId === "strike-expired-fixture-user-id-fixture-expired-strike");
if (!notice?.sentAt) {
  throw new Error("Strike expiry notice was not marked sent.");
}
if (notice.channelId !== "fixture-dm-channel") {
  throw new Error(`Expected fixture DM channel, got ${notice.channelId}.`);
}
process.stdout.write(JSON.stringify({
  ok: true,
  userId: userStatus.userId,
  strikeExpiredAt: strike.expiredAt,
  noticeSentAt: notice.sentAt,
}) + "\n");
'@
  [System.IO.File]::WriteAllText($checkPath, $checkSource, [System.Text.UTF8Encoding]::new($false))
  node $checkPath $stateFilePath | Out-Null

  Write-Host "Void moderation status fixture passed: expired strike generated and delivered a user DM status notice."
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
