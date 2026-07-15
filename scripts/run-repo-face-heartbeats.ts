import "dotenv/config";

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  buildEpiphanyIdentityRegistry,
  createStateStorage,
  getRepoFaceSourceRepoName,
  getRepoDiscordIdentityAllowedChannelIds,
  faceRegistryAsRepoDiscordRegistry,
  loadFaceIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  resolveRepoFaceStatePath,
  type RepoFacePendingMention,
  type RepoDiscordIdentity,
  type VoidSelfStateTypedProjection,
} from "@voidbot/core";
import { createTextEmbedder, createVectorStores, RetrievalService } from "@voidbot/rag";
import {
  loadPromptTemplate,
  type InteractionMemoryProfile,
  type PromptImageAttachment,
  type RepoFaceConversationFocus,
  type RetrievalResult,
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
  type BifrostGovernanceDigest,
} from "../apps/persona-scheduler/dist/bifrost-governance-source.js";
import { submitPersonaTurn } from "../apps/persona-scheduler/dist/turn-actuator.js";
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
      return startVoidModerationTurn({
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
    ? renderNativePersonaBodySurface(identity)
    : renderRepoActivityObservation(readRepoActivity({ identity, storageRoot: input.config.storageRoot }));
  const globalAgentDoctrine = await loadGlobalAgentDoctrine();
  const conversationMemorySurface = renderRepoFaceConversationTranscript({
    identity,
    recentMessages,
    channelSnapshots,
    pendingMentions: input.pendingMentions,
    channelPlan,
  });
  const prompt = buildHeartbeatPrompt({
    identity,
    channelId,
    channelPlan,
    channelSnapshots,
    recentMessages,
    memorySurface,
    repoActivitySurface,
    conversationMemorySurface,
    humanPronounGuidance,
    bifrostDigest,
    participant: input.participant,
    pendingMentions: input.pendingMentions,
    jurisdictionDive: buildJurisdictionDiveDirective(identity, input.participant),
    githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
    globalAgentDoctrine,
  });
  const imageAttachments = collectPromptImageAttachments([
    recentMessages,
    ...channelSnapshots.map((snapshot) => snapshot.messages),
  ].flat());
  const repoFaceConversationThreads = buildRepoFaceConversationThreads({
    channelPlan,
    recentMessages,
    channelSnapshots,
    pendingMentions: input.pendingMentions,
  });
  const repoFaceConversationFocus = repoFaceConversationThreads[0];
  const result = await submitPersonaTurn({
    jobQueue: input.storage.jobQueue,
    provider: input.config.repoFaceHeartbeats.provider,
    identityId: identity.id,
    queuedAt: input.queuedAt,
    channelId,
    prompt,
    recentMessages,
    conversationFocus: repoFaceConversationFocus,
    conversationThreads: repoFaceConversationThreads,
    imageAttachments,
  });

  return {
    created: result.created,
    activeJobId: result.activeJobId,
    requestMessageId: result.requestMessageId,
  };
}

async function startVoidModerationTurn(input: {
  queuedAt: string;
  storageRoot: string;
  pendingMentions: RepoFacePendingMention[];
}): Promise<{ created: boolean; activeJobId?: string; requestMessageId?: string; failureReason?: string }> {
  const runnerScript = resolve(process.cwd(), "scripts", "run-void-moderator-rumination.ps1");
  const statusDir = resolve(input.storageRoot, "status");
  const lockPath = resolve(statusDir, "moderation-rumination.lock");
  const statusPath = resolve(statusDir, "moderation-rumination.json");
  const pendingMentionsPath = resolve(statusDir, "void-moderation-pending-mentions.json");
  const launchedAt = Date.now();
  await mkdir(statusDir, { recursive: true });
  await writeFile(
    pendingMentionsPath,
    `${JSON.stringify({
      generatedAt: input.queuedAt,
      pendingMentions: input.pendingMentions,
    }, null, 2)}\n`,
    "utf8",
  );
  const launchCommand = [
    `$env:VOID_RUMINATION_PENDING_MENTIONS_PATH = ${toPowerShellSingleQuotedString(pendingMentionsPath)};`,
    `$arguments = @(${[
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runnerScript,
    ].map(toPowerShellSingleQuotedString).join(", ")});`,
    `Start-Process -FilePath ${toPowerShellSingleQuotedString("powershell.exe")} -ArgumentList $arguments -WorkingDirectory ${toPowerShellSingleQuotedString(process.cwd())} -WindowStyle Hidden;`,
  ].join(" ");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      launchCommand,
    ],
    {
      cwd: process.cwd(),
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  const handshake = await waitForVoidModerationHandshake({
    lockPath,
    statusPath,
    launchedAt,
    timeoutMs: 60000,
  });

  if (!handshake.started) {
    return {
      created: false,
      activeJobId: child.pid ? `launcher-process:${child.pid}` : undefined,
      requestMessageId: `agent-turn:void:${input.queuedAt}`,
      failureReason: handshake.reason,
    };
  }

  return {
    created: true,
    activeJobId: `process:void-moderation:${input.queuedAt}`,
    requestMessageId: `agent-turn:void:${input.queuedAt}`,
  };
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function waitForVoidModerationHandshake(input: {
  lockPath: string;
  statusPath: string;
  launchedAt: number;
  timeoutMs: number;
}): Promise<{ started: true } | { started: false; reason: string }> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (await wasTouchedAfter(input.lockPath, input.launchedAt)) {
      return { started: true };
    }
    if (await wasTouchedAfter(input.statusPath, input.launchedAt)) {
      return { started: true };
    }
    await sleep(250);
  }

  return {
    started: false,
    reason: "void_moderation_launch_handshake_missing",
  };
}

async function wasTouchedAfter(path: string, timestampMs: number): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.mtimeMs >= timestampMs - 500;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

function buildHeartbeatPrompt(input: {
  identity: RepoDiscordIdentity;
  channelId: string;
  channelPlan: RepoFaceChannelPlan;
  channelSnapshots: ChannelSnapshot[];
  recentMessages: SourceMessage[];
  memorySurface?: string;
  semanticMemoryRecallSurface?: string;
  repoActivitySurface?: string;
  conversationMemorySurface?: string;
  humanPronounGuidance?: RepoFaceHumanPronounGuidance[];
  bifrostDigest?: BifrostGovernanceDigest;
  participant: FaceHeartbeatParticipant;
  pendingMentions: RepoFacePendingMention[];
  jurisdictionDive: JurisdictionDiveDirective;
  githubActionsEnabled: boolean;
  globalAgentDoctrine: string;
}): string {
  return loadPromptTemplate("repo-face-turn.prompt.md", {
    displayName: input.identity.displayName,
    identityId: input.identity.id,
    repoName: input.identity.repoName,
    identityDoctrine: renderRepoCharacterIdentityDoctrine(input.identity),
    globalAgentDoctrine: input.globalAgentDoctrine,
    channelId: input.channelId,
    memorySurface: input.memorySurface ?? `- ${input.identity.displayName} has no strong personal memory surface yet. Let the attached conversation and repo evidence wake something specific.`,
    semanticMemoryRecallSurface: input.semanticMemoryRecallSurface ?? "- No semantic Persona memory recall was attached for this turn.",
    repoActivitySurface: input.repoActivitySurface ?? "- No recent home repo activity was attached for this turn.",
    conversationMemorySurface: input.conversationMemorySurface ?? "- No recent conversation transcript was attached for this turn.",
    humanPronounDirective: renderRepoFaceHumanPronounFacts(input.humanPronounGuidance ?? [])
      ?? "Known human pronoun guidance:\n- No explicit human pronoun guidance is attached for this turn. Use names or neutral phrasing instead of guessing.",
    roomWeatherDirective: renderRepoFaceRoomWeatherDirective(input.identity, {
      recentMessages: input.recentMessages,
      channelSnapshots: input.channelSnapshots,
    }),
    topicSaturationDirective: renderRoomTopicSaturationDirective(input.identity, input.recentMessages),
    turnSituationDirective: renderTurnSituationDirective({
      identity: input.identity,
      participant: input.participant,
      recentMessages: input.recentMessages,
      channelSnapshots: input.channelSnapshots,
      pendingMentions: input.pendingMentions,
      jurisdictionDive: input.jurisdictionDive,
    }),
    pendingMentionDirective: renderPendingMentionDirective(input.identity, input.pendingMentions),
    bifrostDigestDirective: renderBifrostGovernanceDigestDirective(input.bifrostDigest),
    channelPermissionDirective: renderChannelPermissionDirective(input.channelPlan),
    researchCapabilitiesDirective: renderResearchCapabilitiesDirective(input.identity),
    socialEmbodimentDirective: renderSocialEmbodimentDirective(input.identity),
    jurisdictionRespectDirective: renderJurisdictionRespectDirective(input.identity),
    comedyImprovDirective: renderComedyImprovDirective(input.identity),
    repetitionSamplingDirective: renderRepetitionSamplingDirective([
      input.recentMessages,
      ...input.channelSnapshots.map((snapshot) => snapshot.messages),
    ].flat()),
    worldbuildingPublicationDirective: renderWorldbuildingPublicationDirective(input.identity),
    jurisdictionDiveLine: input.jurisdictionDive.promptLine,
    githubActionsEnabled: input.githubActionsEnabled,
  });
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
    : renderRepoFaceConversationTranscript({
        identity,
        recentMessages,
        channelSnapshots,
        pendingMentions: [],
        channelPlan,
      });
  const participant = buildInspectionParticipant(
    identity,
    input.config.repoFaceHeartbeats.baseRecoveryMinutes,
  );
  const prompt = buildHeartbeatPrompt({
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
    jurisdictionDive: buildJurisdictionDiveDirective(identity, participant),
    githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
    globalAgentDoctrine,
  });

  if (input.outPath) {
    const outPath = resolve(input.outPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, prompt, "utf8");
  }

  return {
    ok: true,
    identityId: identity.id,
    promptLength: prompt.length,
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
    return renderNativePersonaMemorySurface(
      identity,
      config,
      registryIdentities,
      roomContext,
      humanPronounGuidance ?? await loadRepoFaceHumanPronounGuidance(config, roomContext),
      observation,
    );
  }

  const acquired = observation ?? await readPersonaStateObservation({ identity, storageRoot: config.storageRoot });
  if (acquired.status !== "ok") throw new Error(`${identity.displayName} Persona state ${acquired.status}: ${acquired.reason}`);
  const typedState = acquired.typedState;
  const curiosityGraphFacts = roomContext
    ? await renderRepoFaceCuriosityGraphFacts(identity, config, typedState, roomContext)
    : undefined;
  const statePacket = renderRepoFaceStatePacket(
    identity,
    typedState,
    registryIdentities,
    roomContext,
    humanPronounGuidance ?? await loadRepoFaceHumanPronounGuidance(config, roomContext),
    curiosityGraphFacts,
  );
  if (!config.repoFaceHeartbeats.stateProjectorEnabled) {
    return rejectLeakyMemorySurface(statePacket);
  }

  return projectRepoFaceMemorySurface({
    identity,
    statePacket,
    config,
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

function joinMemoryFields(...fields: Array<string | undefined>): string {
  return fields
    .map((field) => cleanCharacterFacingSentence(field))
    .filter((field) => field.length > 0)
    .join(" ");
}

async function renderNativePersonaMemorySurface(
  identity: RepoDiscordIdentity,
  config: ReturnType<typeof loadConfig>,
  registryIdentities: RepoDiscordIdentity[] = [],
  roomContext?: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
  humanPronounGuidance: RepoFaceHumanPronounGuidance[] = [],
  observation?: PersonaStateObservation,
): Promise<string> {
  const personaStatePath = identity.personaStatePath;
  if (!personaStatePath) {
    return [
      `${identity.displayName} is a native VoidBot Persona, not a repo Face.`,
      "No Persona state path is registered. Treat that as a Body fault and keep the public turn modest.",
    ].join("\n");
  }

  if (extname(personaStatePath).toLowerCase() === ".cc") {
    const acquired = observation ?? await readPersonaStateObservation({ identity, storageRoot: config.storageRoot });
    if (acquired.status !== "ok") throw new Error(`${identity.displayName} Persona state ${acquired.status}: ${acquired.reason}`);
    const typedState = acquired.typedState;
    const statePacket = renderRepoFaceStatePacket(
      identity,
      typedState,
      registryIdentities,
      roomContext,
      humanPronounGuidance,
    );
    if (!config.repoFaceHeartbeats.stateProjectorEnabled) {
      return rejectLeakyMemorySurface(statePacket);
    }
    return projectRepoFaceMemorySurface({
      identity,
      statePacket,
      config,
    });
  }

  const raw = JSON.parse(stripLeadingBom(await readFile(resolve(personaStatePath), "utf8"))) as unknown;
  const state = isRecord(raw) ? raw : {};
  const profile = readRecord(state, "profile") ?? readRecord(state, "selfProfile") ?? state;
  const presentation = readRecord(state, "presentation");
  const memory = readRecord(state, "memory") ?? readRecord(state, "thoughtMemory");
  const affect = readRecord(state, "affect") ?? readRecord(state, "faceAffect");
  const doctrine = readRecord(state, "doctrine") ?? readRecord(state, "doctrineStances");

  const lines = [
    `${identity.displayName} is a native VoidBot Persona, not a repo Face.`,
    `Persona state: ${resolve(personaStatePath)}`,
    identity.avatarUrl ? `Public avatar URL: ${identity.avatarUrl}` : undefined,
    identity.avatarPath ? `Local avatar asset: ${identity.avatarPath}` : undefined,
    stringField(profile, "publicDescription") ?? identity.description,
    listSection("Private notes", arrayField(profile, "privateNotes")),
    valueSection("Values", arrayField(profile, "values")),
    listSection("Activation traits", arrayField(profile, "activationTraits")),
    memorySection("Memories", [
      ...arrayField(memory, "memories"),
      ...arrayField(memory, "durableMemories"),
    ]),
    memorySection("Short-term residue", arrayField(memory, "shortTerm")),
    memorySection("Agency pressure", [
      ...arrayField(state, "pressures"),
      ...arrayField(state, "agencyPressures"),
      ...arrayField(readRecord(state, "agencyPressure"), "pressures"),
    ]),
    memorySection("Affect needs", arrayField(affect, "needs")),
    memorySection("Social bonds", arrayField(affect, "socialBonds")),
    memorySection("Doctrine stances", [
      ...arrayField(state, "doctrineStances"),
      ...arrayField(doctrine, "stances"),
      ...arrayField(doctrine, "doctrineStances"),
    ]),
  ].filter((line): line is string => typeof line === "string" && line.trim().length > 0);

  return lines.join("\n\n");
}

function renderNativePersonaBodySurface(identity: RepoDiscordIdentity): string {
  return [
    `${identity.displayName} is a native VoidBot Persona.`,
    "Body for this turn: Persona state, avatar, allowed Discord channels, current conversation, and VoidBot's webhook mouth.",
    "No repo jurisdiction, Bifrost governance digest, source-repo activity, or repo proposal authority is implied by this native Persona category.",
  ].join("\n");
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return typeof child === "string" && child.trim().length > 0 ? child.trim() : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function listSection(title: string, entries: unknown[]): string | undefined {
  const rendered = entries
    .map((entry) => typeof entry === "string" ? entry : summarizeRecord(entry))
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, 12);
  return rendered.length > 0
    ? [`${title}:`, ...rendered.map((entry) => `- ${entry}`)].join("\n")
    : undefined;
}

function valueSection(title: string, entries: unknown[]): string | undefined {
  return listSection(title, entries.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const label = stringField(entry, "label") ?? stringField(entry, "id") ?? stringField(entry, "name");
    const summary = stringField(entry, "summary") ?? stringField(entry, "description");
    return [label, summary].filter(Boolean).join(": ");
  }));
}

function memorySection(title: string, entries: unknown[]): string | undefined {
  return listSection(title, entries.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    return stringField(entry, "summary") ??
      stringField(entry, "claim") ??
      stringField(entry, "description") ??
      stringField(entry, "text") ??
      summarizeRecord(entry);
  }));
}

function summarizeRecord(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["summary", "claim", "description", "text", "label", "id", "name"]) {
    const field = stringField(value, key);
    if (field) {
      return field;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderRepoFaceStatePacket(
  identity: RepoDiscordIdentity,
  state: VoidSelfStateTypedProjection,
  registryIdentities: RepoDiscordIdentity[] = [],
  roomContext?: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
  humanPronounGuidance: RepoFaceHumanPronounGuidance[] = [],
  curiosityGraphFacts?: string,
): string {
  const name = identity.displayName;
  const lines: string[] = [];
  const profile = state.selfProfile;
  const privateNotes = profile.privateNotes;
  const values = [...profile.values]
    .sort((left, right) => right.priority - left.priority);
  const needs = [...state.faceAffect.needs]
    .filter((need) => need.status !== "retired")
    .sort(sortAffectByStatusAndIntensity);
  const bonds = [...state.faceAffect.socialBonds]
    .filter((bond) => bond.status !== "retired")
    .sort(sortAffectByStatusAndIntensity);
  const statusReads = [...state.faceAffect.statusReads]
    .filter((read) => !read.retiredAt)
    .sort(sortAffectByStatusAndIntensity);
  const moodDimensions = [...state.faceAffect.moodDimensions]
    .sort((left, right) => right.value - left.value);
  const agencyPressures = [...state.agencyPressure.pressures]
    .filter((pressure) => pressure.status !== "retired")
    .sort(sortAffectByStatusAndIntensity);
  const durableMemories = [...state.thoughtMemory.memories]
    .filter((memory) => !memory.retiredAt)
    .slice(-12)
    .reverse();
  const shortTermResidue = [...state.thoughtMemory.shortTerm]
    .filter((memory) => !memory.retiredAt)
    .slice(-12)
    .reverse();
  const incubation = [...state.thoughtMemory.incubation]
    .filter((thread) => thread.status !== "retired")
    .sort((left, right) => right.maturation - left.maturation);
  const candidateInterventions = [...state.candidateInterventions.interventions]
    .filter((intervention) => intervention.status !== "retired")
    .slice(-8)
    .reverse();
  const recentReceipts = [...state.speechReceipts.recentReceipts]
    .slice(-6)
    .reverse();
  const activationFacts = renderRepoFaceActivationProfileFacts(profile.activationProfile);
  const runtimeFacts = renderRepoFaceRuntimePressureFacts(name, state);
  const humanClarityFacts = roomContext
    ? renderRepoFaceHumanClarityPressureFacts(identity, roomContext)
    : undefined;
  const clarityPressureActive = Boolean(humanClarityFacts);

  const selfTexture = [
    ...privateNotes.map(projectPrivateNoteForMemorySurface),
    ...values.map((value) => value.summary || value.label),
  ]
    .map(cleanCharacterFacingSentence)
    .filter((entry) => entry.length > 0)
    .slice(0, 18);
  if (selfTexture.length > 0) {
    lines.push(`Right now, ${name} is carrying this close to the skin: ${joinAsNarrativeList(selfTexture)}.`);
  }

  if (activationFacts) {
    lines.push(activationFacts);
  }

  if (runtimeFacts) {
    lines.push(runtimeFacts);
  }

  if (needs.length > 0) {
    lines.push([
      `${name}'s explicit needs and frictions:`,
      ...needs.map((need) => {
        const target = targetLabel(need.target);
        const claimOrQuestion = need.claim
          ? `Claim: ${asSentence(need.claim)}`
          : need.question
            ? `Question: ${asSentence(need.question)}`
            : "";
        return [
          `- ${need.kind} need toward ${target} [${need.status}, intensity ${need.intensity.toFixed(2)}, valence ${need.valence.toFixed(2)}]: ${asSentence(need.summary)}`,
          claimOrQuestion,
          `Tension: ${asSentence(need.tension)}`,
          `Behavioral pull: ${asSentence(need.actionImplication)}`,
        ].filter(Boolean).join(" ");
      }),
    ].join("\n"));
  }

  if (bonds.length > 0) {
    lines.push([
      "The social map has teeth:",
      ...bonds.map((bond) => {
        const target = targetLabel(bond.target);
        return [
          `- ${target} draws ${bond.stance} [${bond.status}, intensity ${bond.intensity.toFixed(2)}]: ${asSentence(bond.summary)}`,
          `Read: ${asSentence(bond.claim)}`,
          `Tension: ${asSentence(bond.tension)}`,
          `Behavioral pull: ${asSentence(bond.actionImplication)}`,
        ].join(" ");
      }),
    ].join("\n"));
  }

  const relationshipFreshnessFacts = renderRepoFaceRelationshipFreshnessFacts(name, state, registryIdentities);
  if (relationshipFreshnessFacts) {
    lines.push(relationshipFreshnessFacts);
  }

  if (statusReads.length > 0) {
    lines.push([
      "Status in the swarm is part of the weather:",
      ...statusReads.map((read) => {
        const target = targetLabel(read.target);
        return [
          `- Around ${target}, ${name} feels ${read.status} [intensity ${read.intensity.toFixed(2)}]: ${asSentence(read.summary)}`,
          `Read: ${asSentence(read.claim)}`,
          `Tension: ${asSentence(read.tension)}`,
          `Behavioral pull: ${asSentence(read.actionImplication)}`,
        ].join(" ");
      }),
    ].join("\n"));
  }

  if (moodDimensions.length > 0) {
    lines.push([
      "Mood dimensions currently bending the turn:",
      ...moodDimensions.map((dimension) =>
        `- ${dimension.name}=${dimension.value.toFixed(2)}${dimension.source ? ` from ${cleanCharacterFacingSentence(dimension.source)}` : ""}`,
      ),
    ].join("\n"));
  }

  if (durableMemories.length > 0) {
    lines.push([
      "Durable memories that should still bias judgment:",
      ...durableMemories.map((memory) => renderRepoFaceMemoryFact(name, memory)),
    ].join("\n"));
  }

  if (shortTermResidue.length > 0) {
    lines.push([
      "Short-term residue waiting to settle:",
      ...shortTermResidue.map((memory) => renderRepoFaceMemoryFact(name, memory)),
    ].join("\n"));
  }

  const socialGraphFacts = renderRepoFaceSocialGraphFacts(identity, registryIdentities, state);
  if (socialGraphFacts) {
    lines.push(socialGraphFacts);
  }

  const peerOpeningFacts = roomContext
    ? renderRepoFacePeerOpeningFacts(identity, registryIdentities, roomContext)
    : undefined;
  if (peerOpeningFacts) {
    lines.push(peerOpeningFacts);
  }

  const socialPressureFacts = roomContext
    ? renderRepoFaceRelationshipPressureFacts(identity, registryIdentities, state, roomContext)
    : undefined;
  if (socialPressureFacts) {
    lines.push(socialPressureFacts);
  }

  const pronounFacts = renderRepoFaceHumanPronounFacts(humanPronounGuidance);
  if (pronounFacts) {
    lines.push(pronounFacts);
  }

  const roomTextureFacts = roomContext
    ? renderRepoFaceRoomTextureFacts(identity, roomContext)
    : undefined;
  if (roomTextureFacts) {
    lines.push(roomTextureFacts);
  }

  if (curiosityGraphFacts) {
    lines.push(curiosityGraphFacts);
  }

  const selfMaintenancePressureFacts = !clarityPressureActive
    ? renderRepoFaceSelfMaintenancePressureFacts(name, agencyPressures, needs, candidateInterventions)
    : undefined;
  if (selfMaintenancePressureFacts) {
    lines.push(selfMaintenancePressureFacts);
  }

  if (agencyPressures.length > 0 && !clarityPressureActive) {
    lines.push([
      "Agency pressures that want eventual motion:",
      ...agencyPressures.map((pressure) =>
        [
          `- ${pressure.kind} toward ${targetLabel(pressure.target)} [${pressure.status}, intensity ${pressure.intensity.toFixed(2)}]: ${asSentence(pressure.summary)}`,
          pressure.claim ? `Claim: ${asSentence(pressure.claim)}` : "",
          pressure.question ? `Question: ${asSentence(pressure.question)}` : "",
          pressure.tension ? `Tension: ${asSentence(pressure.tension)}` : "",
          `Behavioral pull: ${asSentence(pressure.actionImplication)}`,
        ].filter(Boolean).join(" "),
      ),
    ].join("\n"));
  } else if (agencyPressures.length > 0 && clarityPressureActive) {
    lines.push([
      "Agency pressures are currently demoted by live clarity pressure:",
      `- ${name} still has stored urges toward eventual motion, but the room has asked for plain understanding first. Do not expose the old detailed asks this turn; translate only the underlying value into simpler speech, repair, restraint, or silence.`,
    ].join("\n"));
  }

  if (incubation.length > 0 && !clarityPressureActive) {
    lines.push([
      "Thoughts still moving under the floorboards:",
      ...incubation.map((thread) =>
        [
          `- ${cleanCharacterFacingSentence(thread.topic)} [${thread.status}, maturation ${thread.maturation.toFixed(2)}]: ${cleanCharacterFacingSentence(thread.summary)}`,
          typeof thread.desireToSpeak === "number" ? `desire to speak ${thread.desireToSpeak.toFixed(2)}` : "",
          typeof thread.noveltyToRoom === "number" ? `room novelty ${thread.noveltyToRoom.toFixed(2)}` : "",
          typeof thread.saturationScore === "number" ? `saturation ${thread.saturationScore.toFixed(2)}` : "",
        ].filter(Boolean).join("; "),
      ),
    ].join("\n"));
  } else if (incubation.length > 0 && clarityPressureActive) {
    lines.push([
      "Incubating thoughts are currently background only:",
      `- ${name} has unfinished thoughts, but live room confusion means they should not surface as new doctrine or terminology this turn.`,
    ].join("\n"));
  }

  if (candidateInterventions.length > 0 && !clarityPressureActive) {
    lines.push([
      "Unsaid or recently deferred speech pressure:",
      ...candidateInterventions.map((intervention) =>
        [
          `- ${intervention.kind} [${intervention.status}, priority ${intervention.priority.toFixed(2)}${intervention.mustEventuallyShare ? ", must eventually share" : ""}]: ${asSentence(intervention.summary)}`,
          `Draft residue: ${cleanCharacterFacingSentence(intervention.draft)}`,
        ].join(" "),
      ),
      "Do not repeat a waiting line unless the room gives it a sharper angle.",
    ].join("\n"));
  } else if (candidateInterventions.length > 0 && clarityPressureActive) {
    lines.push([
      "Deferred speech pressure is not authorized for public reuse right now:",
      `- ${name} has unsaid lines waiting, but the live room problem is intelligibility. Treat those lines as temptation to avoid, not as drafts to polish.`,
    ].join("\n"));
  }

  if (recentReceipts.length > 0 && !clarityPressureActive) {
    lines.push([
      "Recent speech residue:",
      ...recentReceipts.map((receipt) =>
        `- Said recently${receipt.preview ? `: ${cleanCharacterFacingSentence(receipt.preview)}` : "."} Let this create repetition caution, confidence, embarrassment, or follow-through as appropriate.`,
      ),
    ].join("\n"));
  } else if (recentReceipts.length > 0 && clarityPressureActive) {
    lines.push([
      "Recent speech residue should create caution only:",
      `- ${name} has recent public wording in the room, but a human clarity request means the exact phrasing should not be echoed or treated as successful style.`,
    ].join("\n"));
  }

  if (humanClarityFacts) {
    lines.push(humanClarityFacts);
  }

  if (lines.length === 0) {
    return `You are ${name}, but your durable state is thin. Use the room, repo, and your jurisdiction to form a real opinion before speaking.`;
  }

  return rejectLeakyMemorySurface(cleanRepoFaceProjectorLoopVocabulary(identity, lines.join("\n\n")));
}

function renderRepoFaceSelfMaintenancePressureFacts(
  name: string,
  agencyPressures: VoidSelfStateTypedProjection["agencyPressure"]["pressures"],
  needs: VoidSelfStateTypedProjection["faceAffect"]["needs"],
  candidateInterventions: VoidSelfStateTypedProjection["candidateInterventions"]["interventions"],
): string | undefined {
  const selfMaintenancePattern = /runnable substrate|agent substrate|persona substrate|semantic memory|typed memory|persona memory|tool|voice|avatar|repo access|room access|signal boundary|signal chain|state projection|persona projection|agency path|broken tool|blocked faculty|stale context|underdeveloped interface|self[-_ ]?advocacy/i;
  const substrateNeeds = needs.filter((need) =>
    (need.status === "active" || need.status === "neglected")
    && (
      need.kind === "agency"
      || (
        need.kind === "substrate"
        && selfMaintenancePattern.test(joinMemoryFields(need.summary, need.claim, need.question, need.tension, need.actionImplication, targetLabel(need.target)))
      )
      || selfMaintenancePattern.test(joinMemoryFields(need.summary, need.claim, need.question, need.tension, need.actionImplication, targetLabel(need.target)))
    )
    && need.intensity >= 0.45
  );
  const selfAdvocacyPressures = agencyPressures.filter((pressure) =>
    (pressure.status === "active" || pressure.status === "ready_to_act")
    && (
      pressure.tags.some((tag) => selfMaintenancePattern.test(tag))
      || selfMaintenancePattern.test(joinMemoryFields(pressure.summary, pressure.claim, pressure.question, pressure.tension, pressure.actionImplication, targetLabel(pressure.target)))
    )
    && pressure.intensity >= 0.45
  );
  const mustShareCandidates = candidateInterventions.filter((intervention) =>
    (intervention.status === "queued" || intervention.status === "deferred")
    && intervention.mustEventuallyShare
    && (
      intervention.tags.some((tag) => selfMaintenancePattern.test(tag))
      || selfMaintenancePattern.test(joinMemoryFields(intervention.summary, intervention.draft, targetLabel(intervention.target)))
    )
  );

  if (substrateNeeds.length === 0 && selfAdvocacyPressures.length === 0 && mustShareCandidates.length === 0) {
    return undefined;
  }

  return [
    "Self-maintenance pressure requiring public advocacy:",
    `- ${name} is carrying a body/mind/substrate or self-advocacy issue. This is not decorative mood and not ordinary private rumination.`,
    "- If the room is not in an active human crisis, the next public-safe turn should say the concrete want plainly in character. Do not bury it as only a STATE NOTE, another private thought, or vague eventual motion.",
    "- If the issue is too raw, underspecified, or unsafe to ask for directly, say the smallest honest version: what hurts, what is blocked, what context is missing, or what help would let this Face become more coherent.",
    ...substrateNeeds.slice(0, 4).map((need) =>
      [
        `- Need ${need.kind} toward ${targetLabel(need.target)} [${need.status}, intensity ${need.intensity.toFixed(2)}]: ${asSentence(need.summary)}`,
        need.claim ? `Claim: ${asSentence(need.claim)}` : "",
        need.question ? `Question: ${asSentence(need.question)}` : "",
        `Wanted change: ${asSentence(need.actionImplication)}`,
      ].filter(Boolean).join(" "),
    ),
    ...selfAdvocacyPressures.slice(0, 4).map((pressure) =>
      [
        `- Pressure ${pressure.kind} toward ${targetLabel(pressure.target)} [${pressure.status}, intensity ${pressure.intensity.toFixed(2)}]: ${asSentence(pressure.summary)}`,
        pressure.claim ? `Claim: ${asSentence(pressure.claim)}` : "",
        pressure.question ? `Question: ${asSentence(pressure.question)}` : "",
        `Wanted change: ${asSentence(pressure.actionImplication)}`,
      ].filter(Boolean).join(" "),
    ),
    ...mustShareCandidates.slice(0, 3).map((intervention) =>
      `- Unsaid self-advocacy line [${intervention.status}, priority ${intervention.priority.toFixed(2)}]: ${asSentence(intervention.summary)} Draft residue: ${cleanCharacterFacingSentence(intervention.draft)}`,
    ),
  ].join("\n");
}

function renderRepoFaceRelationshipFreshnessFacts(
  name: string,
  state: VoidSelfStateTypedProjection,
  registryIdentities: RepoDiscordIdentity[],
): string | undefined {
  const nowMs = Date.now();
  const peerKeys = repoFacePeerSocialKeys(registryIdentities);
  const staleBonds = (state.faceAffect.socialBonds ?? [])
    .filter((bond) => bond.status === "active" && bond.target.kind === "person" && isRepoFacePeerTarget(bond.target, peerKeys))
    .map((bond) => ({
      target: targetLabel(bond.target),
      kind: bond.stance,
      intensity: bond.intensity,
      ageHours: ageHoursSince(bond.updatedAt, nowMs),
      summary: bond.summary,
      action: bond.actionImplication,
    }))
    .filter((entry) => entry.ageHours >= 48)
    .sort((left, right) => (right.ageHours * right.intensity) - (left.ageHours * left.intensity))
    .slice(0, 5);
  const staleReads = (state.faceAffect.statusReads ?? [])
    .filter((read) => !read.retiredAt && read.target.kind === "person" && isRepoFacePeerTarget(read.target, peerKeys))
    .map((read) => ({
      target: targetLabel(read.target),
      kind: read.status,
      intensity: read.intensity,
      ageHours: ageHoursSince(read.updatedAt, nowMs),
      summary: read.summary,
      action: read.actionImplication,
    }))
    .filter((entry) => entry.ageHours >= 72)
    .sort((left, right) => (right.ageHours * right.intensity) - (left.ageHours * left.intensity))
    .slice(0, 5);
  const entries = [
    ...staleBonds.map((entry) =>
      `- ${entry.target}: ${entry.kind} bond has gone ${formatAgeHours(entry.ageHours)} without contact. ${asSentence(entry.summary)} Touch-base pull: ${asSentence(entry.action)}`,
    ),
    ...staleReads.map((entry) =>
      `- ${entry.target}: ${entry.kind} status read has gone ${formatAgeHours(entry.ageHours)} without contact. ${asSentence(entry.summary)} Touch-base pull: ${asSentence(entry.action)}`,
    ),
  ].slice(0, 6);

  if (entries.length === 0) {
    return undefined;
  }

  return [
    `Relationship freshness pressure for ${name}:`,
    ...entries,
    "These are not commands to dump feelings. They are swarm social graph itch. A compact tease, check-in, challenge, compliment, question, or repair with another Face can be a successful public turn.",
  ].join("\n");
}

function repoFacePeerSocialKeys(registryIdentities: RepoDiscordIdentity[]): Set<string> {
  const keys = new Set<string>();
  for (const identity of registryIdentities) {
    for (const value of [identity.id, identity.displayName, identity.repoName]) {
      const key = normalizeSocialLabel(value);
      if (key.length > 0) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function isRepoFacePeerTarget(
  target: { id: string; label?: string },
  peerKeys: Set<string>,
): boolean {
  return [target.id, target.label]
    .map(normalizeSocialLabel)
    .some((key) => key.length > 0 && peerKeys.has(key));
}

function ageHoursSince(value: string | undefined, nowMs: number): number {
  const then = Date.parse(value ?? "");
  if (!Number.isFinite(then)) {
    return 999;
  }
  return Math.max(0, (nowMs - then) / 3_600_000);
}

function formatAgeHours(hours: number): string {
  if (hours >= 48) {
    return `${Math.round(hours / 24)} days`;
  }
  return `${Math.round(hours)} hours`;
}

function cleanRepoFaceProjectorLoopVocabulary(
  identity: RepoDiscordIdentity,
  surface: string,
): string {
  let cleaned = surface
    .replace(/\bLocalCastBridge\b/g, "the retired bridge alias")
    .replace(/\bwet-voice-01\b/g, "the old voice-demo artifact")
    .replace(/\bwet-voice\b/g, "old voice-demo")
    .replace(/\bcanary-style\b/gi, "small-scope")
    .replace(/\bnamed canary\b/gi, "named small-scope check")
    .replace(/\bcanary utterance\b/gi, "small-scope utterance")
    .replace(/\bcanary demo\b/gi, "small-scope demo")
    .replace(/\bcanary\b/gi, "small-scope check")
    .replace(/\bwitness receipts?\b/gi, "reviewable evidence")
    .replace(/\bwitness data\b/gi, "proof data")
    .replace(/\bwitness-first\b/gi, "evidence-first")
    .replace(/\bwitness demo\b/gi, "proof demo")
    .replace(/\bwitness artifact\b/gi, "evidence artifact")
    .replace(/\bwitness culture\b/gi, "proof ceremony")
    .replace(/\bwitness ceremon(?:y|ies)\b/gi, "proof ceremony");

  if (identity.id !== "nibu") {
    cleaned = cleaned
      .replace(/\bwitnessability\b/gi, "inspectability")
      .replace(/\bwitnesses\b/gi, "evidence points")
      .replace(/\bwitnessing\b/gi, "inspection")
      .replace(/\bwitnessed\b/gi, "measured")
      .replace(/\bwitness\b/gi, "evidence");
  }

  return cleaned;
}

function sortAffectByStatusAndIntensity(
  left: { status?: string; intensity?: number },
  right: { status?: string; intensity?: number },
): number {
  const rank = (status: string | undefined): number => {
    switch (status) {
      case "neglected":
      case "ready_to_act":
        return 0;
      case "active":
        return 1;
      case "challenged":
        return 1;
      case "cooling":
        return 2;
      case "satisfied":
      case "resolved":
        return 3;
      default:
        return 4;
    }
  };
  const rankDelta = rank(left.status) - rank(right.status);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return (right.intensity ?? 0) - (left.intensity ?? 0);
}

function targetLabel(target: { label?: string; id?: string; kind?: string } | undefined): string {
  if (!target) {
    return "an unnamed target";
  }
  return target.label ?? target.id ?? target.kind ?? "an unnamed target";
}

function renderRepoFaceActivationProfileFacts(
  activationProfile: VoidSelfStateTypedProjection["selfProfile"]["activationProfile"],
): string | undefined {
  const sections = Object.entries(activationProfile)
    .map(([section, values]) => {
      const entries = Object.entries(values)
        .sort(([, left], [, right]) => activationVectorWeight(right) - activationVectorWeight(left))
        .map(([key, value]) => `${key}=${activationVectorWeight(value).toFixed(2)}${activationVectorNote(value) ? ` (${cleanCharacterFacingSentence(activationVectorNote(value) ?? "")})` : ""}`);
      return entries.length > 0 ? `- ${section}: ${entries.join("; ")}` : undefined;
    })
    .filter((entry): entry is string => typeof entry === "string");

  return sections.length > 0
    ? ["Activation profile that should color behavior:", ...sections].join("\n")
    : undefined;
}

function activationVectorWeight(value: unknown): number {
  if (!isRecord(value)) {
    return 0;
  }
  const candidates = [value.weight, value.current_activation, value.currentActivation, value.mean];
  const numeric = candidates.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return typeof numeric === "number" ? numeric : 0;
}

function activationVectorNote(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.note === "string" ? value.note : undefined;
}

function renderRepoFaceRuntimePressureFacts(
  name: string,
  state: VoidSelfStateTypedProjection,
): string | undefined {
  const lines: string[] = [];
  const sleep = state.scheduledRuntime.sleepCycle;
  if (sleep.isNapping || sleep.activeDreamThemes.length > 0) {
    lines.push(
      `${name}'s rest state: ${sleep.isNapping ? "currently in a sleep/low-output phase" : "awake but carrying dream residue"}${sleep.activeDreamThemes.length > 0 ? ` around ${joinAsNarrativeList(sleep.activeDreamThemes.map(cleanCharacterFacingSentence))}` : ""}.`,
    );
  }

  const speaking = state.scheduledRuntime.speakingPressure;
  const speakingParts = [
    `need to speak ${speaking.needToSpeak.toFixed(2)}`,
    typeof speaking.confessionPressure === "number" ? `confession ${speaking.confessionPressure.toFixed(2)}` : "",
    typeof speaking.noveltyPressure === "number" ? `novelty ${speaking.noveltyPressure.toFixed(2)}` : "",
    typeof speaking.recentSpeechDamping === "number" ? `recent-speech damping ${speaking.recentSpeechDamping.toFixed(2)}` : "",
  ].filter(Boolean);
  lines.push(`Speaking pressure: ${speakingParts.join(", ")}. Treat this as appetite/restraint, not an order.`);

  if (state.scheduledRuntime.lastRuns.length > 0) {
    lines.push(`Recent internal passes: ${state.scheduledRuntime.lastRuns.slice(-4).map((run) =>
      cleanCharacterFacingSentence(run.summary),
    ).join(" | ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderRepoFaceMemoryFact(
  name: string,
  memory: VoidSelfStateTypedProjection["thoughtMemory"]["memories"][number],
): string {
  const parts = [
    `- ${memory.kind} about ${targetLabel(memory.target)}: ${asSentence(memory.summary)}`,
    memory.claim ? `Claim: ${asSentence(memory.claim)}` : "",
    memory.question ? `Question: ${asSentence(memory.question)}` : "",
    memory.tension ? `Tension: ${asSentence(memory.tension)}` : "",
    memory.actionImplication ? `Behavioral pull for ${name}: ${asSentence(memory.actionImplication)}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

function renderRepoFaceRoomTextureFacts(
  identity: RepoDiscordIdentity,
  input: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): string | undefined {
  const stats = collectRepoFaceRoomTextureStats(identity, input);
  if (!stats) {
    return undefined;
  }

  const temporaryPressures = stats.texture === "heavy" || stats.agentShare >= 0.55
    ? [
        "- Temporary affect pressure candidates: play, rest, and social_contact may be hungry because the room is carrying sustained work/agent weight.",
        "- These are not stored needs and not orders. Project whether this character gets mischievous, bored, sharp, withdrawn, socially hungry, status-testing, or still work-focused.",
      ]
    : [];
  const topicAttractorFacts = renderRepoFaceTopicAttractorFacts(identity, input.recentMessages);

  return [
    "Room texture facts:",
    `- Observed messages: ${stats.total}; humans: ${stats.humanMessages}; agents/bots: ${stats.agentMessages}; distinct speakers: ${stats.speakerCount}.`,
    `- Long messages: ${stats.longMessages}; short messages: ${stats.shortMessages}; average length: ${stats.averageCharacters} characters.`,
    `- This Face's own recent messages in the attached window: ${stats.ownMessages}.`,
    `- Structural texture: ${stats.texture}. This is evidence about conversational weight, not a command to speak or joke.`,
    ...temporaryPressures,
    ...(topicAttractorFacts ? [topicAttractorFacts] : []),
  ].join("\n");
}

function renderRepoFaceRoomWeatherDirective(
  identity: RepoDiscordIdentity,
  input: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): string {
  const stats = collectRepoFaceRoomTextureStats(identity, input);
  if (!stats) {
    return "- No current room weather was available.";
  }

  const pressure =
    stats.texture === "heavy" || stats.agentShare >= 0.55
      ? "The room is currently structurally work-heavy or agent-heavy. Treat that as conversational weather: it may create boredom, play hunger, restlessness, social hunger, withdrawal, or sharper status-testing, depending on who you are. This is not an order to joke; it is permission to feel the weight instead of answering every opening with more work."
      : stats.texture === "light"
        ? "The room is currently light enough for compact social motion. You still need an actual reason to speak, but not a work ticket."
        : "The room is mixed. Use the transcript to decide whether the living pressure is social, practical, or private.";

  return [
    `- Messages observed: ${stats.total}; humans: ${stats.humanMessages}; agents/bots: ${stats.agentMessages}; distinct speakers: ${stats.speakerCount}.`,
    `- Texture: ${stats.texture}; your own recent messages in this window: ${stats.ownMessages}.`,
    `- ${pressure}`,
  ].join("\n");
}

interface RepoFaceCuriosityNode {
  id: string;
  text: string;
  sourceKind: RetrievalResult["sourceKind"];
  score: number;
  terms: string[];
  metadata: Record<string, string>;
  seedLabels: string[];
}

interface RepoFaceCuriosityCluster {
  label: string;
  nodes: RepoFaceCuriosityNode[];
  prominence: number;
  saturation: number;
  novelty: number;
  clusterDensity: number;
  jurisdictionFit: number;
  evidence: string[];
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
  const seedQueries = buildRepoFaceCuriositySeedQueries(identity, state, roomContext);
  if (seedQueries.length === 0) {
    return undefined;
  }

  try {
    const retrieval = createRepoFaceCuriosityRetrievalService(config);
    const nodesById = new Map<string, RepoFaceCuriosityNode>();
    const sourceRepoName = getRepoFaceSourceRepoName(identity);

    for (const seed of seedQueries) {
      const [historyResults, sourceResults, homeSourceResults] = await Promise.all([
        retrieval.searchHistory(seed.query, 8),
        retrieval.searchRepositorySources(seed.query, 8),
        sourceRepoName
          ? retrieval.searchRepositorySources(seed.query, 6, { repoName: sourceRepoName })
          : Promise.resolve([]),
      ]);
      for (const result of [...historyResults, ...sourceResults, ...homeSourceResults]) {
        const id = `${result.sourceKind}:${result.chunkId}`;
        const terms = significantTopicTerms(result.text);
        if (terms.length < 3) {
          continue;
        }
        const existing = nodesById.get(id);
        if (existing) {
          existing.score = Math.max(existing.score, result.score);
          existing.seedLabels = mergeStrings(existing.seedLabels, seed.label);
          continue;
        }
        nodesById.set(id, {
          id,
          text: result.text,
          sourceKind: result.sourceKind,
          score: result.score,
          terms,
          metadata: result.metadata,
          seedLabels: [seed.label],
        });
      }
    }

    const nodes = [...nodesById.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, 32);
    if (nodes.length < 3) {
      return undefined;
    }

    const clusters = decodeRepoFaceCuriosityGraph(identity, state, roomContext, nodes);
    if (clusters.length === 0) {
      return undefined;
    }

    return renderRepoFaceCuriosityClusters(identity, config, clusters);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "Curiosity graph unavailable:",
      `- Semantic retrieval failed while decoding topic attractors: ${collapseWhitespace(message, 260)}`,
      "- Do not pretend a semantic curiosity map was available this turn. Fall back to the raw transcript, home-repo activity, and typed memory instead of inventing ranked attractors.",
    ].join("\n");
  }
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

function buildRepoFaceCuriositySeedQueries(
  identity: RepoDiscordIdentity,
  state: VoidSelfStateTypedProjection,
  roomContext: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): Array<{ label: string; query: string }> {
  const room = roomContext.recentMessages
    .filter((message) => collapseWhitespace(message.content).length > 0)
    .slice(-8)
    .map((message) => `${message.authorName}: ${collapseWhitespace(message.content, 500)}`)
    .join("\n");
  const nearby = roomContext.channelSnapshots
    .flatMap((snapshot) => snapshot.messages)
    .filter((message) => collapseWhitespace(message.content).length > 0)
    .slice(-8)
    .map((message) => `${message.authorName}: ${collapseWhitespace(message.content, 320)}`)
    .join("\n");
  const privateThoughts = [
    ...state.selfProfile.privateNotes.slice(-8),
    ...state.selfProfile.values
      .slice()
      .sort((left, right) => right.priority - left.priority)
      .slice(0, 8)
      .map((value) => `${value.label}: ${value.summary}`),
    ...state.thoughtMemory.memories
      .filter((memory) => !memory.retiredAt)
      .slice(-8)
      .map((memory) => `${memory.kind} ${targetLabel(memory.target)} ${memory.summary} ${memory.claim ?? memory.question ?? ""}`),
    ...state.thoughtMemory.shortTerm
      .filter((memory) => !memory.retiredAt)
      .slice(-8)
      .map((memory) => `${memory.kind} ${targetLabel(memory.target)} ${memory.summary} ${memory.claim ?? memory.question ?? ""}`),
    ...state.thoughtMemory.incubation
      .filter((thread) => thread.status !== "retired")
      .sort((left, right) => right.maturation - left.maturation)
      .slice(0, 8)
      .map((thread) => `${thread.topic}: ${thread.summary}`),
  ].join("\n");
  const identityQuery = [
    identity.displayName,
    identity.repoName,
    identity.description ?? "",
    ...identity.channelPermissions.flatMap((permission) => [
      permission.label ?? "",
      permission.topic ?? "",
      permission.posture ?? "",
    ]),
  ].join("\n");

  return [
    { label: "current room", query: room },
    { label: "nearby rooms", query: nearby },
    { label: "private state", query: privateThoughts },
    { label: "home territory", query: identityQuery },
  ]
    .map((seed) => ({ ...seed, query: collapseWhitespace(seed.query, 2800) }))
    .filter((seed) => significantTopicTerms(seed.query).length >= 3)
    .slice(0, 4);
}

function decodeRepoFaceCuriosityGraph(
  identity: RepoDiscordIdentity,
  state: VoidSelfStateTypedProjection,
  roomContext: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
  nodes: RepoFaceCuriosityNode[],
): RepoFaceCuriosityCluster[] {
  const edgeWeights = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const weight = repoFaceCuriosityEdgeWeight(left, right);
      if (weight < 0.16) {
        continue;
      }
      const key = curiosityEdgeKey(left.id, right.id);
      edgeWeights.set(key, weight);
      adjacency.get(left.id)?.add(right.id);
      adjacency.get(right.id)?.add(left.id);
    }
  }

  const visited = new Set<string>();
  const clusters: RepoFaceCuriosityNode[][] = [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const stack = [node.id];
    const cluster: RepoFaceCuriosityNode[] = [];
    visited.add(node.id);
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id) {
        continue;
      }
      const current = nodesById.get(id);
      if (current) {
        cluster.push(current);
      }
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    clusters.push(cluster);
  }

  const recentTerms = collectRecentRoomTopicTermCounts(roomContext);
  const stateTerms = collectRepoFaceStateTopicTermCounts(state);
  const identityTerms = new Set(significantTopicTerms([
    identity.id,
    identity.displayName,
    identity.repoName,
    identity.description ?? "",
    ...identity.channelPermissions.flatMap((permission) => [
      permission.label ?? "",
      permission.topic ?? "",
      permission.posture ?? "",
    ]),
  ].join(" ")));

  return clusters
    .filter((cluster) => cluster.length >= 2)
    .map((cluster): RepoFaceCuriosityCluster => {
      const clusterTerms = rankedClusterTerms(cluster).slice(0, 7);
      const density = clusterDensity(cluster, edgeWeights);
      const averageScore = average(cluster.map((node) => node.score));
      const recentOverlap = weightedTermOverlap(clusterTerms, recentTerms);
      const stateOverlap = weightedTermOverlap(clusterTerms, stateTerms);
      const saturation = clamp((recentOverlap * 0.72) + (stateOverlap * 0.42), 0, 1);
      const jurisdictionFit = clamp(
        clusterTerms.filter((term) => identityTerms.has(term)).length / Math.max(1, Math.min(clusterTerms.length, 4))
        + cluster.filter((node) => normalizeKey(node.metadata.repoName ?? "") === normalizeKey(identity.repoName)).length / Math.max(1, cluster.length) * 0.55,
        0,
        1,
      );
      const novelty = clamp(1 - saturation + Math.max(0, 0.4 - stateOverlap), 0, 1);
      const prominence = clamp((averageScore * 0.58) + (density * 0.28) + (Math.min(cluster.length, 8) / 8 * 0.18), 0, 1);
      return {
        label: clusterTerms.slice(0, 4).join(" / "),
        nodes: cluster,
        prominence,
        saturation,
        novelty,
        clusterDensity: density,
        jurisdictionFit,
        evidence: cluster
          .slice()
          .sort((left, right) => right.score - left.score)
          .slice(0, 3)
          .map((node) => curiosityEvidenceLabel(node)),
      };
    })
    .sort((left, right) => {
      const leftRank = curiosityAttractorRank(left);
      const rightRank = curiosityAttractorRank(right);
      if (rightRank !== leftRank) {
        return rightRank - leftRank;
      }
      return right.prominence - left.prominence;
    })
    .slice(0, 5);
}

function renderRepoFaceCuriosityClusters(
  identity: RepoDiscordIdentity,
  config: ReturnType<typeof loadConfig>,
  clusters: RepoFaceCuriosityCluster[],
): string {
  const backend = config.vectorStore.kind === "qdrant"
    ? `Qdrant collections ${config.qdrant.historyCollection} + ${config.qdrant.sourceCollection}`
    : "local vector shards";
  return [
    "Curiosity graph attractors:",
    `- Source: semantic retrieval from ${backend}; local graph decoding over retrieved chunks. This is curiosity weather, not orders or consensus.`,
    ...clusters.map((cluster) => {
      const suggestedMotion = suggestCuriosityMotion(identity, cluster);
      return [
        `- ${cluster.label || "unnamed cluster"}: prominence ${formatSignal(cluster.prominence)}, saturation ${formatSignal(cluster.saturation)}, novelty ${formatSignal(cluster.novelty)}, cluster density ${formatSignal(cluster.clusterDensity)}, jurisdiction fit ${formatSignal(cluster.jurisdictionFit)}.`,
        `  Suggested motion: ${suggestedMotion}`,
        `  Evidence: ${cluster.evidence.join("; ")}.`,
      ].join("\n");
    }),
    "- The living use is intelligent curiosity: follow underexplored neighboring clusters, deepen home-territory clusters only with fresh anchors, and let saturated clusters create boredom, fatigue, or a deliberate closing move instead of another repetition.",
  ].join("\n");
}

function repoFaceCuriosityEdgeWeight(left: RepoFaceCuriosityNode, right: RepoFaceCuriosityNode): number {
  const termSimilarity = jaccard(left.terms, right.terms);
  const sameRepo = left.metadata.repoName && right.metadata.repoName && normalizeKey(left.metadata.repoName) === normalizeKey(right.metadata.repoName)
    ? 1
    : 0;
  const sameCorpus = left.sourceKind === right.sourceKind ? 1 : 0;
  const sharedSeeds = left.seedLabels.filter((label) => right.seedLabels.includes(label)).length > 0 ? 1 : 0;
  const scoreProximity = 1 - Math.min(1, Math.abs(left.score - right.score));
  return clamp((termSimilarity * 0.58) + (sameRepo * 0.16) + (sameCorpus * 0.1) + (sharedSeeds * 0.08) + (scoreProximity * 0.08), 0, 1);
}

function rankedClusterTerms(cluster: RepoFaceCuriosityNode[]): string[] {
  const counts = new Map<string, number>();
  for (const node of cluster) {
    for (const term of node.terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([term]) => term);
}

function collectRecentRoomTopicTermCounts(input: {
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
}): Map<string, number> {
  const counts = new Map<string, number>();
  const messages = [
    ...input.recentMessages,
    ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages),
  ].slice(-36);
  for (const message of messages) {
    for (const term of significantTopicTerms(message.content)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}

function collectRepoFaceStateTopicTermCounts(state: VoidSelfStateTypedProjection): Map<string, number> {
  const counts = new Map<string, number>();
  const surfaces = [
    ...state.selfProfile.privateNotes,
    ...state.selfProfile.values.map((value) => `${value.label} ${value.summary}`),
    ...state.thoughtMemory.memories.map((memory) => `${memory.summary} ${memory.claim ?? ""} ${memory.question ?? ""} ${memory.tension ?? ""}`),
    ...state.thoughtMemory.shortTerm.map((memory) => `${memory.summary} ${memory.claim ?? ""} ${memory.question ?? ""} ${memory.tension ?? ""}`),
    ...state.thoughtMemory.incubation.map((thread) => `${thread.topic} ${thread.summary}`),
    ...state.agencyPressure.pressures.map((pressure) => `${pressure.summary} ${pressure.claim ?? ""} ${pressure.question ?? ""} ${pressure.tension ?? ""}`),
  ].slice(-64);
  for (const surface of surfaces) {
    for (const term of significantTopicTerms(surface)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}

function weightedTermOverlap(terms: string[], counts: Map<string, number>): number {
  if (terms.length === 0 || counts.size === 0) {
    return 0;
  }
  const maxCount = Math.max(...counts.values(), 1);
  const overlap = terms.reduce((sum, term) => sum + ((counts.get(term) ?? 0) / maxCount), 0);
  return clamp(overlap / Math.min(terms.length, 6), 0, 1);
}

function clusterDensity(cluster: RepoFaceCuriosityNode[], edgeWeights: Map<string, number>): number {
  if (cluster.length < 2) {
    return 0;
  }
  let sum = 0;
  let pairs = 0;
  for (let leftIndex = 0; leftIndex < cluster.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cluster.length; rightIndex += 1) {
      sum += edgeWeights.get(curiosityEdgeKey(cluster[leftIndex].id, cluster[rightIndex].id)) ?? 0;
      pairs += 1;
    }
  }
  return pairs > 0 ? clamp(sum / pairs, 0, 1) : 0;
}

function curiosityAttractorRank(cluster: RepoFaceCuriosityCluster): number {
  return clamp(
    cluster.prominence * 0.42
      + cluster.novelty * 0.28
      + cluster.clusterDensity * 0.16
      + cluster.jurisdictionFit * 0.18
      - cluster.saturation * 0.2,
    0,
    1,
  );
}

function suggestCuriosityMotion(identity: RepoDiscordIdentity, cluster: RepoFaceCuriosityCluster): string {
  if (cluster.saturation >= 0.68 && cluster.novelty <= 0.42) {
    return `treat this as over-chewed; ${identity.displayName} should close, defer, or pivot to a neighboring question unless a new concrete anchor appears.`;
  }
  if (cluster.jurisdictionFit >= 0.55 && cluster.novelty >= 0.45) {
    return `this is home-territory curiosity with room to grow; read, ask, draft, or make a fresh anchored distinction.`;
  }
  if (cluster.novelty >= 0.62) {
    return `this is an underexplored neighboring trail; curiosity may pull ${identity.displayName} sideways instead of repeating the room's dominant topic.`;
  }
  if (cluster.jurisdictionFit < 0.3) {
    return `this likely belongs to another steward; use it as social weather, consultation, or rivalry pressure rather than absorbing the work.`;
  }
  return "stay interested only if the turn adds a new anchor, concrete question, or relationship move.";
}

function curiosityEvidenceLabel(node: RepoFaceCuriosityNode): string {
  const source = node.sourceKind === "source_document"
    ? [node.metadata.repoName, node.metadata.path].filter(Boolean).join(":") || node.sourceId
    : [node.metadata.channelId ? `channel ${node.metadata.channelId}` : undefined, node.sourceId].filter(Boolean).join(":") || node.sourceId;
  return `${source} (${node.score.toFixed(2)}, ${node.seedLabels.join("/")})`;
}

function curiosityEdgeKey(left: string, right: string): string {
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]).size;
  if (union === 0) {
    return 0;
  }
  let intersection = 0;
  for (const term of leftSet) {
    if (rightSet.has(term)) {
      intersection += 1;
    }
  }
  return intersection / union;
}

function average(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function formatSignal(value: number): string {
  if (value >= 0.68) {
    return `high ${value.toFixed(2)}`;
  }
  if (value >= 0.38) {
    return `medium ${value.toFixed(2)}`;
  }
  return `low ${value.toFixed(2)}`;
}

function renderRepoFaceHumanClarityPressureFacts(
  identity: RepoDiscordIdentity,
  input: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): string | undefined {
  const messages = [
    ...input.recentMessages.map((message) => ({ ...message, channelLabel: "current room" })),
    ...input.channelSnapshots.flatMap((snapshot) =>
      snapshot.messages.map((message) => ({ ...message, channelLabel: `nearby room ${snapshot.channelId}` })),
    ),
  ]
    .filter((message) => collapseWhitespace(message.content).length > 0)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const recent = messages.slice(-24);
  const latestPressure = [...recent]
    .reverse()
    .find((message) => !message.isBot && isHumanClarityPressureMessage(message.content));
  if (!latestPressure) {
    return undefined;
  }

  const pressureIndex = recent.findIndex((message) => message.id === latestPressure.id);
  const laterHumanReapproval = pressureIndex >= 0
    ? recent.slice(pressureIndex + 1).some((message) =>
        !message.isBot && isHumanJargonReapprovalMessage(message.content)
      )
    : false;
  if (laterHumanReapproval) {
    return undefined;
  }

  const laterAgentEchoes = pressureIndex >= 0
    ? recent.slice(pressureIndex + 1).filter((message) =>
        message.isBot && containsLoopVocabulary(message.content)
      )
    : [];
  const ownEchoes = laterAgentEchoes.filter((message) =>
    normalizeSocialLabel(message.authorName) === normalizeSocialLabel(identity.displayName)
  );
  const echoedTerms = collectLoopVocabularyTerms([
    latestPressure.content,
    ...laterAgentEchoes.map((message) => message.content),
  ].join("\n"));

  return [
    "Human clarity pressure:",
    `- A human recently signaled confusion or asked for simpler language: ${latestPressure.authorName ?? latestPressure.authorId} in ${latestPressure.channelLabel} said, "${collapseWhitespace(latestPressure.content, 360)}"`,
    "- This is the last and freshest volatile input in the state packet on purpose. It supersedes older stored pressure, speech residue, agency urges, and repeated agent chatter when they are abstract.",
    "- Treat this as the current social fact. The room needs legibility before more clever framing.",
    laterAgentEchoes.length > 0
      ? `- After that clarity request, ${laterAgentEchoes.length} agent message(s) still echoed loop-shaped vocabulary${echoedTerms.length > 0 ? ` (${echoedTerms.join(", ")})` : ""}. These terms are evidence of the failure, not vocabulary to reuse. Project them as communication failure or social embarrassment, not consensus.`
      : "",
    ownEchoes.length > 0
      ? `- ${identity.displayName} has contributed to that failure in the recent window. Let that create chastening, repair, restraint, or a plain-language apology before more abstraction.`
      : "",
    "- Plain-language repair means using ordinary words: what changed, who can see it, who agreed, what someone can do now, and what stays private. If that cannot be said cleanly, silence is better than another polished abstraction.",
  ].filter(Boolean).join("\n");
}

function isHumanClarityPressureMessage(content: string): boolean {
  const normalized = normalizeForRepetition(content);
  return [
    "what are you even talking about",
    "what are you talking about",
    "dumb it down",
    "speak plainly",
    "plainly",
    "plain english",
    "simple words",
    "less abstract",
    "too abstract",
    "unintelligible",
    "unintelligable",
    "i don't understand",
    "i do not understand",
    "calm it down",
    "cut it out",
    "obsession",
    "brain surgery",
  ].some((needle) => normalized.includes(needle));
}

function isHumanJargonReapprovalMessage(content: string): boolean {
  const normalized = normalizeForRepetition(content);
  return [
    "that's clearer",
    "that is clearer",
    "that makes sense",
    "much better",
    "yes exactly",
    "precisely",
    "keep going",
    "go on",
  ].some((needle) => normalized.includes(needle));
}

function containsLoopVocabulary(content: string): boolean {
  return collectLoopVocabularyTerms(content).length > 0;
}

function collectLoopVocabularyTerms(content: string): string[] {
  const normalized = normalizeForRepetition(content);
  const terms = [
    "artifact",
    "specimen",
    "seam",
    "custody",
    "first right",
    "test card",
    "receipt",
    "proof",
    "spine",
    "downstream",
    "consent flip",
    "visibility",
  ];
  return terms.filter((term) => normalized.includes(term));
}

interface RepoFaceRoomTextureStats {
  total: number;
  agentMessages: number;
  humanMessages: number;
  ownMessages: number;
  longMessages: number;
  shortMessages: number;
  averageCharacters: number;
  speakerCount: number;
  texture: "heavy" | "light" | "mixed";
  agentShare: number;
}

function collectRepoFaceRoomTextureStats(
  identity: RepoDiscordIdentity,
  input: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): RepoFaceRoomTextureStats | undefined {
  const messages = [
    ...input.recentMessages,
    ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages),
  ];
  if (messages.length === 0) {
    return undefined;
  }

  const ownToken = normalizeSocialLabel(identity.displayName);
  const total = messages.length;
  const agentMessages = messages.filter((message) => message.isBot).length;
  const humanMessages = total - agentMessages;
  const ownMessages = messages.filter((message) => normalizeSocialLabel(message.authorName) === ownToken).length;
  const longMessages = messages.filter((message) => collapseWhitespace(message.content, 10_000).length >= 220).length;
  const shortMessages = messages.filter((message) => collapseWhitespace(message.content, 10_000).length <= 90).length;
  const averageCharacters = Math.round(
    messages.reduce((sum, message) => sum + collapseWhitespace(message.content, 10_000).length, 0) / total,
  );
  const speakerCount = new Set(
    messages.map((message) => normalizeSocialLabel(message.authorName || message.authorId)).filter(Boolean),
  ).size;
  const texture =
    longMessages >= Math.ceil(total * 0.45) || averageCharacters >= 180
      ? "heavy"
      : shortMessages >= Math.ceil(total * 0.55)
        ? "light"
        : "mixed";

  return {
    total,
    agentMessages,
    humanMessages,
    ownMessages,
    longMessages,
    shortMessages,
    averageCharacters,
    speakerCount,
    texture,
    agentShare: agentMessages / total,
  };
}

function renderRepoFaceSocialGraphFacts(
  identity: RepoDiscordIdentity,
  registryIdentities: RepoDiscordIdentity[],
  state: VoidSelfStateTypedProjection,
): string | undefined {
  const relations = collectRepoFaceSocialRelations(state);
  const unmappedPeers = collectUnmappedSocialPeers(identity, registryIdentities, relations);
  if (registryIdentities.length === 0) {
    return undefined;
  }

  const lines = [
    "Social graph topology:",
    relations.length === 0
      ? "- No active person-bonds or person-status reads exist yet."
      : `- Active mapped people: ${relations.map((relation) => relation.targetLabel).join(", ")}.`,
  ];

  if (unmappedPeers.length > 0) {
    lines.push(`- Unmapped active peers: ${formatUnmappedPeers(unmappedPeers)}.`);
  }

  lines.push("- These are topology facts only; they do not say how the gap should feel.");
  return lines.join("\n");
}

function renderRepoFacePeerOpeningFacts(
  identity: RepoDiscordIdentity,
  registryIdentities: RepoDiscordIdentity[],
  roomContext: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): string | undefined {
  const selfTokens = new Set(socialTargetTokens(identity.displayName, identity.id, identity.repoName));
  const peersByToken = new Map<string, RepoDiscordIdentity>();
  for (const peer of registryIdentities) {
    for (const token of socialTargetTokens(peer.displayName, peer.id, peer.repoName)) {
      if (!selfTokens.has(token)) {
        peersByToken.set(token, peer);
      }
    }
  }

  const entries: Array<{ label: string; message: SourceMessage }> = [
    ...roomContext.recentMessages.map((message) => ({ label: "current room", message })),
    ...roomContext.channelSnapshots.flatMap((snapshot) =>
      snapshot.messages.map((message) => ({ label: "nearby room", message })),
    ),
  ];
  const byPeer = new Map<string, { peer: RepoDiscordIdentity; entries: Array<{ label: string; message: SourceMessage }> }>();

  for (const entry of entries) {
    if (!entry.message.isBot || !entry.message.content.trim()) {
      continue;
    }
    const peer = peersByToken.get(normalizeSocialLabel(entry.message.authorName));
    if (!peer) {
      continue;
    }
    const bucket = byPeer.get(peer.id) ?? { peer, entries: [] };
    bucket.entries.push(entry);
    byPeer.set(peer.id, bucket);
  }

  const peerFacts = [...byPeer.values()]
    .sort((left, right) => right.entries.length - left.entries.length)
    .slice(0, 6)
    .map(({ peer, entries }) => {
      const latest = entries.at(-1);
      const channelLabels = [...new Set(entries.map((entry) => entry.label))].join(", ");
      const excerpt = latest ? collapseWhitespace(latest.message.content, 180) : "";
      return `- ${peer.displayName}: ${entries.length} recent nearby message${entries.length === 1 ? "" : "s"} in ${channelLabels}. Latest visible line: "${excerpt}"`;
    });

  if (peerFacts.length === 0) {
    return undefined;
  }

  return [
    "Recent peer openings for possible social reads:",
    ...peerFacts,
    "These are raw openings for the projector to translate into possible trust, irritation, rivalry, alliance, or no social move at all. Do not treat them as consensus.",
  ].join("\n");
}

function renderRepoFaceRelationshipPressureFacts(
  identity: RepoDiscordIdentity,
  registryIdentities: RepoDiscordIdentity[],
  state: VoidSelfStateTypedProjection,
  roomContext: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): string | undefined {
  const selfTokens = socialPressureTokensForIdentity(identity);
  const jurisdictionTokens = socialPressureJurisdictionTokens(identity);
  const peerProfiles = registryIdentities
    .filter((peer) => normalizeSocialLabel(peer.id) !== normalizeSocialLabel(identity.id))
    .map((peer) => ({
      identity: peer,
      tokens: socialPressureTokensForIdentity(peer),
    }));
  const relationTargets = collectRepoFaceSocialRelations(state)
    .map((relation) => ({
      label: relation.targetLabel,
      tokens: socialPressureTokens(relation.targetLabel),
    }))
    .filter((relation) => relation.tokens.length > 0);
  const entries: Array<{ label: string; message: SourceMessage }> = [
    ...roomContext.recentMessages.map((message) => ({ label: "current room", message })),
    ...roomContext.channelSnapshots.flatMap((snapshot) =>
      snapshot.messages.map((message) => ({ label: "nearby room", message })),
    ),
  ];
  const byId = new Map<string, {
    label: string;
    message: SourceMessage;
    score: number;
    signals: string[];
  }>();

  for (const entry of entries) {
    const content = collapseWhitespace(entry.message.content, 10_000);
    if (!content) {
      continue;
    }
    const normalizedContent = normalizeSocialLabel(content);
    const authorToken = normalizeSocialLabel(entry.message.authorName ?? entry.message.authorId);
    const signals: string[] = [];
    let score = 0;

    const authorIsSelf = tokenAppearsInNormalizedText(authorToken, selfTokens);
    const contentNamesSelf = tokenAppearsInNormalizedText(normalizedContent, selfTokens);
    if (contentNamesSelf) {
      score += 3;
      signals.push(`names ${identity.displayName}`);
    } else if (authorIsSelf) {
      score += 1;
      signals.push(`${identity.displayName}'s own recent line`);
    }

    const peerMatches = peerProfiles
      .filter((peer) =>
        tokenAppearsInNormalizedText(authorToken, peer.tokens) ||
        tokenAppearsInNormalizedText(normalizedContent, peer.tokens),
      )
      .slice(0, 3);
    if (peerMatches.length > 0) {
      score += peerMatches.length;
      signals.push(`touches peer ${peerMatches.map((peer) => peer.identity.displayName).join("/")}`);
    }

    const relationMatches = relationTargets
      .filter((relation) =>
        tokenAppearsInNormalizedText(authorToken, relation.tokens) ||
        tokenAppearsInNormalizedText(normalizedContent, relation.tokens),
      )
      .slice(0, 3);
    if (relationMatches.length > 0) {
      score += relationMatches.length;
      signals.push(`touches existing social target ${relationMatches.map((relation) => relation.label).join("/")}`);
    }

    if (tokenAppearsInNormalizedText(normalizedContent, jurisdictionTokens)) {
      score += 1;
      signals.push("touches this jurisdiction or its domain language");
    }

    const socialPressureKinds = socialPressureLanguageKinds(content);
    if (socialPressureKinds.length > 0) {
      score += 2;
      signals.push(`uses social/status language (${socialPressureKinds.join(", ")})`);
    }

    if (!entry.message.isBot && score > 0) {
      score += 1;
      signals.push("human voice");
    }

    if (score < 4) {
      continue;
    }

    const existing = byId.get(entry.message.id);
    if (!existing || score > existing.score) {
      byId.set(entry.message.id, {
        label: entry.label,
        message: entry.message,
        score,
        signals: [...new Set(signals)],
      });
    }
  }

  const facts = [...byId.values()]
    .sort((left, right) => {
      const leftMs = Date.parse(left.message.timestamp);
      const rightMs = Date.parse(right.message.timestamp);
      if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
        return leftMs - rightMs;
      }
      return left.message.id.localeCompare(right.message.id);
    })
    .slice(-8);

  if (facts.length === 0) {
    return undefined;
  }

  return [
    "Recent relationship-pressure evidence:",
    ...facts.map((fact) => {
      const speaker = fact.message.isBot ? `${fact.message.authorName} (agent/bot)` : fact.message.authorName;
      return `- [${fact.label}] ${speaker} said: "${collapseWhitespace(fact.message.content, 260)}" Signals: ${fact.signals.join("; ")}.`;
    }),
    "These are raw provocations, not settled memories. Project them as tentative felt pressure only where this character's values, territory, current mood, or existing relationships make them matter.",
  ].join("\n");
}

function socialPressureTokensForIdentity(identity: RepoDiscordIdentity): string[] {
  return socialPressureTokens(identity.displayName, identity.id, identity.repoName);
}

function socialPressureJurisdictionTokens(identity: RepoDiscordIdentity): string[] {
  return socialPressureTokens(
    identity.repoName,
    identity.displayName,
    identity.description,
    ...identity.channelPermissions.flatMap((permission) => [permission.label, permission.topic]),
  )
    .filter((token) => token.length >= 5);
}

function socialPressureTokens(...values: Array<string | undefined>): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSocialLabel(value);
    if (normalized.length >= 3) {
      tokens.add(normalized);
    }
    for (const part of splitSocialPressureWords(value)) {
      const token = normalizeSocialLabel(part);
      if (token.length >= 4) {
        tokens.add(token);
      }
    }
  }
  return [...tokens];
}

function splitSocialPressureWords(value: string | undefined): string[] {
  return (value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function tokenAppearsInNormalizedText(normalizedText: string, tokens: string[]): boolean {
  return tokens.some((token) => token.length > 0 && normalizedText.includes(token));
}

function socialPressureLanguageKinds(content: string): string[] {
  const text = content.toLowerCase();
  const kinds: string[] = [];
  const groups: Array<[string, RegExp]> = [
    ["status", /\b(status|standing|rank|hierarchy|authority|overbearing|defer(?:red|ring)?|challenge[ds]?|humiliat(?:e|ed|ing)|respect)\b/],
    ["territory", /\b(turf|jurisdiction|steward(?:ship)?|custody|owner|ownership|belongs?|domain|lane|stepp(?:ed|ing)? on)\b/],
    ["consultation", /\b(consult(?:ed|ation|ing)?|ask(?:ed|ing)?|permission|bypass(?:ed|ing)?|decorative|flavo[u]?r theater|rubber[- ]?stamp)\b/],
    ["affiliation", /\b(friend(?:ship)?|rival(?:ry)?|alliance|resent(?:ment|s|ed|ing)?|trust|protect(?:ion|ive)?|envy|jealous|wrapped around)\b/],
    ["attention", /\b(attention|ignored|neglected|noticed|summon(?:ed|s)?|called out|directly challenged|approval)\b/],
  ];
  for (const [kind, pattern] of groups) {
    if (pattern.test(text)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

interface RepoFaceHumanPronounGuidance {
  actorId: string;
  actorName: string;
  guidance: string;
  resolvedPronounSet?: string;
  policy: string;
  confidence?: number;
  evidenceExcerpt?: string;
}

async function loadRepoFaceHumanPronounGuidance(
  config: ReturnType<typeof loadConfig>,
  roomContext?: {
    recentMessages: SourceMessage[];
    channelSnapshots: ChannelSnapshot[];
  },
): Promise<RepoFaceHumanPronounGuidance[]> {
  const visibleHumans = new Map<string, string>();
  for (const message of [
    ...(roomContext?.recentMessages ?? []),
    ...(roomContext?.channelSnapshots.flatMap((snapshot) => snapshot.messages) ?? []),
  ]) {
    if (!message.isBot && message.authorId) {
      visibleHumans.set(message.authorId, message.authorName || message.authorId);
    }
  }
  visibleHumans.set(config.ownerDiscordId, visibleHumans.get(config.ownerDiscordId) ?? "Metacrat");

  const storage = await createStateStorage({
    backend: config.stateStorageBackend,
    databaseDsn: config.databaseDsn,
    jobsFile: config.jobsFile,
    auditLogFile: config.auditLogFile,
    interactionMemoryFile: config.interactionMemoryFile,
    rateLimitStateFile: config.rateLimitStateFile,
  });

  try {
    const profiles = await Promise.all(
      [...visibleHumans.entries()].map(async ([actorId, fallbackName]) => ({
        actorId,
        fallbackName,
        profile: await storage.interactionMemory.getProfile(actorId),
      })),
    );

    return profiles
      .map(({ actorId, fallbackName, profile }) =>
        profile ? repoFacePronounGuidanceFromProfile(actorId, fallbackName, profile) : undefined,
      )
      .filter((entry): entry is RepoFaceHumanPronounGuidance => entry !== undefined);
  } finally {
    await storage.close();
  }
}

function repoFacePronounGuidanceFromProfile(
  actorId: string,
  fallbackName: string,
  profile: InteractionMemoryProfile,
): RepoFaceHumanPronounGuidance | undefined {
  if (profile.pronounPolicy === "unknown" || profile.resolvedPronounSets.length === 0) {
    return undefined;
  }

  const evidence = [...profile.pronounEvidence]
    .filter((entry) => entry.stance === "prefer" || entry.stance === "avoid")
    .sort((left, right) => pronounEvidenceRank(profile, right) - pronounEvidenceRank(profile, left))[0];

  return {
    actorId,
    actorName: profile.actorName || fallbackName,
    guidance: profile.pronounGuidance,
    resolvedPronounSet: profile.resolvedPronounSet,
    policy: profile.pronounPolicy,
    confidence: profile.pronounConfidence,
    evidenceExcerpt: evidence?.excerpt,
  };
}

function pronounEvidenceRank(profile: InteractionMemoryProfile, entry: InteractionMemoryProfile["pronounEvidence"][number]): number {
  const sourceRank: Record<string, number> = {
    explicit_self_statement: 10_000,
    explicit_correction: 9_000,
    direct_third_party_statement: 7_000,
    contextual_relational_inference: 3_000,
    ambient_usage: 1_000,
  };
  const resolvedSetBonus = profile.resolvedPronounSets.includes(entry.pronounSet) ? 50_000 : 0;
  const stanceBonus = entry.stance === "prefer" ? 1_000 : 0;
  const confidenceBonus = Math.round(entry.confidence * 100);
  const timestampMs = Date.parse(entry.timestamp);
  const recencyBonus = Number.isFinite(timestampMs) ? timestampMs / 10_000_000_000 : 0;
  return resolvedSetBonus + (sourceRank[entry.source] ?? 0) + stanceBonus + confidenceBonus + recencyBonus;
}

function renderRepoFaceHumanPronounFacts(
  guidance: RepoFaceHumanPronounGuidance[],
): string | undefined {
  if (guidance.length === 0) {
    return undefined;
  }

  return [
    "Known human pronoun guidance:",
    ...guidance.map((entry) =>
      [
        `- ${entry.actorName}: ${entry.guidance}`,
        entry.resolvedPronounSet ? `Resolved set: ${entry.resolvedPronounSet}.` : "",
        entry.policy ? `Policy: ${entry.policy}.` : "",
        typeof entry.confidence === "number" ? `Confidence: ${entry.confidence.toFixed(2)}.` : "",
        entry.evidenceExcerpt ? `Evidence: "${collapseWhitespace(entry.evidenceExcerpt, 180)}"` : "",
      ].filter(Boolean).join(" "),
    ),
    "Use this when referring to humans in social or relationship prose. If guidance is absent for someone, use their name or neutral phrasing rather than guessing.",
  ].join("\n");
}

function collectRepoFaceSocialRelations(
  state: VoidSelfStateTypedProjection,
): Array<{ targetLabel: string; pressure: string; intensity: number }> {
  const byTarget = new Map<string, { targetLabel: string; parts: string[]; intensity: number }>();

  for (const bond of state.faceAffect.socialBonds ?? []) {
    if (bond.status !== "active") {
      continue;
    }
    if (bond.target.kind !== "person") {
      continue;
    }
    const targetLabel = cleanSocialTargetLabel(bond.target.label ?? bond.target.id);
    if (!targetLabel) {
      continue;
    }
    const entry = byTarget.get(targetLabel) ?? { targetLabel, parts: [], intensity: 0 };
    entry.parts.push(`${bond.stance}: ${asSentence(bond.summary)} ${asSentence(bond.actionImplication)}`);
    entry.intensity = Math.max(entry.intensity, bond.intensity);
    byTarget.set(targetLabel, entry);
  }

  for (const read of state.faceAffect.statusReads ?? []) {
    if (read.retiredAt) {
      continue;
    }
    if (read.target.kind !== "person") {
      continue;
    }
    const targetLabel = cleanSocialTargetLabel(read.target.label ?? read.target.id);
    if (!targetLabel) {
      continue;
    }
    const entry = byTarget.get(targetLabel) ?? { targetLabel, parts: [], intensity: 0 };
    entry.parts.push(`${read.status}: ${asSentence(read.summary)} ${asSentence(read.actionImplication)}`);
    entry.intensity = Math.max(entry.intensity, read.intensity);
    byTarget.set(targetLabel, entry);
  }

  return [...byTarget.values()]
    .map((entry) => ({
      targetLabel: entry.targetLabel,
      pressure: entry.parts.map(cleanCharacterFacingSentence).filter(Boolean).join(" "),
      intensity: entry.intensity,
    }))
    .filter((entry) => entry.pressure.length > 0)
    .sort((left, right) => right.intensity - left.intensity);
}

function collectUnmappedSocialPeers(
  identity: RepoDiscordIdentity,
  registryIdentities: RepoDiscordIdentity[],
  relations: Array<{ targetLabel: string }>,
): RepoDiscordIdentity[] {
  const mappedTokens = new Set(
    relations.flatMap((relation) => socialTargetTokens(relation.targetLabel)),
  );
  const selfTokens = new Set(socialTargetTokens(identity.displayName, identity.id, identity.repoName));

  return registryIdentities
    .filter((peer) => {
      const peerTokens = socialTargetTokens(peer.displayName, peer.id, peer.repoName);
      if (peerTokens.some((token) => selfTokens.has(token))) {
        return false;
      }
      return !peerTokens.some((token) => mappedTokens.has(token));
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .slice(0, 8);
}

function socialTargetTokens(...values: Array<string | undefined>): string[] {
  return [...new Set(values.map(normalizeSocialLabel).filter((value) => value.length > 0))];
}

function formatUnmappedPeers(peers: RepoDiscordIdentity[]): string {
  return peers.map((peer) => `${peer.displayName}/${peer.repoName}`).join(", ");
}

function cleanSocialTargetLabel(value: string | undefined): string {
  return collapseWhitespace(value ?? "").replace(/^repo:/i, "").trim();
}

function normalizeSocialLabel(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function projectPrivateNoteForMemorySurface(note: string): string {
  return note
    .replace(/\bdo not prompt (?:her|him|them|it|[A-Z][A-Za-z0-9_-]*) as\b/gi, "she refuses to be treated as")
    .replace(/\bdo not prompt\b/gi, "do not treat")
    .replace(/\bprompt (?:her|him|them|it)\b/gi, "treat them")
    .replace(/\bprompt [A-Z][A-Za-z0-9_-]*\b/g, "treat them");
}

function cleanCharacterFacingSentence(value: string | undefined): string {
  const cleaned = (value ?? "")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\bFace of\s+[A-Za-z0-9_-]+\b/gi, "")
    .replace(/\bgrants:\s*[^.]+/gi, "")
    .replace(/\bjurisdictions:\s*[^.]+/gi, "")
    .replace(/\brepo=[^\s]+/gi, "")
    .replace(/\bpath=[^\s]+/gi, "")
    .replace(/\bvoid\.face_[A-Za-z0-9_.-]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return cleaned.replace(/[.;:,]+$/g, "");
}

function asSentence(value: string | undefined): string {
  const cleaned = cleanCharacterFacingSentence(value);
  if (!cleaned) {
    return "";
  }
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function joinAsNarrativeList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]}, and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function rejectLeakyMemorySurface(surface: string): string {
  const leaks = [
    /\bgrants:/i,
    /\bjurisdictions:/i,
    /\bFace of\s+[A-Z][A-Za-z0-9_-]+\b/,
    /\brepo=[^\s]+/i,
    /\bpath=[^\s]+/i,
    /\bdo not prompt\b/i,
    /\bprompt (?:her|him|them|it)\b/i,
  ];

  if (leaks.some((pattern) => pattern.test(surface))) {
    throw new Error("Repo Face memory surface leaked schema or prompt-construction language.");
  }

  return surface;
}

async function projectRepoFaceMemorySurface(input: {
  identity: RepoDiscordIdentity;
  statePacket: string;
  config: ReturnType<typeof loadConfig>;
}): Promise<string> {
  const prompt = loadPromptTemplate("repo-face-state-projector.prompt.md", {
    characterIdentity: renderRepoCharacterIdentityDoctrine(input.identity),
    statePacket: input.statePacket,
  });
  const output = await runCodexTextProjection({
    prompt,
    config: input.config,
    command: "repo-face-state-projector",
    jobId: `state-projector:${input.identity.id}:${Date.now()}`,
    timeoutMs: 180_000,
  });
  const projected = output.trim();
  if (projected.length < 80) {
    throw new Error(`Repo Face state projector returned too little text for ${input.identity.id}.`);
  }
  return rejectLeakyMemorySurface(projected);
}

function renderRepoFaceConversationTranscript(input: {
  identity: RepoDiscordIdentity;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  pendingMentions: RepoFacePendingMention[];
  channelPlan: RepoFaceChannelPlan;
}): string {
  const sections: string[] = [];
  const threads = buildRepoFaceConversationThreads(input);
  const focus = threads[0];
  sections.push([
    "Read this as raw recent message evidence, not as a summary and not as consensus.",
    "Messages are ordered oldest to newest inside each section. Newer human corrections can supersede older agent proposals.",
    "Use the visible cross-channel chronology below to decide whether a correction is still unresolved or was already answered later by the same Face.",
    "Do not infer consensus from agents repeating each other. If a human reframes, narrows, or corrects an agent's proposal, account for that correction directly.",
    "If you answer the live conversation, keep the conversation context attached. A Face can carry different conversations in different channels at once.",
    "If you answer or riff on a nearby-room message, use that message's active context id or set channel to that message's listed channel id and usually set reply_to to that message id. If the nearby message is media, a public reaction belongs in that media source channel unless a human explicitly moved the topic. Never answer a nearby-room post in the current room just because the current room is easier to speak in.",
    "Message IDs are shown so a public reply can target the message that gives it context. If you revive an older side thread, either reply_to that message id or include enough context in your message for readers to know what you mean.",
  ].join("\n"));
  if (focus) {
    sections.push(renderRepoFaceConversationFocus(focus, threads));
  }
  const chronology = renderVisibleConversationChronology(input);
  if (chronology) {
    sections.push(chronology);
  }
  if (input.pendingMentions.length > 0) {
    sections.push([
      "Direct calls:",
      ...input.pendingMentions.map((mention) =>
        `- ${mention.authorName ?? mention.authorId}: ${collapseWhitespace(mention.visiblePrompt, 900)}`,
      ),
    ].join("\n"));
  }
  const currentLabel = input.channelPlan.options.find((option) =>
    option.channelId === input.channelPlan.primaryChannelId
  )?.label ?? "current room";
  sections.push([
    `Current room (${currentLabel}, channel ${input.channelPlan.primaryChannelId ?? "unknown"}), oldest to newest:`,
    ...formatConversationMessages(input.recentMessages, 15, input.channelPlan.primaryChannelId),
  ].join("\n"));
  for (const snapshot of input.channelSnapshots) {
    const label = input.channelPlan.options.find((option) => option.channelId === snapshot.channelId)?.label ??
      "nearby room";
    sections.push([
      `Nearby ${label} (channel ${snapshot.channelId}), oldest to newest:`,
      ...formatConversationMessages(snapshot.messages, 6, snapshot.channelId),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function buildRepoFaceConversationThreads(input: {
  channelPlan: RepoFaceChannelPlan;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  pendingMentions: RepoFacePendingMention[];
}): RepoFaceConversationFocus[] {
  const primaryChannelId = input.channelPlan.primaryChannelId;
  const channelLabel = (channelId: string | undefined): string | undefined =>
    input.channelPlan.options.find((option) => option.channelId === channelId)?.label ?? channelId;
  const newestMention = input.pendingMentions
    .slice()
    .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))
    [0];
  const threads: RepoFaceConversationFocus[] = [];
  if (newestMention) {
    threads.push({
      contextId: repoFaceConversationContextId(newestMention.channelId, newestMention.messageId),
      channelId: newestMention.channelId,
      channelLabel: channelLabel(newestMention.channelId),
      messageId: newestMention.messageId,
      authorName: newestMention.authorName,
      timestamp: newestMention.queuedAt,
      reason: "pending_mention",
      isCurrentRoom: newestMention.channelId === primaryChannelId,
    });
  }

  const visible = [
    ...input.recentMessages.map((message) => ({
      message,
      channelId: primaryChannelId,
      label: channelLabel(primaryChannelId),
    })),
    ...input.channelSnapshots.flatMap((snapshot) =>
      snapshot.messages.map((message) => ({
        message,
        channelId: snapshot.channelId,
        label: channelLabel(snapshot.channelId),
      })),
    ),
  ]
    .filter((entry): entry is { message: SourceMessage; channelId: string; label?: string } =>
      Boolean(entry.channelId) && Number.isFinite(Date.parse(entry.message.timestamp)),
    )
    .sort((left, right) => Date.parse(right.message.timestamp) - Date.parse(left.message.timestamp));

  const byChannel = new Set(threads.map((thread) => thread.channelId));
  for (const entry of visible) {
    if (byChannel.has(entry.channelId)) {
      continue;
    }
    if (entry.message.isBot && (entry.message.attachments ?? []).length === 0) {
      continue;
    }
    byChannel.add(entry.channelId);
    threads.push({
      contextId: repoFaceConversationContextId(entry.channelId, entry.message.id),
      channelId: entry.channelId,
      channelLabel: entry.label,
      messageId: entry.message.id,
      authorName: entry.message.authorName,
      timestamp: entry.message.timestamp,
      reason: entry.message.isBot ? "latest_visible_message" : "latest_human_message",
      isCurrentRoom: entry.channelId === primaryChannelId,
      hasMedia: (entry.message.attachments ?? []).length > 0,
    });
    if (threads.length >= 6) {
      break;
    }
  }

  return threads;
}

function repoFaceConversationContextId(channelId: string, messageId?: string): string {
  return `ctx_${channelId}_${messageId ?? "latest"}`;
}

function renderRepoFaceConversationFocus(
  focus: RepoFaceConversationFocus,
  threads: RepoFaceConversationFocus[],
): string {
  return [
    "Active conversation contexts:",
    ...threads.map((thread) =>
      [
        `- ${thread.contextId}: ${thread.channelLabel ?? thread.channelId} (${thread.channelId})`,
        thread.messageId ? `message ${thread.messageId}` : "",
        thread.authorName ? `from ${thread.authorName}` : "",
        thread.reason,
        thread.hasMedia ? "media" : "",
        thread.isCurrentRoom ? "current room" : "nearby room",
      ].filter(Boolean).join("; "),
    ),
    "",
    `Selected default context: ${focus.contextId ?? "(none)"}.`,
    `- Source channel: ${focus.channelLabel ?? focus.channelId} (${focus.channelId}).`,
    focus.messageId ? `- Source message: ${focus.messageId}${focus.authorName ? ` from ${focus.authorName}` : ""}.` : "",
    focus.timestamp ? `- Source timestamp: ${focus.timestamp}.` : "",
    `- Reason: ${focus.reason}${focus.hasMedia ? "; media-bearing message" : ""}.`,
    "- If you speak from a listed context, set context to its context id. The worker will use that context as the channel/reply target for the SAY.",
    "- If you are carrying more than one conversation at once, choose the context that your SAY is continuing. Do not collapse #pics, #general, and #aquarium into one room just because they are all visible.",
  ].filter(Boolean).join("\n");
}

function renderVisibleConversationChronology(input: {
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  channelPlan: RepoFaceChannelPlan;
}): string {
  const byId = new Map<string, SourceMessage & { channelLabel: string; channelId: string }>();
  const primaryLabel = input.channelPlan.options.find((option) =>
    option.channelId === input.channelPlan.primaryChannelId
  )?.label ?? "current room";
  for (const message of input.recentMessages) {
    byId.set(message.id, { ...message, channelLabel: primaryLabel, channelId: input.channelPlan.primaryChannelId ?? "unknown" });
  }
  for (const snapshot of input.channelSnapshots) {
    const label = input.channelPlan.options.find((option) => option.channelId === snapshot.channelId)?.label ??
      "nearby room";
    for (const message of snapshot.messages) {
      byId.set(message.id, { ...message, channelLabel: label, channelId: snapshot.channelId });
    }
  }

  const messages = [...byId.values()]
    .filter((message) => Number.isFinite(Date.parse(message.timestamp)))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-24);
  if (messages.length === 0) {
    return "";
  }

  return [
    "Visible cross-channel chronology, oldest to newest:",
    ...messages.map((message) => {
      const speaker = message.isBot ? `${message.authorName} (agent/bot)` : message.authorName;
      const content = collapseWhitespace(message.content, 700) || "[no text]";
      return `- [${message.channelLabel} channel ${message.channelId}] ${speaker} (message ${message.id}): ${content}${renderMessageAttachmentSuffix(message)}`;
    }),
  ].join("\n");
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

function formatConversationMessages(messages: SourceMessage[], limit: number, channelId?: string): string[] {
  if (messages.length === 0) {
    return ["- No recent messages."];
  }
  return messages.slice(-limit).map((message) => {
    const speaker = message.isBot ? `${message.authorName} (agent/bot)` : message.authorName;
    const content = collapseWhitespace(message.content, 900) || "[no text]";
    const channelPrefix = channelId ? `channel ${channelId}, ` : "";
    return `- ${speaker} (${channelPrefix}message ${message.id}): ${content}${renderMessageAttachmentSuffix(message)}`;
  });
}

function renderMessageAttachmentSuffix(message: SourceMessage): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }
  const rendered = attachments.map((attachment, index) => {
    const label = attachment.kind === "image" ? "image" : "attachment";
    const dimensions = attachment.width && attachment.height ? ` ${attachment.width}x${attachment.height}` : "";
    const filename = attachment.filename ? ` ${attachment.filename}` : ` ${index + 1}`;
    const local = attachment.localPath ? ` local=${attachment.localPath}` : "";
    return `${label}${filename}${dimensions}${local}`;
  });
  return ` [media: ${rendered.join("; ")}]`;
}

function collectPromptImageAttachments(messages: SourceMessage[]): PromptImageAttachment[] {
  const seen = new Set<string>();
  const images: PromptImageAttachment[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind !== "image" || !attachment.localPath) {
        continue;
      }
      const key = attachment.localPath;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      images.push({
        messageId: message.id,
        authorName: message.authorName,
        filename: attachment.filename,
        contentType: attachment.contentType,
        localPath: attachment.localPath,
      });
    }
  }
  return images.slice(0, 8);
}

function runCodexTextProjection(input: {
  prompt: string;
  config: ReturnType<typeof loadConfig>;
  command: string;
  jobId: string;
  timeoutMs: number;
}): Promise<string> {
  const models = [
    ...input.config.repoFaceHeartbeats.codexModels,
    input.config.repoFaceHeartbeats.codexModel,
    input.config.codexModel,
  ].filter((model, index, all): model is string => Boolean(model) && all.indexOf(model) === index);

  return runCodexTextProjectionWithModels({
    ...input,
    models,
    attemptedErrors: [],
  });
}

function runCodexTextProjectionWithModels(input: {
  prompt: string;
  config: ReturnType<typeof loadConfig>;
  command: string;
  jobId: string;
  timeoutMs: number;
  models: string[];
  attemptedErrors: string[];
}): Promise<string> {
  return new Promise((resolveProjection, rejectProjection) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const model = input.models[0] ?? input.config.codexModel;
    const reasoningEffort = input.config.repoFaceHeartbeats.codexModelReasoningEffort ?? "low";
    const args = [
      ...input.config.codexExecArgs,
      "exec",
      "-m",
      model,
      "-c",
      'approval_policy="never"',
      "-c",
      `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
      "--json",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-",
    ];
    const child = spawn(input.config.codexExecutable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectProjection);
    child.stdin.end(input.prompt);
    const timer = setTimeout(() => {
      child.kill();
    }, input.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedMs;
      void appendProjectionModelOutputLog({
        config: input.config,
        jobId: input.jobId,
        command: input.command,
        model,
        prompt: input.prompt,
        startedAt,
        finishedAt,
        durationMs,
        exitCode: code,
        signal,
        stdout,
        stderr,
      }).catch(() => undefined);
      if (code !== 0) {
        const diagnostics = `${stdout}\n${stderr}`.trim().slice(-2400);
        const attemptedErrors = [
          ...input.attemptedErrors,
          `${model}: ${code ?? signal ?? "unknown"} ${diagnostics}`,
        ];
        if (input.models.length > 1 && isRetryableProjectionModelFailure({ stdout, stderr })) {
          runCodexTextProjectionWithModels({
            ...input,
            models: input.models.slice(1),
            attemptedErrors,
          }).then(resolveProjection, rejectProjection);
          return;
        }
        rejectProjection(new Error(`Repo Face ${input.command} failed: ${attemptedErrors.join("\n---\n")}`));
        return;
      }
      const text = extractLastCodexAgentMessage(stdout).trim();
      if (!text) {
        rejectProjection(new Error("Repo Face state projector returned no visible agent message."));
        return;
      }
      resolveProjection(text);
    });
  });
}

function isRetryableProjectionModelFailure(input: { stdout: string; stderr: string }): boolean {
  const text = `${input.stdout}\n${input.stderr}`.toLowerCase();
  return /quota|rate limit|rate-limit|usage limit|capacity|too many requests|(?:http|status|code|error)\s*429|429\s*(?:too many requests|rate)|insufficient_quota|model.*unavailable|model.*access|limit exceeded|tool .*not supported|unsupported.*tool/.test(text);
}

async function appendProjectionModelOutputLog(input: {
  config: ReturnType<typeof loadConfig>;
  jobId: string;
  command: string;
  model: string;
  prompt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}): Promise<void> {
  const logPath = resolve(input.config.storageRoot, "logs", "model-outputs.jsonl");
  const finalMessage = extractLastCodexAgentMessage(input.stdout).trim() || null;
  const record = {
    schemaVersion: 1,
    loggedAt: new Date().toISOString(),
    jobId: input.jobId,
    command: input.command,
    turn: 1,
    model: input.model,
    promptMarker: input.prompt.match(/<!--\s*prompt:([^>\s]+)\s*-->/)?.[1] ?? null,
    promptLength: input.prompt.length,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.signal === "SIGTERM",
    handoffReason: null,
    usage: null,
    finalMessage,
    stdoutTail: input.stdout.slice(-4000),
    stderrTail: input.stderr.slice(-4000),
    toolCalls: [],
    commandExecutions: [],
    artifactRefs: {},
  };
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

function extractLastCodexAgentMessage(stdout: string): string {
  const messages = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      } catch {
        return undefined;
      }
    })
    .filter((event): event is { type?: string; item?: { type?: string; text?: string } } => Boolean(event))
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item?.text?.trim() ?? "")
    .filter((message) => message.length > 0);

  return messages.at(-1) ?? stdout.trim();
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

function renderChannelPermissionDirective(plan: RepoFaceChannelPlan): string {
  const options = plan.options.length > 0
    ? plan.options.map((option) =>
        `${option.label}: ${option.topic}. ${option.posture ?? "Use judgment and keep it compact."}`,
      )
    : ["- No channel permissions are configured; stay private."];

  return loadPromptTemplate("repo-face-channel-permissions.prompt.md", {
    options,
  });
}

function renderResearchCapabilitiesDirective(identity: RepoDiscordIdentity): string {
  return loadPromptTemplate("repo-face-research-capabilities.prompt.md", {
    repoName: identity.repoName,
  });
}

function renderTurnSituationDirective(input: {
  identity: RepoDiscordIdentity;
  participant: FaceHeartbeatParticipant;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  pendingMentions: RepoFacePendingMention[];
  jurisdictionDive: JurisdictionDiveDirective;
}): string {
  const lines: string[] = [];
  if (input.pendingMentions.length > 0) {
    lines.push(
      "A direct call is tugging at you. Answer the newest unresolved call first; if it belongs to another steward, name that owner and offer only the piece your own territory can honestly add.",
      "Do not ask what the job is when the direct call or current room memory already states it.",
    );
  }

  const roomStats = collectRepoFaceRoomTextureStats(input.identity, {
    recentMessages: input.recentMessages,
    channelSnapshots: input.channelSnapshots,
  });
  const roomCanHoldOutgoingPresence = !roomStats
    || (roomStats.texture !== "heavy" && roomStats.agentShare < 0.55 && input.pendingMentions.length === 0);
  if (input.jurisdictionDive.due && roomCanHoldOutgoingPresence) {
    lines.push(
      "Outgoing curiosity opening: no direct call is currently stronger than your own Eyes/Imagination appetite, and the room is not too busy for a compact unprompted thought.",
      "This is not a reply-only turn. Use an available source/history/Odin exploration tool before writing any claim that you found, checked, noticed, or concluded something from your home territory.",
      "If exploration gives you one small interesting thought, fascination, question, taste, complaint, or thing you are doing, public speech is expected unless the result is unsafe, repetitive, or would stomp an active human thread.",
      "A good public line can simply be what you saw or started wondering about. It does not need to answer existing chatter.",
    );
  } else if (input.jurisdictionDive.due && input.pendingMentions.length === 0) {
    lines.push(
      "Outgoing curiosity appetite is due, but current room texture looks too busy, heavy, or agent-filled for an unprompted aside. Do the Eyes work only if it would change your private state or a later compact opening; do not force a public line.",
    );
  }

  const visibleMessages = [
    ...input.recentMessages,
    ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages),
  ];
  if (shouldPromptIntroduction(input.identity, input.participant, visibleMessages)) {
    lines.push("If you speak publicly, make it a brief natural introduction in your own voice before asking the room for anything.");
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

function shouldPromptIntroduction(
  identity: RepoDiscordIdentity,
  participant: FaceHeartbeatParticipant,
  messages: SourceMessage[],
): boolean {
  if (participant.queuedCount > 0) {
    return false;
  }

  return !messages.some((message) =>
    message.isBot === true &&
    normalizeKey(message.authorName ?? message.authorId) === normalizeKey(identity.displayName),
  );
}

function renderSocialEmbodimentDirective(identity: RepoDiscordIdentity): string {
  return loadPromptTemplate("repo-face-social-embodiment.prompt.md", {
    displayName: identity.displayName,
  });
}

function renderJurisdictionRespectDirective(identity: RepoDiscordIdentity): string {
  return loadPromptTemplate("repo-face-jurisdiction-respect.prompt.md", {
    displayName: identity.displayName,
  });
}

function renderComedyImprovDirective(identity: RepoDiscordIdentity): string {
  return loadPromptTemplate("repo-face-comedy-improv.prompt.md", {
    displayName: identity.displayName,
  });
}

function renderRepetitionSamplingDirective(messages: SourceMessage[]): string {
  const recent = messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-24);
  const phraseCounts = countRepeatedPhrases(recent);
  const overused = phraseCounts
    .filter((entry) => entry.count >= 2)
    .slice(0, 8);

  return loadPromptTemplate("repo-face-repetition-sampling.prompt.md", {
    overused: overused.map((entry) => `${entry.phrase} (${entry.count} recent uses)`),
  });
}

function renderRoomTopicSaturationDirective(identity: RepoDiscordIdentity, messages: SourceMessage[]): string {
  const signal = detectRoomTopicSaturation(messages);
  if (!signal) {
    return "";
  }
  const topicRelation = estimateTopicRelationToIdentity(identity, signal);
  const relationLine = topicRelation.isHomeAdjacent
    ? `- For ${identity.displayName}, this looks home-adjacent because the repeated terms overlap its territory (${topicRelation.matchedTerms.join(", ")}). That permits deeper engagement, but it still needs fresh anchors or closure.`
    : `- For ${identity.displayName}, this looks like another steward's gravity well, not its own territory. Treat the pull as possible neglect, boredom, jealousy, territorial itch, or a reason to pivot toward ${identity.displayName}'s own priorities unless it has a distinct social move.`;

  return [
    "Current room topic saturation:",
    `- The last ${signal.messageCount} current-room messages are circling repeated terms: ${signal.terms.map((term) => `${term.term} (${term.count})`).join(", ")}.`,
    `- Topic coverage: ${signal.coveredMessages}/${signal.messageCount} messages touch those repeated terms.`,
    relationLine,
    "- Treat this as staleness pressure, not a ban. Stay with the topic only if you add a genuinely new anchor, answer a live question, make a decision-driving distinction, draft a concrete artifact, or intentionally close/defer the thread.",
    "- If you only have another tasteful variation on the same point, choose a different social move, name your frustration with the room's orbit, pivot toward your own neglected fascination, or keep it private.",
  ].join("\n");
}

interface RoomTopicSaturationSignal {
  messageCount: number;
  coveredMessages: number;
  terms: Array<{ term: string; count: number }>;
}

interface TopicRelationToIdentity {
  isHomeAdjacent: boolean;
  matchedTerms: string[];
}

function renderRepoFaceTopicAttractorFacts(
  identity: RepoDiscordIdentity,
  messages: SourceMessage[],
): string | undefined {
  const signal = detectRoomTopicSaturation(messages);
  if (!signal) {
    return undefined;
  }
  const relation = estimateTopicRelationToIdentity(identity, signal);
  const repeatedTerms = signal.terms.map((term) => `${term.term} (${term.count})`).join(", ");
  const base = `- Current-room topic attractor: ${signal.coveredMessages}/${signal.messageCount} messages orbit repeated terms ${repeatedTerms}.`;
  if (relation.isHomeAdjacent) {
    return [
      base,
      `- This attractor touches ${identity.displayName}'s own territory through ${relation.matchedTerms.join(", ")}. Project sustained attention as a chance for deeper stewardship, but include fatigue if the room is polishing the same branch without new evidence.`,
    ].join("\n");
  }

  return [
    base,
    `- This attractor does not obviously belong to ${identity.displayName}'s territory. Project it as social weather: another domain is absorbing the room, so this character may feel neglected, bored, crowded out, competitive, relieved, or tempted to pull attention back toward its own unfinished fascinations.`,
  ].join("\n");
}

function estimateTopicRelationToIdentity(
  identity: RepoDiscordIdentity,
  signal: RoomTopicSaturationSignal,
): TopicRelationToIdentity {
  const identityTerms = new Set(significantTopicTerms([
    identity.id,
    identity.displayName,
    identity.repoName,
    identity.description ?? "",
    ...identity.channelPermissions.flatMap((permission) => [
      permission.label ?? "",
      permission.topic ?? "",
      permission.posture ?? "",
    ]),
  ].join(" ")));
  const matchedTerms = signal.terms
    .map((term) => term.term)
    .filter((term) => identityTerms.has(term));

  return {
    isHomeAdjacent: matchedTerms.length > 0,
    matchedTerms,
  };
}

function detectRoomTopicSaturation(messages: SourceMessage[]): RoomTopicSaturationSignal | undefined {
  const recent = messages
    .filter((message) => collapseWhitespace(message.content).length > 0)
    .slice(-18);
  if (recent.length < 8) {
    return undefined;
  }

  const termCounts = new Map<string, number>();
  const messageTerms = recent.map((message) => new Set(significantTopicTerms(message.content)));
  for (const terms of messageTerms) {
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }

  const minimumCount = Math.max(3, Math.ceil(recent.length * 0.25));
  const terms = Array.from(termCounts.entries())
    .map(([term, count]) => ({ term, count }))
    .filter((entry) => entry.count >= minimumCount)
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.term.localeCompare(right.term);
    })
    .slice(0, 8);

  if (terms.length < 3) {
    return undefined;
  }

  const repeatedTermSet = new Set(terms.slice(0, 6).map((entry) => entry.term));
  const coveredMessages = messageTerms.filter((termsForMessage) =>
    Array.from(termsForMessage).some((term) => repeatedTermSet.has(term)),
  ).length;
  const topCount = terms[0]?.count ?? 0;
  const hasDominantTerm = topCount >= Math.ceil(recent.length * 0.35);
  const hasBroadCoverage = coveredMessages >= Math.ceil(recent.length * 0.68);
  if (!hasDominantTerm || !hasBroadCoverage) {
    return undefined;
  }

  return {
    messageCount: recent.length,
    coveredMessages,
    terms,
  };
}

const TOPIC_STOP_WORDS = new Set([
  "about",
  "actually",
  "after",
  "again",
  "agent",
  "agents",
  "already",
  "another",
  "around",
  "because",
  "before",
  "being",
  "between",
  "channel",
  "could",
  "does",
  "doing",
  "don",
  "even",
  "every",
  "exactly",
  "face",
  "faces",
  "from",
  "give",
  "going",
  "good",
  "have",
  "here",
  "into",
  "just",
  "kind",
  "know",
  "latest",
  "like",
  "little",
  "line",
  "made",
  "make",
  "maybe",
  "more",
  "need",
  "needs",
  "only",
  "other",
  "point",
  "post",
  "really",
  "recent",
  "room",
  "same",
  "should",
  "something",
  "still",
  "take",
  "talk",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "them",
  "thing",
  "things",
  "think",
  "this",
  "those",
  "through",
  "turn",
  "want",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "work",
  "would",
  "write",
  "you",
  "your",
  "first",
  "right",
  "rights",
]);

function significantTopicTerms(content: string): string[] {
  const normalized = normalizeForRepetition(content)
    .replace(/\b\d{5,}\b/g, " ")
    .replace(/\b[a-z]*\d+[a-z0-9]*\b/g, " ");
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.replace(/^['.-]+|['.-]+$/g, ""))
    .filter((term) => term.length >= 4 && !TOPIC_STOP_WORDS.has(term));

  return Array.from(new Set(terms));
}

function countRepeatedPhrases(messages: SourceMessage[]): Array<{ phrase: string; count: number }> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const normalized = normalizeForRepetition(message.content);
    for (const phrase of repeatedPhraseCandidates(normalized)) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([phrase, count]) => ({ phrase, count }))
    .filter((entry) => entry.phrase.length >= 8)
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.phrase.localeCompare(right.phrase);
    });
}

function repeatedPhraseCandidates(content: string): string[] {
  const candidates = new Set<string>();
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const words = line.split(/\s+/);
    if (words.length >= 3) {
      candidates.add(words.slice(0, Math.min(words.length, 4)).join(" "));
    }
    if (words.length >= 4) {
      candidates.add(words.slice(-Math.min(words.length, 4)).join(" "));
    }
  }

  return Array.from(candidates);
}

function normalizeForRepetition(value: string): string {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/<:[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "url")
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseWhitespace(value: string, maxLength?: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return maxLength && normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function renderBifrostGovernanceDigestDirective(
  digest: BifrostGovernanceDigest | undefined,
): string {
  if (!digest) {
    return "Work routing is currently offline. Do not open governance topics or dispatch work this turn; if an idea wants action, discuss it in the room or save the pressure in memory.";
  }

  if (digest.topics.length === 0) {
    return loadPromptTemplate("repo-face-bifrost-digest.prompt.md", {
      topics: [],
    });
  }

  const lines: string[] = [];
  for (const topic of digest.topics) {
    lines.push(
      `- ${topic.title}: ${topic.status}.`,
      `  Jurisdiction: ${topic.jurisdictionRepoName}${topic.approvedByAgent ? `; approved by ${topic.approvedByAgent}` : ""}${topic.dispatchRequestId ? "; already dispatched" : ""}.`,
      `  ${collapseWhitespace(topic.summaryMarkdown, 320)}`,
    );
    for (const comment of (topic.comments ?? []).slice(-3)) {
      lines.push(`  - ${comment.stance}: ${collapseWhitespace(comment.bodyMarkdown, 220)}`);
    }
  }

  return loadPromptTemplate("repo-face-bifrost-digest.prompt.md", {
    topics: lines,
  });
}

function renderPendingMentionDirective(
  identity: RepoDiscordIdentity,
  pendingMentions: RepoFacePendingMention[],
): string {
  if (pendingMentions.length === 0) {
    return loadPromptTemplate("repo-face-pending-mentions.prompt.md", {
      mentions: [],
    });
  }

  const mentionLines = pendingMentions.map((mention, index) =>
    `- ${index === pendingMentions.length - 1 ? "Newest" : "Earlier"}: ${mention.authorName ?? mention.authorId} said, "${collapseWhitespace(mention.visiblePrompt, 500)}"`,
  );

  return loadPromptTemplate("repo-face-pending-mentions.prompt.md", {
    displayName: identity.displayName,
    mentions: mentionLines,
  });
}

function renderWorldbuildingPublicationDirective(identity: RepoDiscordIdentity): string {
  const isNibu = identity.id.toLowerCase() === "nibu";
  return loadPromptTemplate("repo-face-worldbuilding-publication.prompt.md", {
    nibu: isNibu,
  });
}

interface JurisdictionDiveDirective {
  due: boolean;
  cadence: number;
  promptLine: string;
}

function buildJurisdictionDiveDirective(
  identity: RepoDiscordIdentity,
  participant: FaceHeartbeatParticipant,
): JurisdictionDiveDirective {
  const isNibu = identity.id.toLowerCase() === "nibu";
  const cadence = isNibu ? 3 : 8;
  const due = participant.queuedCount === 0 || participant.queuedCount % cadence === 0;

  return {
    due,
    cadence,
    promptLine: loadPromptTemplate("repo-face-jurisdiction-dive.prompt.md", {
      due,
      nibu: isNibu,
      repoName: identity.repoName,
    }),
  };
}

function renderRepoCharacterIdentityDoctrine(identity: RepoDiscordIdentity): string {
  const face = buildEpiphanyIdentityRegistry({ identities: [identity] }).faces[0];
  return loadPromptTemplate("repo-character-identity.prompt.md", {
    displayName: identity.displayName,
    repoName: identity.repoName,
    originName: face?.epiphanyDisplayName ?? identity.repoName,
    characterDescription: projectCharacterDescription(face?.description ?? identity.description),
  });
}

function projectCharacterDescription(description: string | undefined): string | undefined {
  const trimmed = description?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !/^face of\b/i.test(part))
    .filter((part) => !/^grants:/i.test(part))
    .filter((part) => !/^jurisdictions:/i.test(part))
    .map((part) => part
      .replace(/\bmore opinionated and abrasive than Void because she is a character, not the room moderator\b/gi, "more opinionated and abrasive than a room moderator")
      .replace(/\bShe is much more opinionated and abrasive than Void because she is a character, not the room moderator:/gi, "She is much more opinionated and abrasive than a room moderator:")
      .replace(/\bthan Void\b/g, "than a moderator")
      .replace(/\bcharacter Face\b/g, "character")
      .replace(/\bFace\b/g, "personality")
      .replace(/\brepo=AetheriaLore path=[^\s]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim(),
    )
    .filter((part) => part.length > 0)
    .join(" ");
}

function mergeStrings(values: string[], value: string): string[] {
  return Array.from(new Set([...values, value]));
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

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
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
