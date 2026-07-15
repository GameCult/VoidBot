import assert from "node:assert/strict";

import {
  advanceInitiativeClockFromWallClock,
  applyPendingMentionPriority,
  reconcileParticipants,
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

process.stdout.write("Persona initiative engine smoke passed.\n");
