import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  createStateStorage,
  getRepoFaceSourceRepoName,
  getRepoDiscordIdentityAllowedChannelIds,
  faceRegistryAsRepoDiscordRegistry,
  loadFaceIdentityRegistry,
  resolveRepoFaceStatePath,
  type RepoFacePendingMention,
  type RepoDiscordIdentity,
  type VoidSelfStateTypedProjection,
} from "@voidbot/core";
import { createTextEmbedder, createVectorStores, RetrievalService } from "@voidbot/rag";
import {
  type SourceMessage,
} from "@voidbot/shared";
import {
  advanceInitiativeClockFromWallClock,
  applyPendingMentionPriority,
  applySchedulerControls,
  applySemanticPressureProjection,
  consumePendingMentions,
  finalizeSchedulerTick,
  countPendingMentionsByIdentity,
  reconcileInitiativeParticipants,
  recordDryRunSelection,
  recordSchedulerSkip,
  recordStaleActiveTurnRecoveries,
  recordTurnFailedToStart,
  recordTurnStarted,
  rescheduleStaleOverdueParticipants,
  selectReadyParticipants,
  type InitiativeParticipant as FaceHeartbeatParticipant,
  type ParticipantSpec as SchedulerParticipantSpec,
} from "../apps/persona-scheduler/dist/initiative-engine.js";
import {
  readPersonaSchedulerState as readHeartbeatState,
  writePersonaSchedulerState as writeHeartbeatState,
  type PersonaSchedulerState as FaceHeartbeatState,
} from "../apps/persona-scheduler/dist/state-store.js";
import { scanActivePersonaTurns } from "../apps/persona-scheduler/dist/active-turn-source.js";
import {
  readPersonaStateObservation,
  readPersonaStateObservations,
  type PersonaStateObservation,
} from "../apps/persona-scheduler/dist/persona-state-source.js";
import {
  readPersonaMemoryRecall,
  type PersonaMemoryRecallObservation,
} from "../apps/persona-scheduler/dist/persona-memory-context-source.js";
import { projectPersonaMemorySurface } from "../apps/persona-scheduler/dist/persona-memory-projector.js";
import { readPersonaCuriosityEvidence } from "../apps/persona-scheduler/dist/persona-curiosity-context-source.js";
import { projectPersonaCuriosityContext } from "../apps/persona-scheduler/dist/persona-curiosity-projector.js";
import { renderPersonaIdentityDoctrine } from "../apps/persona-scheduler/dist/persona-turn-prompt-projector.js";
import { projectGamecultPersonaState, projectNativePersonaBody } from "../apps/persona-scheduler/dist/persona-standard-state-projector.js";
import type { PersonaHumanPronounGuidance as RepoFaceHumanPronounGuidance } from "../apps/persona-scheduler/dist/persona-social-context-projector.js";
import { projectPersonaStatePacket } from "../apps/persona-scheduler/dist/persona-state-packet-projector.js";
import { projectPersonaText } from "../apps/persona-scheduler/dist/persona-text-projection-actuator.js";
import { assemblePersonaTurn } from "../apps/persona-scheduler/dist/persona-turn-assembler.js";
import { readPersonaHumanPronounGuidance } from "../apps/persona-scheduler/dist/persona-social-context-source.js";
import {
  readDiscordActivitySnapshot,
  type IdleCoolingSnapshot,
} from "../apps/persona-scheduler/dist/discord-activity-source.js";
import { readSemanticPressure } from "../apps/persona-scheduler/dist/semantic-pressure-source.js";
import {
  fetchChannelSnapshots,
  fetchRecentDiscordMessages,
  type ChannelSnapshot,
} from "../apps/persona-scheduler/dist/turn-context-source.js";
import {
  readBifrostGovernanceDigest,
} from "../apps/persona-scheduler/dist/bifrost-governance-source.js";
import { submitPersonaTurn } from "../apps/persona-scheduler/dist/turn-actuator.js";
import { launchVoidModerationTurn } from "../apps/persona-scheduler/dist/void-moderation-turn-actuator.js";
import {
  buildPersonaChannelPlan as buildChannelPlan,
  newestPendingMentionChannel,
  personaChannelSpeedMultiplier as channelSpeedMultiplierFor,
  type PersonaChannelOption as RepoFaceChannelOption,
  type PersonaChannelPlan as RepoFaceChannelPlan,
} from "../apps/persona-scheduler/dist/turn-routing.js";
import {
  readAgentSwarmPause,
  readSwarmControlState,
} from "../apps/persona-scheduler/dist/control-source.js";
import {
  readRepoActivity,
  type RepoActivityObservation,
} from "../apps/persona-scheduler/dist/repo-activity-source.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const dryRun = process.argv.includes("--dry-run");
  const assemblePromptIdentity = readArgValue("--assemble-prompt");
  if (assemblePromptIdentity) {
    const result = await assembleRepoFaceTurnPrompt({
      config,
      identityId: assemblePromptIdentity,
      outPath: readArgValue("--out"),
      memorySurfacePath: readArgValue("--memory-surface"),
      conversationSurfacePath: readArgValue("--conversation-surface"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const pause = await readAgentSwarmPause();
  if (pause.paused) {
    const state = await readHeartbeatState(config.repoFaceHeartbeats.statePath);
    recordSchedulerSkip({
      state,
      skippedAt: new Date(),
      reason: "agent_swarm_paused",
      details: { pausePath: pause.path, pauseReason: pause.reason },
    });
    if (!dryRun) {
      await writeHeartbeatState(config.repoFaceHeartbeats.statePath, state);
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        queuedCount: 0,
        dryRun,
        skipped: true,
        reason: "agent_swarm_paused",
        pausePath: pause.path,
        statePath: config.repoFaceHeartbeats.statePath,
      })}\n`,
    );
    return;
  }

  if (!config.repoFaceHeartbeats.enabled && !process.argv.includes("--force")) {
    const state = await readHeartbeatState(config.repoFaceHeartbeats.statePath);
    recordSchedulerSkip({
      state,
      skippedAt: new Date(),
      reason: "repo_face_heartbeats_disabled",
    });
    await writeHeartbeatState(config.repoFaceHeartbeats.statePath, state);
    return;
  }

  const faceRegistry = await loadFaceIdentityRegistry(config.repoDiscordIdentitiesPath);
  const registry = faceRegistryAsRepoDiscordRegistry(faceRegistry);
  const state = await readHeartbeatState(config.repoFaceHeartbeats.statePath);
  const now = new Date();
  const personaStateObservations = await readPersonaStateObservations({ identities: registry.identities, storageRoot: config.storageRoot, now });
  const restStates = new Map(Array.from(personaStateObservations.entries()).flatMap(([identityId, observation]) =>
    observation.status === "ok" && observation.rest ? [[identityId, observation.rest] as const] : []));
  advanceInitiativeClockFromWallClock(state, now);
  const activeTurnScan = dryRun
    ? { active: new Map<string, string>(), staleRecovered: [] }
    : await scanActivePersonaTurns(config);
  recordStaleActiveTurnRecoveries({ state, recoveries: activeTurnScan.staleRecovered, recoveredAt: now });

  const swarmControl = await readSwarmControlState();
  const globalHeat = swarmControl?.globalHeat ?? config.repoFaceHeartbeats.globalHeat;
  applySchedulerControls({ state, baseRecoveryMinutes: config.repoFaceHeartbeats.baseRecoveryMinutes, globalHeat });
  const completedThisTick = new Set<string>();
  const participantSpecs = buildParticipantSpecs(registry.identities, config.voidModerationHeartbeatEnabled);
  reconcileInitiativeParticipants({
    state,
    specs: participantSpecs,
    defaultChannelId: config.repoFaceHeartbeats.defaultChannelId,
    speedOverrides: config.repoFaceHeartbeats.speedOverrides,
    heatOverrides: config.repoFaceHeartbeats.heatOverrides,
    baseRecoveryMinutes: config.repoFaceHeartbeats.baseRecoveryMinutes,
    globalHeat,
    activeTurns: activeTurnScan.active,
    completedThisTick,
  });
  rescheduleStaleOverdueParticipants(state);
  applyPendingMentionPriority(state);
  const idleCooling = await readDiscordActivitySnapshot({
    botToken: config.botToken,
    channelIds: [
      config.repoFaceHeartbeats.defaultChannelId,
      config.bifrostDiscordChannelId,
      ...config.indexedChannelIds,
      ...registry.identities.flatMap((identity) => getRepoDiscordIdentityAllowedChannelIds(identity)),
    ],
    policy: config.repoFaceHeartbeats.idleCooling,
    history: state.history,
    now,
  });
  const pressureCandidates = participantSpecs.flatMap((spec) => {
    const participant = state.participants.find((entry) => entry.identityId === spec.id);
    if (!spec.identity || spec.participantKind === "system_agent" || participant?.status !== "active"
      || participant.currentLoad >= 1 || completedThisTick.has(participant.identityId)
      || restStates.get(participant.identityId)?.isNapping === true) return [];
    return [{
      identityId: participant.identityId,
      interruptThreshold: participant.interruptThreshold,
      affinityText: renderInitiativeAffinityCard(spec),
      allowedChannelIds: spec.allowedChannelIds,
    }];
  });
  const pressure = await readSemanticPressure({
    candidates: pressureCandidates,
    messages: idleCooling.observedHumanMessages,
    now,
    embedding: {
      backend: config.ragEmbeddingBackend,
      hashDimensions: config.ragEmbeddingDimensions,
      ollamaBaseUrl: config.ragOllamaBaseUrl,
      ollamaModel: config.ragOllamaModel,
      ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    },
  });
  applySemanticPressureProjection({
    state,
    projections: pressure.projections,
    projectedAt: now,
    unavailableReason: pressure.unavailableReason,
  });

  const selected = selectReadyParticipants(
    state,
    config.repoFaceHeartbeats.maxJobsPerTick,
    completedThisTick,
    restStates,
    idleCooling,
  );
  const queuedIdentityIds: string[] = [];

  if (selected.length > 0 && dryRun) {
    const queuedAt = new Date().toISOString();
    for (const participant of selected) {
      const pendingMentions = pendingMentionsForParticipant(state, participant.identityId);
      recordDryRunSelection(participant, state, queuedAt, pendingMentions.length);
      queuedIdentityIds.push(participant.identityId);
    }
  } else if (selected.length > 0) {
    const storage = await createStateStorage({
      backend: config.stateStorageBackend,
      databaseDsn: config.databaseDsn,
      jobsFile: config.jobsFile,
      auditLogFile: config.auditLogFile,
      interactionMemoryFile: config.interactionMemoryFile,
      rateLimitStateFile: config.rateLimitStateFile,
    });

    try {
      for (const participant of selected) {
        const queuedAt = new Date().toISOString();
        const pendingMentions = pendingMentionsForParticipant(state, participant.identityId);
        const turn = await queueParticipantTurn({
          participant,
          pendingMentions,
          registryIdentities: registry.identities,
          config,
          storage,
          queuedAt,
          personaStateObservation: personaStateObservations.get(participant.identityId),
        });

        if (turn.created) {
          queuedIdentityIds.push(participant.identityId);
          recordTurnStarted({
            participant,
            state,
            queuedAt,
            activeJobId: turn.activeJobId,
            requestMessageId: turn.requestMessageId,
            pendingMentionCount: pendingMentions.length,
          });
          consumePendingMentions({
            state,
            participant,
            mentions: pendingMentions,
            consumedAt: queuedAt,
            activeJobId: turn.activeJobId,
            requestMessageId: turn.requestMessageId,
          });
        } else if (turn.failureReason) {
          recordTurnFailedToStart({
            participant,
            state,
            queuedAt,
            activeJobId: turn.activeJobId,
            requestMessageId: turn.requestMessageId,
            reason: turn.failureReason,
          });
        }
      }
    } finally {
      await storage.close();
    }
  }

  finalizeSchedulerTick(state, now);
  if (!dryRun) {
    await writeHeartbeatState(config.repoFaceHeartbeats.statePath, state);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      participantCount: state.participants.length,
      initiativeClock: state.initiativeClock,
      queuedCount: queuedIdentityIds.length,
      dryRun,
      selected: selected.map((entry) => entry.identityId),
      queued: queuedIdentityIds,
      statePath: config.repoFaceHeartbeats.statePath,
      idleCooling: {
        ...idleCooling,
        observedHumanMessages: undefined,
        observedHumanMessageCount: idleCooling.observedHumanMessages.length,
      },
    })}\n`,
  );
}

interface ParticipantSpec extends SchedulerParticipantSpec {
  identity?: RepoDiscordIdentity;
}

function buildParticipantSpecs(identities: RepoDiscordIdentity[], includeVoid: boolean): ParticipantSpec[] {
  return [
    ...(includeVoid ? [{
      id: "void",
      participantKind: "system_agent" as const,
      turnKind: "void_moderation" as const,
      repoName: "VoidBot",
      displayName: "Void",
      allowedChannelIds: [],
      channelSpeedMultiplier: 1,
    }] : []),
    ...identities.map((identity) => ({
      id: identity.id,
      participantKind: identity.identityKind === "native_persona"
        ? "native_persona" as const
        : "repo_face" as const,
      turnKind: "repo_face_rumination" as const,
      repoName: identity.repoName,
      displayName: identity.displayName,
      allowedChannelIds: getRepoDiscordIdentityAllowedChannelIds(identity),
      channelSpeedMultiplier: channelSpeedMultiplierFor(identity),
      identity,
    })),
  ];
}

async function queueParticipantTurn(input: {
  participant: FaceHeartbeatParticipant;
  pendingMentions: RepoFacePendingMention[];
  registryIdentities: RepoDiscordIdentity[];
  config: ReturnType<typeof loadConfig>;
  storage: Awaited<ReturnType<typeof createStateStorage>>;
  queuedAt: string;
  personaStateObservation?: PersonaStateObservation;
}): Promise<{ created: boolean; activeJobId?: string; requestMessageId?: string; failureReason?: string }> {
  switch (input.participant.turnKind) {
    case "repo_face_rumination":
      return queueRepoFaceTurn(input);
    case "void_moderation":
      return launchVoidModerationTurn({
        queuedAt: input.queuedAt,
        storageRoot: input.config.storageRoot,
        pendingMentions: input.pendingMentions,
      });
  }
}

async function queueRepoFaceTurn(input: {
  participant: FaceHeartbeatParticipant;
  pendingMentions: RepoFacePendingMention[];
  registryIdentities: RepoDiscordIdentity[];
  config: ReturnType<typeof loadConfig>;
  storage: Awaited<ReturnType<typeof createStateStorage>>;
  queuedAt: string;
  personaStateObservation?: PersonaStateObservation;
}): Promise<{ created: boolean; activeJobId?: string; requestMessageId?: string; failureReason?: string }> {
  const identity = input.registryIdentities.find((entry) => entry.id === input.participant.identityId);
  if (!identity) {
    return { created: false, failureReason: `No registered Persona identity exists for ${input.participant.identityId}.` };
  }

  const preferredChannelId = newestPendingMentionChannel(input.pendingMentions);
  const channelPlan = buildChannelPlan(
    identity,
    input.config.repoFaceHeartbeats.defaultChannelId,
    preferredChannelId,
  );
  const channelId = channelPlan.primaryChannelId;
  if (!channelId) {
    return { created: false, failureReason: "No CTB turn channel is configured for this Persona." };
  }

  const recentMessages = await fetchRecentDiscordMessages({
    botToken: input.config.botToken,
    channelId,
    limit: 15,
    ignoreBotMessages: channelId === input.config.bifrostDiscordChannelId,
  });
  const channelSnapshots = await fetchChannelSnapshots({
    botToken: input.config.botToken,
    channelIds: channelPlan.snapshotChannelIds,
    primaryChannelId: channelId,
    limit: 6,
    bifrostDiscordChannelId: input.config.bifrostDiscordChannelId,
  });
  const bifrostDigest = input.config.repoFaceBifrostEnabled && identity.identityKind !== "native_persona"
    ? await readBifrostGovernanceDigest({
        bifrostRoot: input.config.bifrostRoot,
        repoName: identity.repoName,
        agentIdentity: identity.id,
    })
    : undefined;
  const roomContext = {
    recentMessages,
    channelSnapshots,
  };
  const humanPronounGuidance = await loadRepoFaceHumanPronounGuidance(input.config, roomContext);
  const memorySurface = await renderRepoFaceMemorySurfaceForTurn(
    identity,
    input.config,
    input.registryIdentities,
    roomContext,
    humanPronounGuidance,
    input.personaStateObservation,
  );
  const repoActivitySurface = identity.identityKind === "native_persona"
    ? projectNativePersonaBody(identity)
    : renderRepoActivityObservation(readRepoActivity({ identity, storageRoot: input.config.storageRoot }));
  const globalAgentDoctrine = await loadGlobalAgentDoctrine();
  const assembly = assemblePersonaTurn({
    identity,
    channelId,
    channelPlan,
    recentMessages,
    channelSnapshots,
    participant: input.participant,
    pendingMentions: input.pendingMentions,
    memorySurface,
    repoActivitySurface,
    humanPronounGuidance,
    bifrostDigest,
    githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
    globalAgentDoctrine,
  });
  const result = await submitPersonaTurn({
    jobQueue: input.storage.jobQueue,
    provider: input.config.repoFaceHeartbeats.provider,
    identityId: identity.id,
    queuedAt: input.queuedAt,
    channelId,
    prompt: assembly.prompt,
    recentMessages,
    conversationFocus: assembly.conversation.focus,
    conversationThreads: assembly.conversation.threads,
    imageAttachments: assembly.imageAttachments,
  });

  return {
    created: result.created,
    activeJobId: result.activeJobId,
    requestMessageId: result.requestMessageId,
  };
}

function renderInitiativeAffinityCard(spec: ParticipantSpec): string {
  const identity = spec.identity;
  return [
    `${spec.displayName} is the Persona steward of ${spec.repoName}.`,
    identity?.description,
    ...(identity?.channelPermissions ?? []).flatMap((permission) => [
      permission.topic,
      permission.label,
      permission.posture,
    ]),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
}

function pendingMentionsForParticipant(
  state: FaceHeartbeatState,
  identityId: string,
): RepoFacePendingMention[] {
  return state.pendingMentions
    .filter((mention) => mention.identityId === identityId)
    .sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
}

async function assembleRepoFaceTurnPrompt(input: {
  config: ReturnType<typeof loadConfig>;
  identityId: string;
  outPath?: string;
  memorySurfacePath?: string;
  conversationSurfacePath?: string;
}): Promise<{
  ok: true;
  identityId: string;
  promptLength: number;
  outPath?: string;
  memorySurfacePath?: string;
  conversationSurfacePath?: string;
}> {
  const faceRegistry = await loadFaceIdentityRegistry(input.config.repoDiscordIdentitiesPath);
  const registry = faceRegistryAsRepoDiscordRegistry(faceRegistry);
  const identity = registry.identities.find(
    (entry) => entry.id.toLowerCase() === input.identityId.toLowerCase(),
  );

  if (!identity) {
    throw new Error(`Unknown repo Face identity: ${input.identityId}`);
  }

  const channelPlan = buildChannelPlan(identity, input.config.repoFaceHeartbeats.defaultChannelId);
  const channelId = channelPlan.primaryChannelId;
  if (!channelId) {
    throw new Error(`No prompt assembly channel is configured for ${identity.id}.`);
  }

  const [recentMessages, channelSnapshots, bifrostDigest] = await Promise.all([
    fetchRecentDiscordMessages({
      botToken: input.config.botToken,
      channelId,
      limit: 15,
      ignoreBotMessages: channelId === input.config.bifrostDiscordChannelId,
    }),
    fetchChannelSnapshots({
      botToken: input.config.botToken,
      channelIds: channelPlan.snapshotChannelIds,
      primaryChannelId: channelId,
      limit: 6,
      bifrostDiscordChannelId: input.config.bifrostDiscordChannelId,
    }),
    input.config.repoFaceBifrostEnabled
      ? readBifrostGovernanceDigest({
          bifrostRoot: input.config.bifrostRoot,
          repoName: identity.repoName,
          agentIdentity: identity.id,
        })
      : Promise.resolve(undefined),
  ]);
  const roomContext = {
    recentMessages,
    channelSnapshots,
  };
  const humanPronounGuidance = await loadRepoFaceHumanPronounGuidance(input.config, roomContext);
  const personaStateObservation = await readPersonaStateObservation({ identity, storageRoot: input.config.storageRoot });
  const memorySurface = input.memorySurfacePath
    ? await readOptionalMemorySurface(input.memorySurfacePath)
    : await renderRepoFaceMemorySurfaceForTurn(
        identity,
        input.config,
        registry.identities,
        roomContext,
        humanPronounGuidance,
        personaStateObservation,
      );
  const repoActivitySurface = renderRepoActivityObservation(
    readRepoActivity({ identity, storageRoot: input.config.storageRoot }),
  );
  const semanticMemoryRecallSurface = renderPersonaMemoryRecallObservation(await readPersonaMemoryRecall({
    identity,
    config: input.config,
    state: personaStateObservation,
    projectedMemory: memorySurface,
    recentMessages,
    channelSnapshots,
  }));
  const globalAgentDoctrine = await loadGlobalAgentDoctrine();
  const conversationMemorySurface = input.conversationSurfacePath
    ? await readOptionalMemorySurface(input.conversationSurfacePath)
    : undefined;
  const participant = buildInspectionParticipant(
    identity,
    input.config.repoFaceHeartbeats.baseRecoveryMinutes,
  );
  const assembly = assemblePersonaTurn({
    identity,
    channelId,
    channelPlan,
    channelSnapshots,
    recentMessages,
    memorySurface,
    semanticMemoryRecallSurface,
    repoActivitySurface,
    conversationMemorySurface,
    humanPronounGuidance,
    bifrostDigest,
    participant,
    pendingMentions: [],
    githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
    globalAgentDoctrine,
  });

  if (input.outPath) {
    const outPath = resolve(input.outPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, assembly.prompt, "utf8");
  }

  return {
    ok: true,
    identityId: identity.id,
    promptLength: assembly.prompt.length,
    outPath: input.outPath ? resolve(input.outPath) : undefined,
    memorySurfacePath: input.memorySurfacePath ? resolve(input.memorySurfacePath) : undefined,
    conversationSurfacePath: input.conversationSurfacePath ? resolve(input.conversationSurfacePath) : undefined,
  };
}

async function loadGlobalAgentDoctrine(): Promise<string> {
  const candidates = [
    process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, "AGENTS.md") : undefined,
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, ".codex", "AGENTS.md") : undefined,
    resolve(homedir(), ".codex", "AGENTS.md"),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const uniqueCandidates = [...new Set(candidates)];
  const errors: string[] = [];

  for (const candidate of uniqueCandidates) {
    try {
      const content = await readFile(candidate, "utf8");
      if (content.trim().length > 0) {
        return content.trim();
      }
      errors.push(`${candidate}: empty file`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate}: ${message}`);
    }
  }

  return [
    "# Global Agent Instructions Unavailable",
    "",
    "The Face prompt attempted to load the global Codex AGENTS.md file, but no readable file was found.",
    "This is not a replacement doctrine. Treat it as an inspection failure and avoid claiming global guidance was available for this turn.",
    "",
    "Attempted paths:",
    ...errors.map((error) => `- ${error}`),
  ].join("\n");
}

async function renderRepoFaceMemorySurfaceForTurn(
  identity: RepoDiscordIdentity,
  config: ReturnType<typeof loadConfig>,
  registryIdentities: RepoDiscordIdentity[] = [],
  roomContext?: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
  humanPronounGuidance?: RepoFaceHumanPronounGuidance[],
  observation?: PersonaStateObservation,
): Promise<string> {
  if (identity.identityKind === "native_persona") {
    if (!identity.personaStatePath) return [`${identity.displayName} is a native VoidBot Persona, not a repo Face.`, "No Persona state path is registered. Treat that as a Body fault and keep the public turn modest."].join("\n");
  }

  const acquired = observation ?? await readPersonaStateObservation({ identity, storageRoot: config.storageRoot });
  if (acquired.status !== "ok") throw new Error(`${identity.displayName} Persona state ${acquired.status}: ${acquired.reason}`);
  if (acquired.stateKind === "gamecult_persona") {
    return projectGamecultPersonaState(identity, acquired.personaState);
  }
  if (acquired.stateKind === "persona_projection_import") {
    return projectGamecultPersonaState(identity, acquired.projectionImport.payload);
  }
  const typedState = acquired.typedState;
  const curiosityGraphFacts = roomContext && identity.identityKind !== "native_persona"
    ? await renderRepoFaceCuriosityGraphFacts(identity, config, typedState, roomContext)
    : undefined;
  const statePacket = projectPersonaStatePacket({
    identity,
    state: typedState,
    registryIdentities,
    roomContext,
    humanPronounGuidance: humanPronounGuidance ?? await loadRepoFaceHumanPronounGuidance(config, roomContext),
    curiosityGraphFacts,
    observedAt: new Date(),
  });
  if (!config.repoFaceHeartbeats.stateProjectorEnabled) {
    return projectPersonaMemorySurface({
      identityId: identity.id,
      characterIdentity: renderPersonaIdentityDoctrine(identity),
      statePacket,
      modelProjectionEnabled: false,
    });
  }

  return projectPersonaMemorySurface({
    identityId: identity.id,
    characterIdentity: renderPersonaIdentityDoctrine(identity),
    statePacket,
    modelProjectionEnabled: true,
    projectText: (prompt) => projectPersonaText({
      prompt,
      config,
      command: "repo-face-state-projector",
      jobId: `state-projector:${identity.id}:${Date.now()}`,
      timeoutMs: 180_000,
    }),
  });
}

function renderPersonaMemoryRecallObservation(observation: PersonaMemoryRecallObservation): string {
  if (observation.status === "unavailable") {
    return [
      "Semantic Persona memory recall unavailable:",
      `- ${collapseWhitespace(observation.reason, 320)}`,
      "- Do not pretend semantic Persona memory retrieval was available this turn; use projected state and raw transcript instead.",
    ].join("\n");
  }
  if (observation.hits.length === 0) {
    return [
      "- Semantic Persona memory recall ran, but no nearby memories crossed the retrieval threshold.",
      "- Fall back to the projected state, raw transcript, and direct evidence above.",
    ].join("\n");
  }
  return [
    "These are derived Qdrant/local-vector recall hits from this Persona's typed memory. They are hints, not new authority; the `.cc` state remains the owner.",
    ...observation.hits.map((hit, index) => {
      const kind = hit.memoryKind ? `/${hit.memoryKind}` : "";
      const target = hit.targetLabel ?? hit.targetId ?? "unknown target";
      return `- ${index + 1}. ${target}${kind} score=${hit.score.toFixed(3)}: ${collapseWhitespace(hit.text, 520)}`;
    }),
  ].join("\n");
}


async function renderRepoFaceCuriosityGraphFacts(
  identity: RepoDiscordIdentity,
  config: ReturnType<typeof loadConfig>,
  state: VoidSelfStateTypedProjection,
  roomContext: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): Promise<string | undefined> {
  const observation = await readPersonaCuriosityEvidence({
    identity, state, ...roomContext,
    sourceRepoName: getRepoFaceSourceRepoName(identity),
    retrieval: () => {
      const retrieval = createRepoFaceCuriosityRetrievalService(config);
      return {
        searchHistory: (query, limit) => retrieval.searchHistory(query, limit),
        searchSources: (query, limit, repoName) => retrieval.searchRepositorySources(query, limit, repoName ? { repoName } : undefined),
      };
    },
  });
  const backendDescription = config.vectorStore.kind === "qdrant"
    ? `Qdrant collections ${config.qdrant.historyCollection} + ${config.qdrant.sourceCollection}`
    : "local vector shards";
  return projectPersonaCuriosityContext({ identity, state, ...roomContext, observation, backendDescription });
}

function createRepoFaceCuriosityRetrievalService(config: ReturnType<typeof loadConfig>): RetrievalService {
  const historyEmbedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragQueryInstruction,
  });
  const sourceEmbedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragSourceQueryInstruction || config.ragQueryInstruction,
  });
  const stores = createVectorStores({
    kind: config.vectorStore.kind,
    historyPath: config.vectorStore.path,
    personaMemoryPath: config.vectorStore.personaMemoryPath,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder,
    sourceEmbedder,
    personaMemoryEmbedder: historyEmbedder,
  });
  return new RetrievalService(stores.history, stores.source, stores.personaMemory);
}

async function loadRepoFaceHumanPronounGuidance(
  config: ReturnType<typeof loadConfig>,
  roomContext?: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): Promise<RepoFaceHumanPronounGuidance[]> {
  return readPersonaHumanPronounGuidance({
    ownerActorId: config.ownerDiscordId,
    ownerFallbackName: "Metacrat",
    recentMessages: roomContext?.recentMessages ?? [],
    channelSnapshots: roomContext?.channelSnapshots ?? [],
    openProfiles: async () => {
      const storage = await createStateStorage({
        backend: config.stateStorageBackend,
        databaseDsn: config.databaseDsn,
        jobsFile: config.jobsFile,
        auditLogFile: config.auditLogFile,
        interactionMemoryFile: config.interactionMemoryFile,
        rateLimitStateFile: config.rateLimitStateFile,
      });
      return { getProfile: (actorId) => storage.interactionMemory.getProfile(actorId), close: () => storage.close() };
    },
  });
}

function renderRepoActivityObservation(observation: RepoActivityObservation): string {
  if (observation.status === "unconfigured") {
    return "- This Persona has no source repository configured; no repo activity was requested.";
  }
  if (observation.status === "unavailable") {
    return [
      `- Recent ${observation.sourceRepoName} activity could not be read for this turn.`,
      observation.detail ? `- Reader error: ${collapseWhitespace(observation.detail, 500)}` : "- Reader error: no diagnostic output.",
      "- Do not claim current repo state from stale memory; use source/history tools before making fresh claims.",
    ].join("\n");
  }
  if (observation.status === "malformed") {
    return [
      `- Recent ${observation.sourceRepoName} activity output was not parseable.`,
      `- Raw output: ${collapseWhitespace(observation.raw, 500)}`,
      "- Do not claim current repo state from stale memory; use source/history tools before making fresh claims.",
    ].join("\n");
  }
  return observation.digest || `- No recent ${observation.sourceRepoName} activity was reported.`;
}

async function readOptionalMemorySurface(path: string | undefined): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }

  const content = (await readFile(resolve(path), "utf8")).trim();
  return content.length > 0 ? content : undefined;
}

function buildInspectionParticipant(
  identity: RepoDiscordIdentity,
  baseRecoveryMinutes: number,
): FaceHeartbeatParticipant {
  return {
    identityId: identity.id,
    participantKind: "repo_face",
    turnKind: "repo_face_rumination",
    repoName: identity.repoName,
    displayName: identity.displayName,
    initiativeSpeed: 1,
    reactionBias: 0.5,
    interruptThreshold: 0.6,
    currentLoad: 0,
    status: "active",
    groups: [
      "all",
      "kind:repo_face",
      "turn:repo_face_rumination",
      `identity:${normalizeKey(identity.id)}`,
      `repo:${normalizeKey(identity.repoName)}`,
    ],
    heat: 1,
    effectiveSpeed: 1,
    baseRecoveryMinutes,
    nextTurnAt: 0,
    queuedCount: 0,
    constraints: [
      "Prompt assembly is deterministic inspection only.",
      "Character memory and affect prose must come from the Interpreter memory surface.",
    ],
  };
}

function collapseWhitespace(value: string, maxLength?: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return maxLength && normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }

  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
