import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  createStateStorage,
  getRepoDiscordIdentityAllowedChannelIds,
  faceRegistryAsRepoDiscordRegistry,
  loadFaceIdentityRegistry,
  resolveRepoFaceStatePath,
  type RepoFacePendingMention,
  type RepoDiscordIdentity,
} from "@voidbot/core";
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
import { projectNativePersonaBody } from "../apps/persona-scheduler/dist/persona-standard-state-projector.js";
import { assemblePersonaTurn } from "../apps/persona-scheduler/dist/persona-turn-assembler.js";
import { coordinatePersonaMemoryTurn } from "../apps/persona-scheduler/dist/persona-memory-turn-coordinator.js";
import { readGlobalAgentDoctrine } from "../apps/persona-scheduler/dist/global-agent-doctrine-source.js";
import { readStoredPersonaHumanPronounGuidance } from "../apps/persona-scheduler/dist/persona-social-context-source.js";
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
import { buildInspectionParticipant } from "../apps/persona-scheduler/dist/inspection-participant-factory.js";
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
} from "../apps/persona-scheduler/dist/repo-activity-source.js";
import { projectRepoActivityObservation } from "../apps/persona-scheduler/dist/repo-activity-projector.js";

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
  const humanPronounGuidance = await readStoredPersonaHumanPronounGuidance({ config: input.config, ...roomContext });
  const memoryContext = await coordinatePersonaMemoryTurn({
    identity,
    config: input.config,
    registryIdentities: input.registryIdentities,
    ...roomContext,
    humanPronounGuidance,
    stateObservation: input.personaStateObservation,
  });
  const repoActivitySurface = identity.identityKind === "native_persona"
    ? projectNativePersonaBody(identity)
    : projectRepoActivityObservation(readRepoActivity({ identity, storageRoot: input.config.storageRoot }));
  const globalAgentDoctrine = await readGlobalAgentDoctrine({ codexHome: process.env.CODEX_HOME, userProfile: process.env.USERPROFILE });
  const assembly = assemblePersonaTurn({
    identity,
    channelId,
    channelPlan,
    recentMessages,
    channelSnapshots,
    participant: input.participant,
    pendingMentions: input.pendingMentions,
    memorySurface: memoryContext.memorySurface,
    semanticMemoryRecallSurface: memoryContext.semanticMemoryRecallSurface,
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
  const humanPronounGuidance = await readStoredPersonaHumanPronounGuidance({ config: input.config, ...roomContext });
  const personaStateObservation = await readPersonaStateObservation({ identity, storageRoot: input.config.storageRoot });
  const projectedMemoryOverride = input.memorySurfacePath
    ? await readOptionalMemorySurface(input.memorySurfacePath)
    : undefined;
  const memoryContext = await coordinatePersonaMemoryTurn({
    identity,
    config: input.config,
    registryIdentities: registry.identities,
    ...roomContext,
    humanPronounGuidance,
    stateObservation: personaStateObservation,
    projectedMemoryOverride,
  });
  const repoActivitySurface = projectRepoActivityObservation(
    readRepoActivity({ identity, storageRoot: input.config.storageRoot }),
  );
  const globalAgentDoctrine = await readGlobalAgentDoctrine({ codexHome: process.env.CODEX_HOME, userProfile: process.env.USERPROFILE });
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
    memorySurface: memoryContext.memorySurface,
    semanticMemoryRecallSurface: memoryContext.semanticMemoryRecallSurface,
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

async function readOptionalMemorySurface(path: string | undefined): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }

  const content = (await readFile(resolve(path), "utf8")).trim();
  return content.length > 0 ? content : undefined;
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
