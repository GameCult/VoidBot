import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  queueAgentHeartbeatMention,
  ensureVoidSelfStateIdentityProfile,
  readRepoFaceMentionInbox,
  resolveRepoFaceHeartbeatDebugProjectionPath,
  resolveRepoFaceHeartbeatStatePath,
  type CreateJobInput,
  type JobQueue,
  type RepoDiscordIdentity,
  type RepoFacePendingMention,
} from "@voidbot/core";
import type { JobRecord } from "@voidbot/shared";

import {
  advanceInitiativeClockFromWallClock,
  applyActiveTurnFreeze,
  applyPendingMentionPriority,
  applySchedulerControls,
  applySemanticPressureProjection,
  consumePendingMentions,
  finalizeSchedulerTick,
  reconcileParticipants,
  reconcileInitiativeParticipants,
  recordDryRunSelection,
  recordSchedulerSkip,
  recordTurnFailedToStart,
  recordTurnStarted,
  selectReadyParticipants,
  type InitiativeParticipant,
  type InitiativeState,
} from "../apps/persona-scheduler/dist/initiative-engine.js";
import {
  newPersonaSchedulerState,
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
import { readBifrostGovernanceDigest } from "../apps/persona-scheduler/dist/bifrost-governance-source.js";
import { submitPersonaTurn } from "../apps/persona-scheduler/dist/turn-actuator.js";
import {
  buildPersonaChannelPlan,
  newestPendingMentionChannel,
  personaChannelSpeedMultiplier,
} from "../apps/persona-scheduler/dist/turn-routing.js";
import {
  readAgentSwarmPause,
  readSwarmControlState,
} from "../apps/persona-scheduler/dist/control-source.js";
import { readRepoActivity } from "../apps/persona-scheduler/dist/repo-activity-source.js";
import { readPersonaStateObservation } from "../apps/persona-scheduler/dist/persona-state-source.js";
import { readPersonaMemoryRecall } from "../apps/persona-scheduler/dist/persona-memory-context-source.js";
import { composePersonaMemoryPacket, projectPersonaMemorySurface, renderPersonaPressureSections, renderPersonaSelfMaintenancePressure, renderPersonaTypedStateSections } from "../apps/persona-scheduler/dist/persona-memory-projector.js";
import { readPersonaCuriosityEvidence } from "../apps/persona-scheduler/dist/persona-curiosity-context-source.js";
import { projectPersonaCuriosityContext } from "../apps/persona-scheduler/dist/persona-curiosity-projector.js";
import { projectPersonaConversation, renderPersonaRoomTopicSaturation } from "../apps/persona-scheduler/dist/persona-conversation-projector.js";
import { buildPersonaJurisdictionDiveDirective, buildPersonaTurnPrompt } from "../apps/persona-scheduler/dist/persona-turn-prompt-projector.js";
import { assemblePersonaTurn } from "../apps/persona-scheduler/dist/persona-turn-assembler.js";
import { buildVoidModerationLaunchCommand, launchVoidModerationTurn, waitForVoidModerationHandshake } from "../apps/persona-scheduler/dist/void-moderation-turn-actuator.js";
import { readGlobalAgentDoctrine } from "../apps/persona-scheduler/dist/global-agent-doctrine-source.js";
import { projectGamecultPersonaState } from "../apps/persona-scheduler/dist/persona-standard-state-projector.js";
import { projectPersonaStatePacket } from "../apps/persona-scheduler/dist/persona-state-packet-projector.js";
import { extractLastPersonaProjectionMessage, isRetryablePersonaProjectionFailure } from "../apps/persona-scheduler/dist/persona-text-projection-actuator.js";
import { observePersonaRoomTexture, projectPersonaSocialContext, renderPersonaHumanClarityPressure, renderPersonaHumanPronounFacts, renderPersonaRoomWeather, renderPersonaSocialGraph } from "../apps/persona-scheduler/dist/persona-social-context-projector.js";
import { readPersonaHumanPronounGuidance } from "../apps/persona-scheduler/dist/persona-social-context-source.js";

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

assert.equal(extractLastPersonaProjectionMessage([
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final projection" } }),
].join("\n")), "final projection", "text projection actuator owns Codex event decoding");
assert.equal(isRetryablePersonaProjectionFailure({ stdout: "", stderr: "HTTP 429 too many requests" }), true, "capacity failures may advance to the next configured projection model");
assert.equal(isRetryablePersonaProjectionFailure({ stdout: "", stderr: "prompt contract rejected" }), false, "semantic or contract failures cannot hide behind model fallback");

advanceInitiativeClockFromWallClock(state, new Date("2026-07-15T20:02:30.000Z"));
assert.equal(state.initiativeClock, 12.5, "wall time advances the scheduler clock once");
applyPendingMentionPriority(state);
assert.equal(state.participants[1].nextTurnAt, 12.5, "a mention makes its participant ready without queuing it");
state.participants[0].responsePressure = state.participants[0].interruptThreshold;

const selected = selectReadyParticipants(
  state,
  2,
  new Set(),
  new Map([["napping", { isNapping: true }]]),
  {},
  Date.parse("2026-07-15T20:02:30.000Z"),
);
assert.deepEqual(selected.map((entry) => entry.identityId), ["mentioned", "quiet"], "mentions lead while one pressure-backed unprompted participant is admitted");

state.participants[0].responsePressure = 0;
const clockOnly = selectReadyParticipants(state, 2, new Set(), new Map(), {}, Date.parse("2026-07-15T20:02:30.000Z"));
assert.deepEqual(clockOnly.map((entry) => entry.identityId), ["mentioned"], "elapsed wall clock alone cannot authorize an unprompted model turn");

const cooled = selectReadyParticipants(
  state,
  2,
  new Set(),
  new Map(),
  { nextUnpromptedTurnAllowedAt: "2026-07-15T21:00:00.000Z" },
  Date.parse("2026-07-15T20:02:30.000Z"),
);
assert.deepEqual(cooled.map((entry) => entry.identityId), ["mentioned"], "idle cooling suppresses unprompted turns but never pending mentions");

const activeRoomCadence = selectReadyParticipants(
  state,
  2,
  new Set(),
  new Map(),
  { nextUnpromptedTurnAllowedAt: "2026-07-15T21:00:00.000Z" },
  Date.parse("2026-07-15T20:03:30.000Z"),
);
assert.deepEqual(activeRoomCadence.map((entry) => entry.identityId), ["mentioned"], "normal room activity cannot bypass the global unprompted cadence");

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

const disabledCoolingSnapshot = await readDiscordActivitySnapshot({
  botToken: "test-token",
  channelIds: ["aquarium"],
  policy: { enabled: false, idleAfterMinutes: 30, recoveryMinutes: 90 },
  history: [{ type: "queued", queuedAt: "2026-07-15T19:30:00.000Z", pendingMentionCount: 0 }],
  now: new Date("2026-07-15T20:00:00.000Z"),
  fetchImpl: async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
});
assert.equal(disabledCoolingSnapshot.nextUnpromptedTurnAllowedAt, "2026-07-15T21:00:00.000Z", "disabling idle rest cannot disable unprompted speech cadence");

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

const commitState: InitiativeState = {
  initiativeClock: 20,
  participants: [participant("commit-owner", 25)],
  pendingMentions: [{ identityId: "commit-owner", id: "mention-1", visiblePrompt: "  answer   this  " }],
  history: [],
};
applySchedulerControls({ state: commitState, baseRecoveryMinutes: 45, globalHeat: 1.2 });
assert.equal((commitState as InitiativeState & { baseRecoveryMinutes: number }).baseRecoveryMinutes, 45, "scheduler controls cross one engine commit primitive");
consumePendingMentions({
  state: commitState,
  participant: commitState.participants[0],
  mentions: commitState.pendingMentions,
  consumedAt: "2026-07-15T21:00:00.000Z",
});
assert.equal(commitState.pendingMentions.length, 0, "only the engine consumes pending attention after queue success");
assert.equal((commitState.history.at(-1)?.mentions as Array<{ visiblePrompt: string }>)[0].visiblePrompt, "answer this", "the durable consumption witness is bounded and normalized");
finalizeSchedulerTick(commitState, new Date("2026-07-15T21:01:00.000Z"));
assert.equal(commitState.lastTickAt, "2026-07-15T21:01:00.000Z", "tick finalization belongs to the state owner");

const skippedState: InitiativeState = { initiativeClock: 0, participants: [], pendingMentions: [], history: [] };
recordSchedulerSkip({ state: skippedState, skippedAt: new Date("2026-07-15T21:02:00.000Z"), reason: "paused" });
assert.equal(skippedState.history[0].type, "skipped", "pause observations become scheduler history through an engine commit");

const reconciledState: InitiativeState = { initiativeClock: 20, participants: [], pendingMentions: [], history: [] };
reconcileInitiativeParticipants({
  state: reconciledState,
  specs: [{ id: "resident", participantKind: "repo_face", turnKind: "repo_face_rumination", repoName: "Resident", displayName: "Resident", allowedChannelIds: ["aquarium"], channelSpeedMultiplier: 1 }],
  defaultChannelId: "aquarium",
  speedOverrides: {},
  heatOverrides: {},
  baseRecoveryMinutes: 30,
  globalHeat: 1,
  activeTurns: new Map(),
  completedThisTick: new Set(),
});
assert.deepEqual(reconciledState.participants.map((entry) => entry.identityId), ["resident"], "the engine commits reconciled participants instead of returning a second-writer patch");

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

let bifrostArgs: string[] = [];
const bifrostDigest = await readBifrostGovernanceDigest({
  bifrostRoot: "Bifrost",
  repoName: "VoidBot",
  agentIdentity: "void",
  runDigest: (_scriptPath, args) => {
    bifrostArgs = args;
    return { status: 0, stdout: JSON.stringify({ generatedAt: "2026-07-15T21:00:00.000Z", topics: [] }) };
  },
});
assert.deepEqual(bifrostArgs, ["digest", "--repo", "VoidBot", "--agent", "void", "--limit", "6"], "the Bifrost source alone owns the governance CLI contract");
assert.deepEqual(bifrostDigest.topics, [], "typed Bifrost governance facts cross the source boundary unchanged");
const malformedBifrostDigest = await readBifrostGovernanceDigest({
  bifrostRoot: "Bifrost",
  repoName: "VoidBot",
  agentIdentity: "void",
  now: new Date("2026-07-15T21:00:00.000Z"),
  runDigest: () => ({ status: 0, stdout: "not-json" }),
});
assert.equal(malformedBifrostDigest.topics[0].id, "bifrost-digest-parse-error", "malformed provider output becomes an explicit typed error topic");
assert.equal(malformedBifrostDigest.generatedAt, "2026-07-15T21:00:00.000Z", "provider failure witnesses use the caller's observation clock");

const submittedJobs: CreateJobInput[] = [];
const turnReceipt = await submitPersonaTurn({
  jobQueue: {
    async createJob(input) {
      submittedJobs.push(input);
      return { created: true, job: { id: "job-1" } as JobRecord };
    },
  } satisfies Pick<JobQueue, "createJob">,
  provider: "owner_codex",
  identityId: "nibu",
  queuedAt: "2026-07-15T21:03:00.000Z",
  channelId: "aquarium",
  prompt: "Persona prompt",
  recentMessages: contextMessages,
  conversationFocus: { channelId: "aquarium", reason: "latest_human_message", isCurrentRoom: true },
  conversationThreads: [],
  imageAttachments: [],
});
assert.deepEqual(turnReceipt, {
  created: true,
  activeJobId: "job-1",
  requestMessageId: "agent-turn:nibu:2026-07-15T21:03:00.000Z",
}, "the turn actuator returns only its queue receipt");
assert.equal(submittedJobs[0].command, "repo-face-rumination", "the actuator owns the worker command contract");
assert.equal(submittedJobs[0].initialState, "approved", "Persona turns enter the canonical queue through one approval policy");
assert.equal(submittedJobs[0].contextBundle.recentMessages.length, 2, "the actuator lowers supplied evidence into the worker context bundle");
assert.equal(submittedJobs[0].requester.id, "voidbot-agent-turn", "the actuator owns the worker-facing actor identity");

const routedIdentity = {
  id: "nibu",
  identityKind: "repo_face",
  repoName: "AetheriaLore",
  displayName: "Nibu",
  allowedChannelIds: ["legacy"],
  channelPermissions: [{
    channelId: "aquarium",
    label: "Aquarium",
    topic: "casual conversation",
    speechThreshold: "very_low",
    speedMultiplier: 4,
  }, {
    channelId: "lore",
    label: "Lore",
    topic: "setting work",
    speechThreshold: "medium",
    speedMultiplier: 1,
  }],
} as RepoDiscordIdentity;
assert.deepEqual(await readPersonaMemoryRecall({
  identity: routedIdentity,
  config: undefined as never,
  state: undefined,
  projectedMemory: "No memory was acquired.",
  recentMessages: [],
  channelSnapshots: [],
}), {
  status: "unavailable",
  reason: "No typed Persona state observation was supplied.",
}, "semantic recall fails explicitly before touching vector infrastructure when the typed Mind observation is absent");
const roomObservation = observePersonaRoomTexture({
  identity: routedIdentity,
  recentMessages: [{ id: "human-1", authorId: "human", authorName: "Operator", content: "hello", timestamp: "2026-07-15T21:00:00.000Z", isBot: false, channelId: "aquarium" }],
  channelSnapshots: [],
});
assert.equal(roomObservation?.texture, "light", "social-context projection derives room weather from supplied messages without acquiring Discord state");
assert.match(renderPersonaRoomWeather({ identity: routedIdentity, recentMessages: [], channelSnapshots: [] }), /No current room weather/, "absent room evidence stays explicit");
assert.match(renderPersonaHumanPronounFacts([{ actorId: "human", actorName: "Operator", guidance: "use they/them", policy: "explicit", confidence: 1 }]) ?? "", /Confidence: 1\.00/, "pronoun guidance presentation belongs to the social-context projector");
let pronounReaderClosed = false;
const pronounGuidance = await readPersonaHumanPronounGuidance({
  ownerActorId: "owner",
  ownerFallbackName: "Metacrat",
  recentMessages: [{ id: "human-pronouns", authorId: "human", authorName: "Operator", content: "hello", timestamp: "2026-07-15T21:00:00.000Z", isBot: false, channelId: "aquarium" }],
  channelSnapshots: [],
  openProfiles: async () => ({
    getProfile: async (actorId) => actorId === "human" ? {
      actorName: "Operator",
      pronounPolicy: "explicit",
      resolvedPronounSets: ["they/them"],
      resolvedPronounSet: "they/them",
      pronounGuidance: "use they/them",
      pronounConfidence: 0.95,
      pronounEvidence: [
        { pronounSet: "they/them", stance: "prefer", source: "explicit_correction", confidence: 0.9, timestamp: "2026-07-14T20:00:00.000Z", excerpt: "please use they/them" },
        { pronounSet: "they/them", stance: "prefer", source: "ambient_usage", confidence: 1, timestamp: "2026-07-15T20:00:00.000Z", excerpt: "someone said they" },
      ],
    } as never : undefined,
    close: async () => { pronounReaderClosed = true; },
  }),
});
assert.match(pronounGuidance[0]?.evidenceExcerpt ?? "", /please use they\/them/, "the social-context source owns pronoun evidence precedence rather than favoring merely newer ambient usage");
assert.equal(pronounReaderClosed, true, "the social-context source closes its injected interaction-profile reader");
const clarityPressure = renderPersonaHumanClarityPressure({
  identity: routedIdentity,
  recentMessages: [
    { id: "later", authorId: "human", authorName: "Operator", content: "speak plainly", timestamp: "2026-07-15T22:00:00.000Z", isBot: false, channelId: "aquarium" },
    { id: "earlier", authorId: "human", authorName: "Operator", content: "what are you talking about", timestamp: "2026-07-15T21:00:00.000Z", isBot: false, channelId: "aquarium" },
  ],
  channelSnapshots: [],
});
assert.match(clarityPressure ?? "", /said, "speak plainly"/, "clarity projection orders supplied evidence by its real timestamp before choosing the freshest human correction");
assert.equal(await projectPersonaMemorySurface({
  identityId: "nibu",
  characterIdentity: "Nibu",
  statePacket: "Nibu remembers the ship mind and remains irritated by careless continuity.",
  modelProjectionEnabled: false,
}), "Nibu remembers the ship mind and remains irritated by careless continuity.", "disabled model projection returns the validated deterministic memory surface without invoking a model");
await assert.rejects(projectPersonaMemorySurface({
  identityId: "nibu",
  characterIdentity: "Nibu",
  statePacket: "path=private-state",
  modelProjectionEnabled: false,
}), /leaked schema/, "the projector rejects state-path leakage on the model-free path");
const stateSourceDirectory = await mkdtemp(join(tmpdir(), "voidbot-persona-state-source-"));
try {
  const statePath = join(stateSourceDirectory, "nibu.cc");
  const observation = await readPersonaStateObservation({
    identity: { ...routedIdentity, faceStatePath: statePath },
    storageRoot: stateSourceDirectory,
    now: new Date("2026-07-15T21:00:00.000Z"),
  });
  assert.equal(observation.status, "missing", "the Persona state source reports a missing canonical mind explicitly");
  await assert.rejects(access(statePath), "observing a missing Persona state cannot create or mutate its canonical surface");
  await ensureVoidSelfStateIdentityProfile({
    canonicalPath: statePath,
    identity: { agentId: routedIdentity.id, publicName: routedIdentity.displayName, publicDescription: routedIdentity.description },
  });
  const beforeObservation = await readFile(statePath);
  const populatedObservation = await readPersonaStateObservation({
    identity: { ...routedIdentity, faceStatePath: statePath },
    storageRoot: stateSourceDirectory,
    now: new Date("2026-07-15T21:00:00.000Z"),
  });
  assert.equal(populatedObservation.status, "ok", "the source acquires typed mind and physiology facts from an existing CultCache surface");
  assert.equal(populatedObservation.status === "ok" && populatedObservation.rest?.isNapping, false, "rest projection is deterministic at the supplied observation time");
  const typedSections = populatedObservation.status === "ok"
    ? renderPersonaTypedStateSections({ identityName: "Nibu", state: populatedObservation.typedState })
    : undefined;
  assert.match(typedSections?.opening.join("\n") ?? "", /Speaking pressure:/, "the projector owns typed runtime-pressure presentation without acquiring Persona state");
  const socialGraph = populatedObservation.status === "ok"
    ? renderPersonaSocialGraph({ identity: routedIdentity, registryIdentities: [routedIdentity], state: populatedObservation.typedState })
    : undefined;
  assert.match(socialGraph ?? "", /Social graph topology:/, "social topology projection consumes typed state and the explicit registry without acquiring either");
  const socialContext = populatedObservation.status === "ok"
    ? projectPersonaSocialContext({
      identity: routedIdentity,
      registryIdentities: [routedIdentity, { ...routedIdentity, id: "peer", repoName: "PeerRepo", displayName: "Peer" }],
      state: populatedObservation.typedState,
      recentMessages: [
        { id: "peer-opening", authorId: "peer", authorName: "Peer", content: "Nibu, the room is yours.", timestamp: "2026-07-15T21:01:00.000Z", isBot: true, channelId: "aquarium" },
        { id: "human-pressure", authorId: "human", authorName: "Operator", content: "Nibu, your authority over this jurisdiction is being challenged.", timestamp: "2026-07-15T21:02:00.000Z", isBot: false, channelId: "aquarium" },
      ],
      channelSnapshots: [],
      pronounGuidance: [],
      observedAt: new Date("2026-07-15T21:03:00.000Z"),
    })
    : undefined;
  assert.match(socialContext?.peerOpening ?? "", /Peer: 1 recent nearby message/, "the aggregate social projection owns peer openings");
  assert.match(socialContext?.socialPressure ?? "", /human voice/, "the aggregate social projection owns relationship-pressure scoring");
  const maintenanceState = populatedObservation.status === "ok" ? {
    ...populatedObservation.typedState,
    faceAffect: {
      ...populatedObservation.typedState.faceAffect,
      needs: [{
        needId: "need-tool",
        kind: "substrate" as const,
        status: "neglected" as const,
        target: { kind: "project" as const, id: "voidbot", label: "VoidBot" },
        summary: "The Persona tool path is broken",
        claim: "The voice cannot reach its room",
        tension: "Private rumination cannot repair a missing actuator",
        actionImplication: "Ask plainly for the tool path to be repaired",
        intensity: 0.8,
        valence: -0.6,
        anchorRefs: [],
        evidenceRefs: [],
        sourceMemoryIds: [],
        createdAt: "2026-07-15T20:00:00.000Z",
        updatedAt: "2026-07-15T20:00:00.000Z",
        tags: ["anchor:missing"],
      }],
    },
  } : undefined;
  assert.match(maintenanceState ? renderPersonaSelfMaintenancePressure({ identityName: "Nibu", state: maintenanceState, clarityPressureActive: false }) ?? "" : "", /Self-maintenance pressure requiring public advocacy/, "the memory projector owns self-maintenance classification and rendering");
  assert.equal(maintenanceState ? renderPersonaSelfMaintenancePressure({ identityName: "Nibu", state: maintenanceState, clarityPressureActive: true }) : undefined, undefined, "live human clarity pressure suppresses self-maintenance advocacy inside the owning projector");
  const curiosityObservation = populatedObservation.status === "ok" ? await readPersonaCuriosityEvidence({
    identity: routedIdentity,
    state: populatedObservation.typedState,
    recentMessages: [{ id: "curiosity-room", authorId: "human", authorName: "Operator", content: "memory topology needs inspectable semantic anchors", timestamp: "2026-07-15T21:00:00.000Z", isBot: false, channelId: "aquarium" }],
    channelSnapshots: [],
    sourceRepoName: "AetheriaLore",
    retrieval: {
      searchHistory: async () => [{ chunkId: "history-1", sourceId: "message-1", sourceKind: "discord_message", text: "semantic memory topology and inspectable anchors", score: 0.84, metadata: { channelId: "aquarium" } }],
      searchSources: async (_query, _limit, repoName) => repoName
        ? [{ chunkId: "source-home", sourceId: "doc-home", sourceKind: "source_document", text: "semantic memory topology preserves inspectable provenance anchors", score: 0.82, metadata: { repoName, path: "memory.md" } }]
        : [{ chunkId: "source-global", sourceId: "doc-global", sourceKind: "source_document", text: "inspectable semantic topology joins memory evidence anchors", score: 0.8, metadata: { repoName: "VoidBot", path: "map.md" } }],
    },
  }) : undefined;
  assert.equal(curiosityObservation?.status, "ok", "the curiosity source plans queries and acquires bounded neutral evidence through an injected retrieval port");
  const unavailableCuriosity = populatedObservation.status === "ok" ? await readPersonaCuriosityEvidence({
    identity: routedIdentity,
    state: populatedObservation.typedState,
    recentMessages: [{ id: "curiosity-failure", authorId: "human", authorName: "Operator", content: "semantic memory topology needs inspectable anchors", timestamp: "2026-07-15T21:00:00.000Z", isBot: false, channelId: "aquarium" }],
    channelSnapshots: [],
    retrieval: () => { throw new Error("vector adapter unavailable"); },
  }) : undefined;
  assert.deepEqual(unavailableCuriosity, { status: "unavailable", reason: "vector adapter unavailable" }, "retrieval-adapter construction fails inside the curiosity source's explicit unavailable witness");
  const curiosityProjection = populatedObservation.status === "ok" && curiosityObservation ? projectPersonaCuriosityContext({
    identity: routedIdentity,
    state: populatedObservation.typedState,
    recentMessages: [{ id: "curiosity-room", authorId: "human", authorName: "Operator", content: "memory topology needs inspectable semantic anchors", timestamp: "2026-07-15T21:00:00.000Z", isBot: false, channelId: "aquarium" }],
    channelSnapshots: [],
    observation: curiosityObservation,
    backendDescription: "injected smoke retrieval",
  }) : undefined;
  assert.match(curiosityProjection ?? "", /Curiosity graph attractors:[\s\S]*injected smoke retrieval/, "the pure curiosity projector decodes and renders supplied evidence without acquiring it");
  const pressureSections = populatedObservation.status === "ok"
    ? renderPersonaPressureSections({ identityName: "Nibu", state: populatedObservation.typedState, clarityPressureActive: true })
    : [];
  const composedMemory = typedSections && composePersonaMemoryPacket({
    identityName: "Nibu",
    typed: typedSections,
    socialGraph: "Explicit social graph fact.",
    roomTexture: "Explicit room texture fact.",
    pressureSections,
  });
  assert.match(composedMemory ?? "", /Explicit social graph fact\.[\s\S]*Explicit room texture fact\./, "the projector owns final ordering of explicitly supplied external facts");
  const statePacket = populatedObservation.status === "ok" ? projectPersonaStatePacket({
    identity: routedIdentity,
    state: populatedObservation.typedState,
    curiosityGraphFacts: "A witness artifact remains literal source evidence.",
    observedAt: new Date("2026-07-15T21:00:00.000Z"),
  }) : "";
  assert.match(statePacket, /A witness artifact remains literal source evidence\./, "state packet projection does not rewrite natural language through a downstream vocabulary cop");
  assert.deepEqual(await readFile(statePath), beforeObservation, "Persona state observation cannot rewrite sleep, speaking pressure, or any other Mind field");
  const portableProjection = projectGamecultPersonaState({ ...routedIdentity, id: "muninn", displayName: "Muninn", identityKind: "native_persona" }, { schemaVersion: "gamecult.persona_state.v0", publicDescription: "Muninn remembers provenance.", privateNotes: ["Name missing evidence."], values: [{ label: "Source time", summary: "Keep observation time distinct." }], thoughtMemory: { shortTerm: [{ summary: "The last frame was stale." }] } });
  assert.match(portableProjection, /Persona state authority is unreported; treat it as a non-canonical projection[\s\S]*Source time: Keep observation time distinct/, "the portable projector renders bounded state without inventing canonical authority");
  assert.doesNotMatch(portableProjection, /persona_state\.v0\.json|state-source/, "portable Persona projection cannot leak its private filesystem path");
} finally {
  await rm(stateSourceDirectory, { recursive: true, force: true });
}
const channelPlan = buildPersonaChannelPlan(routedIdentity, "aquarium", "lore");
assert.equal(channelPlan.primaryChannelId, "lore", "fresh direct attention chooses its permitted source room");
assert.deepEqual(channelPlan.snapshotChannelIds, ["aquarium", "lore", "legacy"], "routing exposes one deduplicated evidence neighborhood");
assert.deepEqual(channelPlan.lowThresholdTopics, ["casual conversation"], "prompt renderers consume routing policy instead of recomputing thresholds");
const saturatedMessages = Array.from({ length: 8 }, (_, index) => ({ id: `topic-${index}`, authorId: "human", authorName: "Operator", content: `semantic memory topology anchors evidence ${index}`, timestamp: `2026-07-15T21:0${index}:00.000Z`, isBot: false, channelId: "lore" }));
const conversationProjection = projectPersonaConversation({
  identity: routedIdentity,
  recentMessages: saturatedMessages,
  channelSnapshots: [{ channelId: "aquarium", messages: [{ id: "nearby", authorId: "human-2", authorName: "Neighbor", content: "a nearby correction", timestamp: "2026-07-15T21:09:00.000Z", isBot: false, channelId: "aquarium" }] }],
  pendingMentions: [{ messageId: "mention", channelId: "aquarium", authorId: "human-2", authorName: "Neighbor", visiblePrompt: "Nibu, answer this", queuedAt: "2026-07-15T21:10:00.000Z" }],
  channelPlan,
});
assert.equal(conversationProjection.focus?.reason, "pending_mention", "conversation projection gives the freshest direct call default context authority");
assert.match(conversationProjection.transcript, /Visible cross-channel chronology,[\s\S]*nearby correction/, "conversation projection renders supplied cross-channel evidence without acquiring it");
assert.match(conversationProjection.topicAttractor ?? "", /semantic \(8\)/, "conversation projection owns topic-attractor facts");
assert.match(renderPersonaRoomTopicSaturation(routedIdentity, saturatedMessages), /Current room topic saturation:/, "turn-facing saturation and memory-facing attractors share one conversation owner");
const promptParticipant = participant("nibu", 0);
const jurisdictionDive = buildPersonaJurisdictionDiveDirective(routedIdentity, promptParticipant);
assert.equal(jurisdictionDive.cadence, 3, "the turn-prompt projector owns Nibu's jurisdiction-dive cadence");
const projectedTurnPrompt = buildPersonaTurnPrompt({
  identity: routedIdentity,
  channelId: "lore",
  channelPlan,
  channelSnapshots: [],
  recentMessages: saturatedMessages,
  memorySurface: "Nibu remembers the architecture.",
  conversationMemorySurface: conversationProjection.transcript,
  participant: promptParticipant,
  pendingMentions: [{ messageId: "mention", channelId: "aquarium", authorId: "human-2", authorName: "Neighbor", visiblePrompt: "Nibu, answer this", queuedAt: "2026-07-15T21:10:00.000Z" }],
  jurisdictionDive,
  githubActionsEnabled: false,
  globalAgentDoctrine: { status: "ok", path: "C:/Codex/AGENTS.md", doctrine: "Global doctrine.", attemptedPaths: ["C:/Codex/AGENTS.md"] },
});
assert.match(projectedTurnPrompt, /A direct call is tugging at you[\s\S]*Nibu, answer this/, "the pure turn-prompt projector owns situation and pending-call policy from supplied facts");
const assembledTurn = assemblePersonaTurn({
  identity: routedIdentity,
  channelId: "lore",
  channelPlan,
  channelSnapshots: [{ channelId: "aquarium", messages: [{
    id: "duplicate-image",
    authorId: "human-2",
    authorName: "Neighbor",
    content: "same image nearby",
    timestamp: "2026-07-15T21:09:00.000Z",
    isBot: false,
    channelId: "aquarium",
    attachments: [{ kind: "image", filename: "same.png", contentType: "image/png", localPath: "C:/cache/same.png" }],
  }] }],
  recentMessages: Array.from({ length: 9 }, (_, index) => ({
    id: `image-${index}`,
    authorId: "human",
    authorName: "Operator",
    content: `image evidence ${index}`,
    timestamp: `2026-07-15T21:${String(index).padStart(2, "0")}:00.000Z`,
    isBot: false,
    channelId: "lore",
    attachments: [{ kind: "image" as const, filename: `${index}.png`, contentType: "image/png", localPath: index === 0 ? "C:/cache/same.png" : `C:/cache/${index}.png` }],
  })),
  participant: promptParticipant,
  pendingMentions: [],
  conversationMemorySurface: "Inspection supplied conversation authority.",
  githubActionsEnabled: false,
  globalAgentDoctrine: { status: "ok", path: "C:/Codex/AGENTS.md", doctrine: "Global doctrine.", attemptedPaths: ["C:/Codex/AGENTS.md"] },
});
assert.match(assembledTurn.prompt, /Inspection supplied conversation authority\./, "queued and inspection paths share one assembler with an explicit conversation override");
assert.doesNotMatch(assembledTurn.prompt, /Visible cross-channel chronology/, "the assembler does not let its derived transcript override an explicit inspection surface");
assert.equal(assembledTurn.imageAttachments.length, 8, "the assembler owns the bounded image evidence budget");
assert.equal(assembledTurn.imageAttachments.filter((attachment) => attachment.localPath === "C:/cache/same.png").length, 1, "the assembler deduplicates image evidence across room and nearby snapshots");
assert.equal(assembledTurn.conversation.focus?.channelId, "aquarium", "the assembler returns the same newest-evidence conversation projection supplied to the turn actuator");
const doctrineReads: string[] = [];
const doctrineObservation = await readGlobalAgentDoctrine({
  codexHome: "C:/Codex",
  userProfile: "C:/User",
  homeDirectory: "C:/User",
  readText: async (path) => {
    doctrineReads.push(path);
    if (path.endsWith("Codex\\AGENTS.md")) throw new Error("missing");
    return "Global doctrine from the first readable authority.";
  },
});
assert.equal(doctrineObservation.status, "ok", "the doctrine source reports the first readable authority as typed evidence");
assert.equal(doctrineReads.length, 2, "the doctrine source stops after the first readable candidate and deduplicates repeated home paths");
const unavailableDoctrine = await readGlobalAgentDoctrine({
  codexHome: "C:/Absent",
  homeDirectory: "C:/AlsoAbsent",
  readText: async () => { throw new Error("not found"); },
});
assert.equal(unavailableDoctrine.status, "unavailable", "missing global doctrine remains an explicit source failure");
const unavailableDoctrineTurn = assemblePersonaTurn({
  identity: routedIdentity,
  channelId: "lore",
  channelPlan,
  channelSnapshots: [],
  recentMessages: [],
  participant: promptParticipant,
  pendingMentions: [],
  githubActionsEnabled: false,
  globalAgentDoctrine: unavailableDoctrine,
});
assert.match(unavailableDoctrineTurn.prompt, /Global Agent Instructions Unavailable[\s\S]*inspection failure/, "the assembler, not the source or shell, projects unavailable doctrine into the final prompt");
const moderationLaunchCommand = buildVoidModerationLaunchCommand({
  pendingMentionsPath: "C:/Void's state/pending.json",
  runnerScript: "C:/VoidBot/scripts/run.ps1",
  workspaceRoot: "C:/VoidBot",
});
assert.match(moderationLaunchCommand, /Void''s state/, "the moderation actuator owns PowerShell-safe path quoting");
assert.match(moderationLaunchCommand, /Start-Process[\s\S]*-WindowStyle Hidden/, "the moderation actuator owns detached hidden launch mechanics");
let handshakeNow = 0;
const missingHandshake = await waitForVoidModerationHandshake({
  lockPath: "lock",
  statusPath: "status",
  launchedAt: 0,
  timeoutMs: 2,
  now: () => handshakeNow,
  pause: async () => { handshakeNow += 1; },
  touchedAfter: async () => false,
});
assert.deepEqual(missingHandshake, { started: false, reason: "void_moderation_launch_handshake_missing" }, "a missing launch witness fails explicitly instead of pretending the turn started");
const moderationActuatorDirectory = await mkdtemp(join(tmpdir(), "voidbot-moderation-actuator-"));
try {
  let launchWitness: { command?: string; args?: string[]; cwd?: string; unref?: boolean } = {};
  const receipt = await launchVoidModerationTurn({
    queuedAt: "2026-07-15T21:10:00.000Z",
    storageRoot: moderationActuatorDirectory,
    workspaceRoot: moderationActuatorDirectory,
    pendingMentions: [{ messageId: "mention", channelId: "aquarium", authorId: "human-2", authorName: "Neighbor", visiblePrompt: "Void, answer this", queuedAt: "2026-07-15T21:10:00.000Z" }],
  }, {
    now: () => 1000,
    touchedAfter: async (path) => path.endsWith("moderation-rumination.lock"),
    launch: (command, args, options) => ({ pid: 42, unref: () => { launchWitness = { command, args, cwd: options.cwd, unref: true }; } }),
  });
  assert.deepEqual(receipt, { created: true, activeJobId: "process:void-moderation:2026-07-15T21:10:00.000Z", requestMessageId: "agent-turn:void:2026-07-15T21:10:00.000Z" }, "the moderation actuator returns only a scheduler-facing start receipt after handshake");
  assert.equal(launchWitness.command, "powershell.exe", "the moderation actuator owns the platform process choice");
  assert.equal(launchWitness.unref, true, "the moderation actuator detaches the launcher");
  const pendingMentionEnvelope = JSON.parse(await readFile(join(moderationActuatorDirectory, "status", "void-moderation-pending-mentions.json"), "utf8"));
  assert.equal(pendingMentionEnvelope.pendingMentions[0].messageId, "mention", "the moderation actuator writes the exact pending-attention handoff consumed by the runner");
} finally {
  await rm(moderationActuatorDirectory, { recursive: true, force: true });
}
assert.equal(personaChannelSpeedMultiplier(routedIdentity), 3, "scheduler speed projection uses the routing organ's bounded channel policy");
assert.equal(newestPendingMentionChannel([
  { identityId: "nibu", channelId: "older", queuedAt: "2026-07-15T20:00:00.000Z" },
  { identityId: "nibu", channelId: "newer", queuedAt: "2026-07-15T21:00:00.000Z" },
] as RepoFacePendingMention[]), "newer", "routing follows the newest pending room obligation");

const controlDirectory = await mkdtemp(join(tmpdir(), "voidbot-persona-controls-"));
try {
  const pausePath = join(controlDirectory, "pause.json");
  assert.equal((await readAgentSwarmPause({ path: pausePath })).paused, false, "an absent pause witness leaves the resident scheduler running");
  await writeFile(pausePath, "{broken", "utf8");
  const malformedPause = await readAgentSwarmPause({ path: pausePath });
  assert.equal(malformedPause.paused, true, "a present malformed pause witness fails closed");
  assert.match(malformedPause.reason ?? "", /could not be parsed/, "the pause source explains its fail-closed observation");
  await writeFile(pausePath, JSON.stringify({ paused: false, reason: "operator resumed" }), "utf8");
  assert.deepEqual(await readAgentSwarmPause({ path: pausePath }), { paused: false, path: pausePath, reason: "operator resumed" }, "the pause source returns operator facts without touching scheduler state");
  assert.deepEqual(await readSwarmControlState({ loadControl: () => ({ globalHeat: 1.75 }) }), { globalHeat: 1.75 }, "typed CultMesh heat is projected through the control source");
  assert.equal(await readSwarmControlState({ loadControl: () => ({ globalHeat: 4 }) }), null, "out-of-contract heat fails closed before the engine sees it");
} finally {
  await rm(controlDirectory, { recursive: true, force: true });
}

let repoActivityArgs: string[] = [];
const repoActivity = readRepoActivity({
  identity: routedIdentity,
  storageRoot: "state-root",
  cwd: "workspace",
  runExporter: (_scriptPath, args) => {
    repoActivityArgs = args;
    return { status: 0, stdout: JSON.stringify({ digest: "- Fresh repo motion." }) };
  },
});
assert.deepEqual(repoActivity, { status: "ok", sourceRepoName: "AetheriaLore", digest: "- Fresh repo motion." }, "repo activity crosses the source boundary as facts, not prompt prose");
assert.ok(repoActivityArgs.includes("--read-only"), "Persona turns cannot advance the repo activity cursor while observing body context");
assert.deepEqual(repoActivityArgs.slice(-4), ["--hours", "96", "--max-commits", "5"], "the source owns one bounded activity window");
const failedRepoActivity = readRepoActivity({
  identity: routedIdentity,
  storageRoot: "state-root",
  runExporter: () => ({ status: 1, stderr: "reader failed" }),
});
assert.deepEqual(failedRepoActivity, { status: "unavailable", sourceRepoName: "AetheriaLore", detail: "reader failed" }, "activity process failure is an explicit observation");
const malformedRepoActivity = readRepoActivity({
  identity: routedIdentity,
  storageRoot: "state-root",
  runExporter: () => ({ status: 0, stdout: "not-json" }),
});
assert.equal(malformedRepoActivity.status, "malformed", "malformed activity output cannot impersonate current repo truth");

const stateDirectory = await mkdtemp(join(tmpdir(), "voidbot-persona-scheduler-"));
try {
  const statePath = join(stateDirectory, "scheduler.json");
  const absent = await readPersonaSchedulerState(statePath);
  assert.equal(absent.initiativeClock, 0, "an absent scheduler store starts one explicit new state");
  absent.participants.push(participant("persisted", 7));
  await writePersonaSchedulerState(statePath, absent);
  const persisted = await readPersonaSchedulerState(statePath);
  assert.equal(persisted.participants[0].identityId, "persisted", "atomic scheduler persistence round-trips its state");
  assert.ok((await readFile(resolveRepoFaceHeartbeatDebugProjectionPath(statePath), "utf8")).endsWith("\n"), "the JSON witness remains a complete inspectable projection");
  await writeFile(resolveRepoFaceHeartbeatDebugProjectionPath(statePath), `${JSON.stringify(newPersonaSchedulerState())}\n`, "utf8");
  assert.equal((await readPersonaSchedulerState(statePath)).participants[0].identityId, "persisted", "the derived JSON witness cannot override canonical CultCache state");

  await writeFile(resolveRepoFaceHeartbeatStatePath(statePath), "{broken", "utf8");
  await assert.rejects(
    readPersonaSchedulerState(statePath),
    /refusing to replace it with empty state/,
    "malformed persistent state must fail closed instead of erasing the scheduler mind",
  );

  await rm(resolveRepoFaceHeartbeatStatePath(statePath), { force: true });
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
  assert.ok(migrated.history.some((entry) => entry.type === "migrated"), "schema migration leaves a durable state witness");
  assert.equal(migrated.history.at(-1)?.type, "storage_migrated", "JSON-to-CultCache migration names the storage authority change");

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
