import assert from "node:assert/strict";

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

process.stdout.write("Persona initiative engine smoke passed.\n");
