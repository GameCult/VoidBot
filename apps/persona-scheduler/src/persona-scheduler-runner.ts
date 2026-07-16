import type { loadConfig } from "@voidbot/config";
import { createStateStorage, faceRegistryAsRepoDiscordRegistry, getRepoDiscordIdentityAllowedChannelIds, loadFaceIdentityRegistry } from "@voidbot/core";

import { scanActivePersonaTurns } from "./active-turn-source.js";
import { readAgentSwarmPause, readSwarmControlState } from "./control-source.js";
import { readDiscordActivitySnapshot } from "./discord-activity-source.js";
import {
  advanceInitiativeClockFromWallClock, applyPendingMentionPriority, applySchedulerControls,
  applySemanticPressureProjection, consumePendingMentions, finalizeSchedulerTick,
  reconcileInitiativeParticipants, recordDryRunSelection, recordSchedulerSkip,
  recordStaleActiveTurnRecoveries, recordTurnFailedToStart, recordTurnStarted,
  rescheduleStaleOverdueParticipants, selectReadyParticipants,
} from "./initiative-engine.js";
import {
  buildPersonaParticipantSpecs, dispatchPersonaParticipantTurn, pendingMentionsForPersona,
  renderPersonaInitiativeAffinity,
} from "./persona-participant-dispatcher.js";
import { readPersonaStateObservations } from "./persona-state-source.js";
import { readSemanticPressure } from "./semantic-pressure-source.js";
import { readPersonaSchedulerState, writePersonaSchedulerState } from "./state-store.js";

export interface PersonaSchedulerTickResult {
  ok: true;
  participantCount: number;
  initiativeClock: number;
  queuedCount: number;
  dryRun: boolean;
  selected: string[];
  queued: string[];
  statePath: string;
  skipped?: true;
  reason?: "agent_swarm_paused" | "repo_face_heartbeats_disabled";
  pausePath?: string;
  idleCooling?: Record<string, unknown>;
}

interface PersonaSchedulerRunnerDependencies {
  readPause?: typeof readAgentSwarmPause;
  readState?: typeof readPersonaSchedulerState;
  writeState?: typeof writePersonaSchedulerState;
}

export async function runPersonaSchedulerTick(input: {
  config: ReturnType<typeof loadConfig>;
  dryRun?: boolean;
  force?: boolean;
  now?: Date;
}, dependencies: PersonaSchedulerRunnerDependencies = {}): Promise<PersonaSchedulerTickResult> {
  const { config } = input;
  const dryRun = input.dryRun ?? false;
  const readState = dependencies.readState ?? readPersonaSchedulerState;
  const writeState = dependencies.writeState ?? writePersonaSchedulerState;
  const pause = await (dependencies.readPause ?? readAgentSwarmPause)();
  if (pause.paused) {
    const state = await readState(config.repoFaceHeartbeats.statePath);
    recordSchedulerSkip({ state, skippedAt: input.now ?? new Date(), reason: "agent_swarm_paused", details: { pausePath: pause.path, pauseReason: pause.reason } });
    if (!dryRun) await writeState(config.repoFaceHeartbeats.statePath, state);
    return { ok: true, participantCount: state.participants.length, initiativeClock: state.initiativeClock, queuedCount: 0, dryRun, selected: [], queued: [], skipped: true, reason: "agent_swarm_paused", pausePath: pause.path, statePath: config.repoFaceHeartbeats.statePath };
  }
  if (!config.repoFaceHeartbeats.enabled && !input.force) {
    const state = await readState(config.repoFaceHeartbeats.statePath);
    recordSchedulerSkip({ state, skippedAt: input.now ?? new Date(), reason: "repo_face_heartbeats_disabled" });
    if (!dryRun) await writeState(config.repoFaceHeartbeats.statePath, state);
    return { ok: true, participantCount: state.participants.length, initiativeClock: state.initiativeClock, queuedCount: 0, dryRun, selected: [], queued: [], skipped: true, reason: "repo_face_heartbeats_disabled", statePath: config.repoFaceHeartbeats.statePath };
  }

  const registry = faceRegistryAsRepoDiscordRegistry(await loadFaceIdentityRegistry(config.repoDiscordIdentitiesPath));
  const state = await readState(config.repoFaceHeartbeats.statePath);
  const now = input.now ?? new Date();
  const personaStateObservations = await readPersonaStateObservations({ identities: registry.identities, storageRoot: config.storageRoot, now });
  const restStates = new Map(Array.from(personaStateObservations.entries()).flatMap(([identityId, observation]) => observation.status === "ok" && "rest" in observation && observation.rest ? [[identityId, observation.rest] as const] : []));
  advanceInitiativeClockFromWallClock(state, now);
  const activeTurnScan = dryRun ? { active: new Map<string, string>(), staleRecovered: [] } : await scanActivePersonaTurns(config);
  recordStaleActiveTurnRecoveries({ state, recoveries: activeTurnScan.staleRecovered, recoveredAt: now });
  const globalHeat = (await readSwarmControlState())?.globalHeat ?? config.repoFaceHeartbeats.globalHeat;
  applySchedulerControls({ state, baseRecoveryMinutes: config.repoFaceHeartbeats.baseRecoveryMinutes, globalHeat });
  const completedThisTick = new Set<string>();
  const participantSpecs = buildPersonaParticipantSpecs(registry.identities, config.voidModerationHeartbeatEnabled);
  reconcileInitiativeParticipants({ state, specs: participantSpecs, defaultChannelId: config.repoFaceHeartbeats.defaultChannelId, speedOverrides: config.repoFaceHeartbeats.speedOverrides, heatOverrides: config.repoFaceHeartbeats.heatOverrides, baseRecoveryMinutes: config.repoFaceHeartbeats.baseRecoveryMinutes, globalHeat, activeTurns: activeTurnScan.active, completedThisTick });
  rescheduleStaleOverdueParticipants(state);
  applyPendingMentionPriority(state);
  const idleCooling = await readDiscordActivitySnapshot({
    botToken: config.botToken,
    channelIds: [config.repoFaceHeartbeats.defaultChannelId, config.bifrostDiscordChannelId, ...config.indexedChannelIds, ...registry.identities.flatMap((identity) => getRepoDiscordIdentityAllowedChannelIds(identity))],
    policy: config.repoFaceHeartbeats.idleCooling,
    history: state.history,
    now,
  });
  const pressure = await readSemanticPressure({
    candidates: participantSpecs.flatMap((spec) => {
      const participant = state.participants.find((entry) => entry.identityId === spec.id);
      if (!spec.identity || spec.participantKind === "system_agent" || participant?.status !== "active" || participant.currentLoad >= 1 || completedThisTick.has(participant.identityId) || restStates.get(participant.identityId)?.isNapping === true) return [];
      return [{ identityId: participant.identityId, interruptThreshold: participant.interruptThreshold, affinityText: renderPersonaInitiativeAffinity(spec), allowedChannelIds: spec.allowedChannelIds }];
    }),
    messages: idleCooling.observedHumanMessages,
    now,
    embedding: { backend: config.ragEmbeddingBackend, hashDimensions: config.ragEmbeddingDimensions, ollamaBaseUrl: config.ragOllamaBaseUrl, ollamaModel: config.ragOllamaModel, ollamaTimeoutMs: config.ragOllamaTimeoutMs },
  });
  applySemanticPressureProjection({ state, projections: pressure.projections, projectedAt: now, unavailableReason: pressure.unavailableReason });
  const selected = selectReadyParticipants(state, config.repoFaceHeartbeats.maxJobsPerTick, completedThisTick, restStates, idleCooling);
  const queued: string[] = [];
  if (dryRun) {
    const queuedAt = now.toISOString();
    for (const participant of selected) {
      const mentions = pendingMentionsForPersona(state, participant.identityId);
      recordDryRunSelection(participant, state, queuedAt, mentions.length);
      queued.push(participant.identityId);
    }
  } else if (selected.length > 0) {
    const storage = await createStateStorage({ backend: config.stateStorageBackend, databaseDsn: config.databaseDsn, jobsFile: config.jobsFile, auditLogFile: config.auditLogFile, interactionMemoryFile: config.interactionMemoryFile, rateLimitStateFile: config.rateLimitStateFile });
    try {
      for (const participant of selected) {
        const queuedAt = new Date().toISOString();
        const mentions = pendingMentionsForPersona(state, participant.identityId);
        const turn = await dispatchPersonaParticipantTurn({ participant, pendingMentions: mentions, registryIdentities: registry.identities, config, storage, queuedAt, personaStateObservation: personaStateObservations.get(participant.identityId) });
        if (turn.created) {
          queued.push(participant.identityId);
          recordTurnStarted({ participant, state, queuedAt, activeJobId: turn.activeJobId, requestMessageId: turn.requestMessageId, pendingMentionCount: mentions.length });
          consumePendingMentions({ state, participant, mentions, consumedAt: queuedAt, activeJobId: turn.activeJobId, requestMessageId: turn.requestMessageId });
        } else if (turn.failureReason) recordTurnFailedToStart({ participant, state, queuedAt, activeJobId: turn.activeJobId, requestMessageId: turn.requestMessageId, reason: turn.failureReason });
      }
    } finally { await storage.close(); }
  }
  finalizeSchedulerTick(state, now);
  if (!dryRun) await writeState(config.repoFaceHeartbeats.statePath, state);
  return {
    ok: true, participantCount: state.participants.length, initiativeClock: state.initiativeClock,
    queuedCount: queued.length, dryRun, selected: selected.map((entry) => entry.identityId), queued,
    statePath: config.repoFaceHeartbeats.statePath,
    idleCooling: { ...idleCooling, observedHumanMessages: undefined, observedHumanMessageCount: idleCooling.observedHumanMessages.length },
  };
}
