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
