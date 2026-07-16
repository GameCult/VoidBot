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
  type PromptImageAttachment,
  type RepoFaceConversationFocus,
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
import { composePersonaMemoryPacket, projectPersonaMemorySurface, renderPersonaPressureSections, renderPersonaTypedStateSections } from "../apps/persona-scheduler/dist/persona-memory-projector.js";
import { readPersonaCuriosityEvidence } from "../apps/persona-scheduler/dist/persona-curiosity-context-source.js";
import { projectPersonaCuriosityContext } from "../apps/persona-scheduler/dist/persona-curiosity-projector.js";
import { significantPersonaTopicTerms } from "../apps/persona-scheduler/dist/persona-curiosity-terms.js";
import { observePersonaRoomTexture, projectPersonaSocialContext, renderPersonaHumanPronounFacts, renderPersonaRoomWeather, type PersonaHumanPronounGuidance as RepoFaceHumanPronounGuidance } from "../apps/persona-scheduler/dist/persona-social-context-projector.js";
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
    humanPronounDirective: renderPersonaHumanPronounFacts(input.humanPronounGuidance ?? [])
      ?? "Known human pronoun guidance:\n- No explicit human pronoun guidance is attached for this turn. Use names or neutral phrasing instead of guessing.",
    roomWeatherDirective: renderPersonaRoomWeather({ identity: input.identity,
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
    return projectPersonaMemorySurface({
      identityId: identity.id,
      characterIdentity: renderRepoCharacterIdentityDoctrine(identity),
      statePacket,
      modelProjectionEnabled: false,
    });
  }

  return projectPersonaMemorySurface({
    identityId: identity.id,
    characterIdentity: renderRepoCharacterIdentityDoctrine(identity),
    statePacket,
    modelProjectionEnabled: true,
    projectText: (prompt) => runCodexTextProjection({
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
      return projectPersonaMemorySurface({
        identityId: identity.id,
        characterIdentity: renderRepoCharacterIdentityDoctrine(identity),
        statePacket,
        modelProjectionEnabled: false,
      });
    }
    return projectPersonaMemorySurface({
      identityId: identity.id,
      characterIdentity: renderRepoCharacterIdentityDoctrine(identity),
      statePacket,
      modelProjectionEnabled: true,
      projectText: (prompt) => runCodexTextProjection({
        prompt,
        config,
        command: "repo-face-state-projector",
        jobId: `state-projector:${identity.id}:${Date.now()}`,
        timeoutMs: 180_000,
      }),
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
  const typedSections = renderPersonaTypedStateSections({ identityName: name, state });
  const socialContext = projectPersonaSocialContext({
    identity,
    registryIdentities,
    state,
    recentMessages: roomContext?.recentMessages ?? [],
    channelSnapshots: roomContext?.channelSnapshots ?? [],
    pronounGuidance: humanPronounGuidance,
    observedAt: new Date(),
    topicAttractorFacts: roomContext ? renderRepoFaceTopicAttractorFacts(identity, roomContext.recentMessages) : undefined,
  });
  const clarityPressureActive = Boolean(socialContext.humanClarity);

  return composePersonaMemoryPacket({
    identityName: name,
    typed: typedSections,
    relationshipFreshness: socialContext.relationshipFreshness,
    socialGraph: socialContext.socialGraph,
    peerOpening: socialContext.peerOpening,
    socialPressure: socialContext.socialPressure,
    pronouns: socialContext.pronouns,
    roomTexture: socialContext.roomTexture,
    curiosity: curiosityGraphFacts,
    pressureSections: renderPersonaPressureSections({ identityName: name, state, clarityPressureActive }),
    humanClarity: socialContext.humanClarity,
    transformSurface: (surface) => cleanRepoFaceProjectorLoopVocabulary(identity, surface),
  });
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

function targetLabel(target: { label?: string; id?: string; kind?: string } | undefined): string {
  if (!target) {
    return "an unnamed target";
  }
  return target.label ?? target.id ?? target.kind ?? "an unnamed target";
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

function normalizeSocialLabel(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
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

function joinAsNarrativeList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]}, and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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

  const roomStats = observePersonaRoomTexture({ identity: input.identity,
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
  const identityTerms = new Set(significantPersonaTopicTerms([
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
  const messageTerms = recent.map((message) => new Set(significantPersonaTopicTerms(message.content)));
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
