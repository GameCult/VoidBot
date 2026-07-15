import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  queueAgentHeartbeatMention,
  readRepoFaceMentionInbox,
} from "@voidbot/core";

import {
  advanceInitiativeClockFromWallClock,
  applyActiveTurnFreeze,
  applyPendingMentionPriority,
  applySemanticPressureProjection,
  reconcileParticipants,
  recordDryRunSelection,
  recordTurnFailedToStart,
  recordTurnStarted,
  selectReadyParticipants,
  type InitiativeParticipant,
  type InitiativeState,
} from "../apps/persona-scheduler/dist/initiative-engine.js";
import {
  readPersonaSchedulerState,
  writePersonaSchedulerState,
} from "../apps/persona-scheduler/dist/state-store.js";
import {
  parsePersonaTurnIdentity,
  staleActiveTurnThresholdMs,
} from "../apps/persona-scheduler/dist/active-turn-source.js";
import {
  newestUnpromptedTurnQueuedAt,
  readDiscordActivitySnapshot,
} from "../apps/persona-scheduler/dist/discord-activity-source.js";
import {
  fetchChannelSnapshots,
  fetchRecentDiscordMessages,
} from "../apps/persona-scheduler/dist/turn-context-source.js";

function participant(identityId: string, nextTurnAt: number): InitiativeParticipant {
  return {
    identityId,
    participantKind: "repo_face",
    turnKind: "repo_face_rumination",
    repoName: identityId,
    displayName: identityId,
    initiativeSpeed: 1,
    status: "active",
    currentLoad: 0,
    nextTurnAt,
    baseRecoveryMinutes: 30,
    reactionBias: 1,
    interruptThreshold: 0.6,
    groups: [],
    heat: 1,
    dynamicHeat: 1,
    responsePressure: 0,
    responsePressureEvidence: [],
    semanticInterruptReceipts: [],
    effectiveSpeed: 1,
    queuedCount: 0,
    constraints: [],
  };
}

const state: InitiativeState = {
  initiativeClock: 10,
  lastTickAt: "2026-07-15T20:00:00.000Z",
  participants: [participant("quiet", 9), participant("mentioned", 30), participant("napping", 9)],
  pendingMentions: [{ identityId: "mentioned" }],
  history: [],
};

advanceInitiativeClockFromWallClock(state, new Date("2026-07-15T20:02:30.000Z"));
assert.equal(state.initiativeClock, 12.5, "wall time advances the scheduler clock once");
applyPendingMentionPriority(state);
assert.equal(state.participants[1].nextTurnAt, 12.5, "a mention makes its participant ready without queuing it");

const selected = selectReadyParticipants(
  state,
  2,
  new Set(),
  new Map([["napping", { isNapping: true }]]),
  { enabled: false, active: false },
  Date.parse("2026-07-15T20:02:30.000Z"),
);
assert.deepEqual(selected.map((entry) => entry.identityId), ["mentioned", "quiet"], "mentions lead while unmentioned naps remain asleep");

const cooled = selectReadyParticipants(
  state,
  2,
  new Set(),
  new Map(),
  { enabled: true, active: true, nextUnpromptedTurnAllowedAt: "2026-07-15T21:00:00.000Z" },
  Date.parse("2026-07-15T20:02:30.000Z"),
);
assert.deepEqual(cooled.map((entry) => entry.identityId), ["mentioned"], "idle cooling suppresses unprompted turns but never pending mentions");

const blocked = { ...participant("existing", 44), status: "blocked" as const, currentLoad: 1, activeJobId: "job-1" };
const reconciled = reconcileParticipants({
  existing: [blocked],
  specs: [
    {
      id: "existing",
      participantKind: "native_persona",
      turnKind: "repo_face_rumination",
      repoName: "New body",
      displayName: "Existing",
      allowedChannelIds: ["room"],
      channelSpeedMultiplier: 2,
    },
    {
      id: "channel-less",
      participantKind: "repo_face",
      turnKind: "repo_face_rumination",
      repoName: "No mouth",
      displayName: "No mouth",
      allowedChannelIds: [],
      channelSpeedMultiplier: 1,
    },
  ],
  speedOverrides: { existing: 1.5 },
  heatOverrides: { "identity:existing": 0.5 },
  initiativeClock: 40,
  baseRecoveryMinutes: 20,
  globalHeat: 1.2,
});
assert.equal(reconciled[0].status, "blocked", "reconciliation preserves an explicit manual block");
assert.equal(reconciled[0].activeJobId, "job-1", "reconciliation preserves live load ownership");
assert.equal(reconciled[0].nextTurnAt, 44, "reconciliation preserves initiative position");
assert.equal(reconciled[0].initiativeSpeed, 3, "operator speed and channel multiplier are projected once");
assert.equal(reconciled[0].heat, 0.6, "global and identity heat compose in the scheduler owner");
assert.equal(reconciled[1].status, "blocked", "a new Face without any mouth fails closed");

const freezeState: InitiativeState = {
  initiativeClock: 50,
  participants: [],
  pendingMentions: [],
  history: [],
};
const frozen = applyActiveTurnFreeze(participant("working", 40), "job-live", freezeState, new Set());
assert.equal(frozen.currentLoad, 1, "an active queue witness freezes initiative");
assert.equal(frozen.activeJobId, "job-live", "the scheduler records the external job witness without transferring ownership");
assert.equal(frozen.activeTurnStartedAt, 50, "freeze begins at the scheduler clock when no earlier start exists");

const completed = new Set<string>();
const recovered = applyActiveTurnFreeze(frozen, undefined, freezeState, completed);
assert.equal(recovered.currentLoad, 0, "loss of the active witness releases scheduler load");
assert.equal(recovered.activeJobId, undefined, "completed work cannot remain an initiative owner");
assert.equal(recovered.nextTurnAt, 80, "recovery begins after completion using scheduler-owned recovery math");
assert.deepEqual([...completed], ["working"], "a just-completed participant cannot be selected in the same tick");
assert.equal(freezeState.history.at(-1)?.type, "turn_completed", "the state machine records its own completion transition");

const queueState: InitiativeState = { initiativeClock: 70, participants: [], pendingMentions: [], history: [] };
const queued = participant("queued", 68);
recordTurnStarted({
  participant: queued,
  state: queueState,
  queuedAt: "2026-07-15T21:00:00.000Z",
  activeJobId: "job-queued",
  requestMessageId: "agent-turn:queued:test",
  pendingMentionCount: 2,
});
assert.equal(queued.currentLoad, 1, "queue success freezes the participant through one scheduler commit");
assert.equal(queued.queuedCount, 1, "queue success advances its counter once");
assert.equal(queueState.history.at(-1)?.type, "queued", "queue success and its history witness share one owner");

recordTurnFailedToStart({ participant: queued, state: queueState, queuedAt: "2026-07-15T21:01:00.000Z", reason: "actuator refused" });
assert.equal(queued.currentLoad, 0, "queue failure cannot leave false scheduler load");
assert.equal(queueState.history.at(-1)?.type, "turn_failed_to_start", "queue failure is recorded by the state owner");

const inspected = participant("inspected", 69);
recordDryRunSelection(inspected, queueState, "2026-07-15T21:02:00.000Z", 0);
assert.equal(inspected.nextTurnAt, 100, "dry-run selection uses the same recovery ownership without claiming active load");
assert.equal(inspected.currentLoad, 0, "inspection cannot impersonate a live job");
assert.equal(parsePersonaTurnIdentity("agent-turn:nibu:2026-07-15"), "nibu", "the queue adapter recognizes current Persona turn witnesses");
assert.equal(parsePersonaTurnIdentity("unrelated:job"), undefined, "unrelated jobs cannot freeze Persona initiative");
assert.equal(staleActiveTurnThresholdMs(20 * 60_000), 60 * 60_000, "runtime timeout expands the stale-claim boundary");
assert.equal(staleActiveTurnThresholdMs(5 * 60_000), 45 * 60_000, "stale recovery never becomes an impatient repair loop");
assert.equal(newestUnpromptedTurnQueuedAt([
  { type: "queued", queuedAt: "2026-07-15T19:00:00.000Z", pendingMentionCount: 0 },
  { type: "queued", queuedAt: "2026-07-15T20:00:00.000Z", pendingMentionCount: 1 },
]), "2026-07-15T19:00:00.000Z", "direct attention cannot consume the unprompted-turn cooling window");

const activitySnapshot = await readDiscordActivitySnapshot({
  botToken: "test-token",
  channelIds: ["aquarium", "aquarium", undefined],
  policy: { enabled: true, idleAfterMinutes: 30, recoveryMinutes: 90 },
  history: [{ type: "queued", queuedAt: "2026-07-15T19:30:00.000Z", pendingMentionCount: 0 }],
  now: new Date("2026-07-15T21:00:00.000Z"),
  fetchImpl: async () => new Response(JSON.stringify([
    {
      id: "bot-message",
      author: { id: "bot", username: "VoidBot", bot: true },
      content: "machine noise",
      timestamp: "2026-07-15T20:55:00.000Z",
    },
    {
      id: "human-message",
      author: { id: "human", username: "Human", global_name: "Operator" },
      content: "still here",
      timestamp: "2026-07-15T20:45:00.000Z",
    },
  ]), { status: 200, headers: { "content-type": "application/json" } }),
});
assert.deepEqual(activitySnapshot.checkedChannelIds, ["aquarium"], "activity acquisition deduplicates its explicit watched channels");
assert.deepEqual(activitySnapshot.observedHumanMessages.map((message) => message.id), ["human-message"], "bot output cannot impersonate human room activity");
assert.equal(activitySnapshot.active, false, "recent human activity keeps idle cooling inactive");
assert.equal(activitySnapshot.idleForMinutes, 15, "idle duration is a neutral wall-clock observation");
assert.equal(activitySnapshot.nextUnpromptedTurnAllowedAt, "2026-07-15T21:00:00.000Z", "the activity source derives the next unprompted window without mutating initiative");

const pressureState: InitiativeState = {
  initiativeClock: 50,
  participants: [participant("awakened", 90), participant("unmoved", 90)],
  pendingMentions: [],
  history: [],
};
applySemanticPressureProjection({
  state: pressureState,
  projections: [{
    identityId: "awakened",
    pressure: 0.8,
    interrupt: true,
    evidence: [{
      messageId: "pressure-message",
      observedAt: "2026-07-15T20:59:00.000Z",
      similarity: 0.9,
      contribution: 0.8,
    }],
  }],
  projectedAt: new Date("2026-07-15T21:00:00.000Z"),
});
assert.equal(pressureState.participants[0].nextTurnAt, 50, "only the initiative engine may turn semantic evidence into readiness");
assert.equal(pressureState.participants[0].dynamicHeat, 2.2, "the engine owns pressure-derived recovery heat");
assert.deepEqual(pressureState.participants[0].semanticInterruptReceipts, ["pressure-message"], "semantic interruption is consumed exactly once by scheduler state");
assert.equal(pressureState.participants[1].responsePressure, 0, "missing projections explicitly cool stale pressure");
assert.equal(pressureState.history.at(-1)?.type, "semantic_response_interrupt", "the state owner records the semantic transition");

const contextMessages = await fetchRecentDiscordMessages({
  botToken: "test-token",
  channelId: "aquarium",
  limit: 15,
  ignoreBotMessages: true,
  fetchImpl: async () => new Response(JSON.stringify([
    {
      id: "newer",
      author: { id: "human-2", username: "Second" },
      content: "second",
      timestamp: "2026-07-15T21:00:00.000Z",
      attachments: [{ id: "text", filename: "note.txt", url: "https://example.invalid/note.txt" }],
    },
    {
      id: "ignored-bot",
      author: { id: "bot", username: "Mirror", bot: true },
      content: "mirror",
      timestamp: "2026-07-15T20:59:00.000Z",
    },
    {
      id: "older",
      author: { id: "human-1", username: "First", global_name: "First Human" },
      content: "first",
      timestamp: "2026-07-15T20:58:00.000Z",
    },
  ]), { status: 200, headers: { "content-type": "application/json" } }),
});
assert.deepEqual(contextMessages.map((message) => message.id), ["older", "newer"], "turn context is raw chronological Discord evidence with configured bot mirrors removed");
assert.equal(contextMessages[1].attachments?.[0].kind, "other", "non-image attachments remain inspectable without becoming media-cache writes");

const failedSnapshot = await fetchChannelSnapshots({
  botToken: "test-token",
  channelIds: ["primary", "nearby"],
  primaryChannelId: "primary",
  limit: 6,
  now: new Date("2026-07-15T21:00:00.000Z"),
  fetchImpl: async () => new Response("nope", { status: 503 }),
});
assert.equal(failedSnapshot[0].messages[0].id, "snapshot-error:nearby", "nearby-channel failure is returned as explicit evidence rather than aborting the turn");
assert.equal(failedSnapshot[0].messages[0].timestamp, "2026-07-15T21:00:00.000Z", "context-source failure witnesses use the caller's observation clock");

const stateDirectory = await mkdtemp(join(tmpdir(), "voidbot-persona-scheduler-"));
try {
  const statePath = join(stateDirectory, "scheduler.json");
  const absent = await readPersonaSchedulerState(statePath);
  assert.equal(absent.initiativeClock, 0, "an absent scheduler store starts one explicit new state");
  absent.participants.push(participant("persisted", 7));
  await writePersonaSchedulerState(statePath, absent);
  const persisted = await readPersonaSchedulerState(statePath);
  assert.equal(persisted.participants[0].identityId, "persisted", "atomic scheduler persistence round-trips its state");
  assert.ok((await readFile(statePath, "utf8")).endsWith("\n"), "the promoted state is a complete inspectable document");

  await writeFile(statePath, "{broken", "utf8");
  await assert.rejects(
    readPersonaSchedulerState(statePath),
    /refusing to replace it with empty state/,
    "malformed persistent state must fail closed instead of erasing the scheduler mind",
  );

  await writeFile(statePath, JSON.stringify({
    schemaVersion: "legacy",
    baseIntervalMinutes: 90,
    participants: [{ identityId: "legacy", repoName: "Legacy", displayName: "Legacy" }],
    pendingMentions: [],
    history: [],
  }), "utf8");
  const migrated = await readPersonaSchedulerState(statePath, Date.parse("2026-07-15T20:00:00.000Z"));
  assert.equal(migrated.baseRecoveryMinutes, 30, "legacy cadence migrates under the scheduler store owner");
  assert.equal(migrated.participants[0].participantKind, "repo_face", "legacy participants receive current scheduling anatomy");
  assert.equal(migrated.history.at(-1)?.type, "migrated", "migration leaves a durable state witness");

  const mentionStatePath = join(stateDirectory, "mentions.json");
  const mentionInput = {
    statePath: mentionStatePath,
    identityId: "nibu",
    channelId: "aquarium",
    messageId: "message-1",
    authorId: "human-1",
    content: "Nibu, look at this.",
    visiblePrompt: "Look at this.",
    queuedAt: "2026-07-15T20:03:00.000Z",
  };
  const firstMention = await queueAgentHeartbeatMention(mentionInput);
  const duplicateMention = await queueAgentHeartbeatMention(mentionInput);
  assert.equal(firstMention.queued, true, "the bot creates one immutable attention command");
  assert.equal(duplicateMention.queued, false, "the typed inbox deduplicates the same Discord source message");
  assert.equal((await readRepoFaceMentionInbox(mentionStatePath)).length, 1, "mention ingress is a typed inbox, not a scheduler-state rewrite");
  const withMention = await readPersonaSchedulerState(mentionStatePath);
  assert.equal(withMention.pendingMentions[0].identityId, "nibu", "the scheduler store alone ingests attention commands");
  await writePersonaSchedulerState(mentionStatePath, withMention);
  assert.equal((await readRepoFaceMentionInbox(mentionStatePath)).length, 0, "inbox acknowledgement follows durable scheduler commit");
  assert.equal((await readPersonaSchedulerState(mentionStatePath)).pendingMentions.length, 1, "acknowledgement cannot erase pending attention");
} finally {
  await rm(stateDirectory, { recursive: true, force: true });
}

process.stdout.write("Persona initiative engine smoke passed.\n");
