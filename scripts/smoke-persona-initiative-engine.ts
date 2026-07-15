import assert from "node:assert/strict";

import {
  advanceInitiativeClockFromWallClock,
  applyPendingMentionPriority,
  selectReadyParticipants,
  type InitiativeParticipant,
  type InitiativeState,
} from "../apps/persona-scheduler/dist/initiative-engine.js";

function participant(identityId: string, nextTurnAt: number): InitiativeParticipant {
  return {
    identityId,
    participantKind: "repo_face",
    status: "active",
    currentLoad: 0,
    nextTurnAt,
    baseRecoveryMinutes: 30,
    reactionBias: 1,
    effectiveSpeed: 1,
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

process.stdout.write("Persona initiative engine smoke passed.\n");
