import "dotenv/config";

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  buildEpiphanyIdentityRegistry,
  ContextBuilder,
  createStateStorage,
  ensureGameCultTextDocument,
  ensureRepoFaceInitialized,
  getRepoDiscordIdentityAllowedChannelIds,
  faceRegistryAsRepoDiscordRegistry,
  ODIN_VERSE_POEM_DOCUMENT_ID,
  projectRepoFaceSleepCycleForNow,
  applyVoidSelfStateOperation,
  loadFaceIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  renderGameCultStructuredTextDocument,
  REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
  type RepoFaceRestSnapshot,
  resolveRepoFaceStatePath,
  type RepoFacePendingMention,
  type RepoDiscordIdentity,
  type VoidSelfStateTypedProjection,
} from "@voidbot/core";
import {
  createTextEmbedder,
  createVectorStores,
  RetrievalService,
} from "@voidbot/rag";
import {
  loadPromptTemplate,
  type InteractionMemoryProfile,
  type PromptImageAttachment,
  type RetrievalResult,
  type SourceMessage,
  type SourceMessageAttachment,
} from "@voidbot/shared";

const HEARTBEAT_SCHEMA_VERSION = REPO_FACE_HEARTBEAT_SCHEMA_VERSION;
const HEARTBEAT_COMMAND = "repo-face-rumination";
const MIN_STALE_ACTIVE_JOB_MS = 45 * 60_000;
const MAX_FACE_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;

interface FaceHeartbeatParticipant {
  identityId: string;
  participantKind: "repo_face" | "native_persona" | "system_agent";
  turnKind: "repo_face_rumination" | "void_moderation";
  repoName: string;
  displayName: string;
  initiativeSpeed: number;
  reactionBias: number;
  interruptThreshold: number;
  currentLoad: number;
  status: "active" | "blocked" | "withdrawn" | "offscreen";
  groups: string[];
  heat: number;
  effectiveSpeed: number;
  baseRecoveryMinutes: number;
  nextTurnAt: number;
  lastTurnAt?: number;
  activeTurnStartedAt?: number;
  activeJobId?: string;
  lastQueuedAt?: string;
  queuedCount: number;
  constraints: string[];
}

interface FaceHeartbeatState {
  schemaVersion: typeof HEARTBEAT_SCHEMA_VERSION;
  initiativeClock: number;
  baseRecoveryMinutes: number;
  globalHeat: number;
  lastTickAt?: string;
  participants: FaceHeartbeatParticipant[];
  history: Array<Record<string, unknown>>;
  pendingMentions: RepoFacePendingMention[];
}

interface ActiveTurnScan {
  active: Map<string, string>;
  queued: Set<string>;
  staleRecovered: StaleActiveTurn[];
}

interface IdleCoolingSnapshot {
  enabled: boolean;
  active: boolean;
  reason?: string;
  checkedChannelIds: string[];
  lastHumanActivityAt?: string;
  idleForMinutes?: number;
  idleAfterMinutes: number;
  recoveryMinutes: number;
  lastUnpromptedTurnQueuedAt?: string;
  nextUnpromptedTurnAllowedAt?: string;
}

interface StaleActiveTurn {
  identityId: string;
  jobId: string;
  requestMessageId?: string;
  state: string;
  updatedAt?: string;
  ageMinutes: number;
}

interface RepoFaceChannelPlan {
  primaryChannelId?: string;
  snapshotChannelIds: string[];
  options: RepoFaceChannelOption[];
  lowThresholdTopics: string[];
}

interface RepoFaceChannelOption {
  channelId: string;
  label: string;
  topic: string;
  speechThreshold: "very_low" | "low" | "medium" | "high";
  speedMultiplier: number;
  posture?: string;
}

interface BifrostGovernanceDigest {
  generatedAt: string;
  topics: BifrostGovernanceTopic[];
}

interface BifrostGovernanceTopic {
  id: string;
  title: string;
  jurisdictionRepoName: string;
  jurisdictionAgentIdentity?: string;
  status: string;
  summaryMarkdown: string;
  priority: number;
  updatedAt: string;
  approvedByAgent?: string;
  dispatchRequestId?: string;
  comments?: BifrostGovernanceComment[];
}

interface BifrostGovernanceComment {
  id: string;
  authorKind: string;
  authorId: string;
  stance: string;
  bodyMarkdown: string;
  createdAt: string;
}

interface ChannelSnapshot {
  channelId: string;
  messages: SourceMessage[];
}

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
    state.lastTickAt = new Date().toISOString();
    state.history.push({
      type: "skipped",
      reason: "agent_swarm_paused",
      skippedAt: state.lastTickAt,
      pausePath: pause.path,
      pauseReason: pause.reason,
    });
    state.history = state.history.slice(-80);
    if (!dryRun) {
      await writeHeartbeatState(config.repoFaceHeartbeats.statePath, state);
      publishSwarmDashboardSurface();
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
    state.lastTickAt = new Date().toISOString();
    state.history.push({
      type: "skipped",
      reason: "repo_face_heartbeats_disabled",
      skippedAt: state.lastTickAt,
    });
    state.history = state.history.slice(-80);
    await writeHeartbeatState(config.repoFaceHeartbeats.statePath, state);
    publishSwarmDashboardSurface();
    return;
  }

  const faceRegistry = await loadFaceIdentityRegistry(config.repoDiscordIdentitiesPath);
  const registry = faceRegistryAsRepoDiscordRegistry(faceRegistry);
  const state = await readHeartbeatState(config.repoFaceHeartbeats.statePath);
  const restStates = await loadRepoFaceRestStates(registry.identities, config.storageRoot, state, { dryRun });
  const now = new Date();
  advanceInitiativeClockFromWallClock(state, now);
  const activeTurnScan = dryRun
    ? { active: new Map<string, string>(), queued: new Set<string>(), staleRecovered: [] }
    : await listExistingActiveTurns(config.databaseDsn, config.stateStorageBackend, config);
  for (const stale of activeTurnScan.staleRecovered) {
    state.history.push({
      type: "stale_active_turn_recovered",
      identityId: stale.identityId,
      activeJobId: stale.jobId,
      requestMessageId: stale.requestMessageId,
      jobState: stale.state,
      jobUpdatedAt: stale.updatedAt,
      ageMinutes: stale.ageMinutes,
      recoveredAt: now.toISOString(),
    });
  }

  state.baseRecoveryMinutes = config.repoFaceHeartbeats.baseRecoveryMinutes;
  state.globalHeat = config.repoFaceHeartbeats.globalHeat;
  const completedThisTick = new Set<string>();
  state.participants = reconcileParticipants(
    state.participants,
    buildParticipantSpecs(registry.identities),
    config.repoFaceHeartbeats.defaultChannelId,
    config.repoFaceHeartbeats.speedOverrides,
    config.repoFaceHeartbeats.heatOverrides,
    state.initiativeClock,
    config.repoFaceHeartbeats.baseRecoveryMinutes,
    config.repoFaceHeartbeats.globalHeat,
  ).map((participant) =>
    applyActiveTurnFreeze(
      participant,
      activeTurnScan.active.get(participant.identityId),
      activeTurnScan.queued,
      state,
      completedThisTick,
    ),
  );
  rescheduleStaleOverdueParticipants(state);
  applyPendingMentionPriority(state);
  const idleCooling = await readIdleCoolingSnapshot({
    config,
    identities: registry.identities,
    state,
    now,
  });

  const selected = selectReadyParticipants(
    state,
    config.repoFaceHeartbeats.maxJobsPerTick,
    completedThisTick,
    activeTurnScan.queued,
    restStates,
    idleCooling,
  );
  const queuedIdentityIds: string[] = [];

  if (selected.length > 0 && dryRun) {
    const queuedAt = new Date().toISOString();
    for (const participant of selected) {
      const pendingMentions = pendingMentionsForParticipant(state, participant.identityId);
      const recoveryMinutes = recoveryFor(participant);
      participant.lastQueuedAt = queuedAt;
      participant.lastTurnAt = state.initiativeClock;
      participant.queuedCount += 1;
      participant.nextTurnAt = Math.max(state.initiativeClock, participant.nextTurnAt) + recoveryMinutes;
      queuedIdentityIds.push(participant.identityId);
      state.history.push({
        type: "dry_run_selected",
        identityId: participant.identityId,
        queuedAt,
        initiativeClock: state.initiativeClock,
        nextTurnAt: participant.nextTurnAt,
        recoveryMinutes,
        heat: participant.heat,
        effectiveSpeed: participant.effectiveSpeed,
        pendingMentionCount: pendingMentions.length,
      });
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
        });

        if (turn.created) {
          queuedIdentityIds.push(participant.identityId);
          participant.lastQueuedAt = queuedAt;
          participant.lastTurnAt = state.initiativeClock;
          participant.queuedCount += 1;
          participant.currentLoad = 0;
          participant.activeTurnStartedAt = undefined;
          participant.activeJobId = undefined;
          participant.nextTurnAt = Math.max(participant.nextTurnAt, state.initiativeClock + recoveryFor(participant));
          if (pendingMentions.length > 0) {
            const consumedIds = new Set(pendingMentions.map((entry) => entry.id));
            state.pendingMentions = state.pendingMentions.filter((entry) => !consumedIds.has(entry.id));
          }
          state.history.push({
            type: "queued",
            identityId: participant.identityId,
            participantKind: participant.participantKind,
            turnKind: participant.turnKind,
            activeJobId: turn.activeJobId,
            requestMessageId: turn.requestMessageId,
            queuedAt,
            initiativeClock: state.initiativeClock,
            frozen: true,
            heat: participant.heat,
            effectiveSpeed: participant.effectiveSpeed,
            pendingMentionCount: pendingMentions.length,
          });
        } else if (turn.failureReason) {
          participant.currentLoad = 0;
          state.history.push({
            type: "turn_failed_to_start",
            identityId: participant.identityId,
            participantKind: participant.participantKind,
            turnKind: participant.turnKind,
            activeJobId: turn.activeJobId,
            requestMessageId: turn.requestMessageId,
            queuedAt,
            initiativeClock: state.initiativeClock,
            reason: turn.failureReason,
            heat: participant.heat,
            effectiveSpeed: participant.effectiveSpeed,
          });
        }
      }
    } finally {
      await storage.close();
    }
  }

  state.history = state.history.slice(-80);
  state.lastTickAt = now.toISOString();
  if (!dryRun) {
    await writeHeartbeatState(config.repoFaceHeartbeats.statePath, state);
    publishSwarmDashboardSurface();
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
      idleCooling,
    })}\n`,
  );
}

async function readAgentSwarmPause(): Promise<{ paused: boolean; path: string; reason?: string }> {
  const path = resolve(process.cwd(), "state", "agent-swarm-paused.json");
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(path, "utf8"))) as Record<string, unknown>;
    return {
      paused: parsed.paused !== false,
      path,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { paused: false, path };
    }
    return {
      paused: true,
      path,
      reason: "Pause file exists but could not be parsed; failing closed.",
    };
  }
}

interface ParticipantSpec {
  id: string;
  participantKind: FaceHeartbeatParticipant["participantKind"];
  turnKind: FaceHeartbeatParticipant["turnKind"];
  repoName: string;
  displayName: string;
  allowedChannelIds: string[];
  channelSpeedMultiplier: number;
  identity?: RepoDiscordIdentity;
}

function buildParticipantSpecs(identities: RepoDiscordIdentity[]): ParticipantSpec[] {
  return [
    {
      id: "void",
      participantKind: "system_agent",
      turnKind: "void_moderation",
      repoName: "VoidBot",
      displayName: "Void",
      allowedChannelIds: [],
      channelSpeedMultiplier: 1,
    },
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
}): Promise<{ created: boolean; activeJobId?: string; requestMessageId?: string; failureReason?: string }> {
  const identity = input.registryIdentities.find((entry) => entry.id === input.participant.identityId);
  if (!identity) {
    return { created: false };
  }

  const preferredChannelId = newestPendingMentionChannel(input.pendingMentions);
  const channelPlan = buildChannelPlan(
    identity,
    input.config.repoFaceHeartbeats.defaultChannelId,
    preferredChannelId,
  );
  const fallbackChannelId = channelPlan.primaryChannelId;
  if (!fallbackChannelId) {
    input.participant.status = "blocked";
    input.participant.constraints = mergeStrings(
      input.participant.constraints,
      "No CTB turn channel is configured for this Face.",
    );
    return { created: false };
  }

  const contextBuilder = new ContextBuilder();
  if (identity.identityKind !== "native_persona") {
    await ensureRepoFaceInitialized({
      identity,
      storageRoot: input.config.storageRoot,
      sourceRepoRoot: input.config.sourceRepoRoot,
      epiphanyAgentRoot: input.config.epiphanyAgentRoot,
      workspaceRoot: process.cwd(),
      birthMode: input.config.repoFaceBirthMode,
      birthExecutor: input.config.repoFaceBirthExecutor,
    });
  }
  const fetchedChannelSnapshots = await fetchChannelSnapshots({
    botToken: input.config.botToken,
    channelIds: channelPlan.snapshotChannelIds,
    limit: 15,
    bifrostDiscordChannelId: input.config.bifrostDiscordChannelId,
  });
  const turnTarget = selectRepoFaceTurnTarget({
    channelPlan,
    fetchedChannelSnapshots,
    pendingMentions: input.pendingMentions,
    fallbackChannelId,
  });
  const channelId = turnTarget.channelId;
  const activeChannelPlan: RepoFaceChannelPlan = {
    ...channelPlan,
    primaryChannelId: channelId,
  };
  const recentMessages = messagesForChannel(fetchedChannelSnapshots, channelId);
  const channelSnapshots = fetchedChannelSnapshots
    .filter((snapshot) => snapshot.channelId !== channelId)
    .slice(0, 5);
  const bifrostDigest = input.config.repoFaceBifrostEnabled && identity.identityKind !== "native_persona"
    ? await fetchBifrostGovernanceDigest({
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
  );
  const repoActivitySurface = identity.identityKind === "native_persona"
    ? renderNativePersonaBodySurface(identity)
    : renderRepoFaceRepoActivitySurface(identity, input.config);
  const globalAgentDoctrine = await loadGlobalAgentDoctrine();
  const colossusOdinDoctrine = await renderColossusOdinDoctrine({
    displayName: identity.displayName,
    repoName: identity.repoName,
  });
  const conversationMemorySurface = renderRepoFaceConversationTranscript({
    identity,
    recentMessages,
    channelSnapshots,
    pendingMentions: input.pendingMentions,
    channelPlan: activeChannelPlan,
  });
  const prompt = buildHeartbeatPrompt({
    identity,
    channelId,
    channelPlan: activeChannelPlan,
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
    colossusOdinDoctrine,
  });
  const imageAttachments = collectPromptImageAttachments([
    recentMessages,
    ...channelSnapshots.map((snapshot) => snapshot.messages),
  ].flat());
  const contextBundle = contextBuilder.build({
    prompt,
    actor: {
      id: "voidbot-agent-turn",
      displayName: "VoidBot Agent Turn",
      isAdmin: true,
      isBot: true,
    },
    guildContext: {
      channelId,
      ...(turnTarget.replyToMessageId ? { replyToMessageId: turnTarget.replyToMessageId } : {}),
    },
    recentMessages,
    imageAttachments,
    retrieval: [],
    voidSelfState: undefined,
  });
  const requestMessageId = `agent-turn:${identity.id}:${input.queuedAt}`;
  const result = await input.storage.jobQueue.createJob({
    command: HEARTBEAT_COMMAND,
    provider: "owner_codex",
    runApprovalRequired: false,
    postApprovalRequired: false,
    requester: contextBundle.actor,
    guildContext: contextBundle.guildContext,
    prompt,
    contextBundle,
    outputChannelId: channelId,
    requestMessageId,
    initialState: "approved",
  });

  return {
    created: result.created,
    activeJobId: result.job.id,
    requestMessageId,
  };
}

async function loadRepoFaceRestStates(
  identities: RepoDiscordIdentity[],
  storageRoot: string,
  heartbeatState: FaceHeartbeatState,
  options: { dryRun?: boolean } = {},
): Promise<Map<string, RepoFaceRestSnapshot>> {
  const restStates = new Map<string, RepoFaceRestSnapshot>();
  const now = new Date();

  for (const identity of identities) {
    if (identity.identityKind === "native_persona") {
      continue;
    }

    try {
      const statePath = resolveRepoFaceStatePath(identity, storageRoot);
      const typedState = await loadVoidSelfStateTypedDocuments({
        canonicalPath: statePath,
        identity: {
          agentId: identity.id,
          publicName: identity.displayName,
          publicDescription: identity.description,
        },
      });
      const projected = projectRepoFaceSleepCycleForNow(
        typedState.scheduledRuntime.sleepCycle,
        identity.id,
        now,
      );
      if (!options.dryRun && !sleepCyclesEqual(typedState.scheduledRuntime.sleepCycle, projected.sleepCycle)) {
        await applyVoidSelfStateOperation(
          {
            canonicalPath: statePath,
            identity: {
              agentId: identity.id,
              publicName: identity.displayName,
              publicDescription: identity.description,
            },
          },
          {
            operation: "update_sleep_cycle",
            sleepCycle: projected.sleepCycle,
          },
        );
      }
      const speakingPressure = buildRepoFaceSpeakingPressure(
        typedState,
        projected.sleepCycle,
        now,
      );
      if (!options.dryRun && !speakingPressuresEqual(typedState.scheduledRuntime.speakingPressure, speakingPressure)) {
        await applyVoidSelfStateOperation(
          {
            canonicalPath: statePath,
            identity: {
              agentId: identity.id,
              publicName: identity.displayName,
              publicDescription: identity.description,
            },
          },
          {
            operation: "update_speaking_pressure",
            speakingPressure,
          },
        );
      }
      const maintenance = options.dryRun
        ? { started: false, reason: "dry_run", statusPath: undefined }
        : await maybeStartRepoFaceMemoryMaintenance({
            identity,
            statePath,
            typedState,
            projectedRest: projected,
          });
      if (maintenance.started || maintenance.failureReason) {
        heartbeatState.history.push({
          type: maintenance.started ? "repo_face_memory_maintenance_started" : "repo_face_memory_maintenance_failed_to_start",
          identityId: identity.id,
          observedAt: now.toISOString(),
          reason: maintenance.reason,
          statusPath: maintenance.statusPath,
          pid: maintenance.pid,
          failureReason: maintenance.failureReason,
        });
      }
      restStates.set(identity.id, {
        isNapping: projected.isNapping,
        napEndsAt: projected.napEndsAt,
        nextNapStartsAt: projected.nextNapStartsAt,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  return restStates;
}

function buildRepoFaceSpeakingPressure(
  typedState: Awaited<ReturnType<typeof loadVoidSelfStateTypedDocuments>>,
  sleepCycle: Awaited<ReturnType<typeof projectRepoFaceSleepCycleForNow>>["sleepCycle"],
  now: Date,
): Awaited<ReturnType<typeof loadVoidSelfStateTypedDocuments>>["scheduledRuntime"]["speakingPressure"] {
  const previous = typedState.scheduledRuntime.speakingPressure;
  const lastReceipt = typedState.speechReceipts.recentReceipts
    .slice()
    .sort((left, right) => Date.parse(right.sentAt) - Date.parse(left.sentAt))
    [0];
  const lastSpokeAt = lastReceipt?.sentAt ?? previous.lastSpokeAt;
  const hoursSinceSpeech = lastSpokeAt ? Math.max(0, (now.getTime() - Date.parse(lastSpokeAt)) / 3_600_000) : 24;
  const recentSpeechDamping = clamp(Math.exp(-hoursSinceSpeech / 3.5), 0, 1);
  const affectNeedPressure = (typedState.faceAffect.needs ?? [])
    .filter((entry) => entry.status === "active" || entry.status === "neglected")
    .reduce((sum, entry) => {
      const neglectedWeight = entry.status === "neglected" ? 1.25 : 1;
      const substrateWeight = ["substrate", "agency", "status", "territory", "recognition"].includes(entry.kind) ? 0.18 : 0.11;
      return sum + entry.intensity * substrateWeight * neglectedWeight;
    }, 0);
  const statusReadPressure = (typedState.faceAffect.statusReads ?? [])
    .filter((entry) => !entry.retiredAt)
    .reduce((sum, entry) => {
      const sharpWeight = ["neglected", "bypassed", "blocked", "ignored", "threatened", "challenged"].includes(entry.status) ? 0.14 : 0.08;
      return sum + entry.intensity * sharpWeight;
    }, 0);
  const socialBondPressure = (typedState.faceAffect.socialBonds ?? [])
    .filter((entry) => entry.status === "active")
    .reduce((sum, entry) => sum + entry.intensity * 0.07, 0);
  const moodPressure = (typedState.faceAffect.moodDimensions ?? [])
    .reduce((sum, entry) => {
      const expressiveWeight = ["anger", "annoyance", "irritation", "envy", "pride", "smugness", "playfulness", "anxiety", "commandForce", "restlessness"].includes(entry.name)
        ? 0.06
        : 0.025;
      return sum + entry.value * expressiveWeight;
    }, 0);
  const agencyPressure = typedState.agencyPressure.pressures
    .filter((entry) => entry.status === "active" || entry.status === "ready_to_act")
    .reduce((sum, entry) => sum + entry.intensity * (entry.kind.includes("advocacy") ? 0.22 : 0.11), 0);
  const candidatePressure = typedState.candidateInterventions.interventions
    .filter((entry) => entry.status === "queued" || entry.status === "deferred")
    .reduce((sum, entry) => sum + entry.priority * (entry.mustEventuallyShare ? 0.22 : 0.12), 0);
  const silencePressure = clamp(hoursSinceSpeech / 8, 0, 1);
  const sleepiness = sleepCycle.isNapping ? 0.22 : 0;
  const targetNeed = clamp(
    0.12 + silencePressure * 0.18 + affectNeedPressure + statusReadPressure + socialBondPressure + moodPressure + agencyPressure + candidatePressure - recentSpeechDamping * 0.24 - sleepiness,
    0,
    1,
  );
  const needToSpeak = round3(clamp((previous.needToSpeak ?? 0.25) * 0.58 + targetNeed * 0.42, 0, 1));

  return {
    needToSpeak,
    confessionPressure: round3(clamp((previous.confessionPressure ?? 0.2) * 0.7 + moodPressure * 0.42 + socialBondPressure * 0.18, 0, 1)),
    noveltyPressure: round3(clamp((previous.noveltyPressure ?? 0.25) * 0.62 + affectNeedPressure * 0.35 + statusReadPressure * 0.24 + candidatePressure * 0.28, 0, 1)),
    recentSpeechDamping: round3(recentSpeechDamping),
    lastSpokeAt,
  };
}

function speakingPressuresEqual(
  left: Awaited<ReturnType<typeof loadVoidSelfStateTypedDocuments>>["scheduledRuntime"]["speakingPressure"],
  right: Awaited<ReturnType<typeof loadVoidSelfStateTypedDocuments>>["scheduledRuntime"]["speakingPressure"],
): boolean {
  return left.needToSpeak === right.needToSpeak
    && left.confessionPressure === right.confessionPressure
    && left.noveltyPressure === right.noveltyPressure
    && left.recentSpeechDamping === right.recentSpeechDamping
    && left.lastSpokeAt === right.lastSpokeAt;
}

async function maybeStartRepoFaceMemoryMaintenance(input: {
  identity: RepoDiscordIdentity;
  statePath: string;
  typedState: Awaited<ReturnType<typeof loadVoidSelfStateTypedDocuments>>;
  projectedRest: RepoFaceRestSnapshot;
}): Promise<{
  started: boolean;
  reason?: string;
  statusPath?: string;
  pid?: number;
  failureReason?: string;
}> {
  const shortTerm = input.typedState.thoughtMemory.shortTerm ?? [];
  if (shortTerm.length === 0) {
    return { started: false, reason: "no_short_term_memory" };
  }

  const oldestShortTermMs = Math.min(
    ...shortTerm.map((memory) => Date.parse(memory.updatedAt)).filter(Number.isFinite),
  );
  const hasStaleShortTerm =
    Number.isFinite(oldestShortTermMs) &&
    Date.now() - oldestShortTermMs >= 6 * 60 * 60 * 1000;
  if (input.projectedRest.isNapping !== true && !hasStaleShortTerm) {
    return { started: false, reason: "not_napping_or_stale" };
  }

  const paths = repoFaceMemoryMaintenancePaths(input.statePath);
  const currentStatus = await readJsonFile(paths.statusPath);
  if (isRecentRunningStatus(currentStatus, 25)) {
    return { started: false, reason: "maintenance_already_running", statusPath: paths.statusPath };
  }
  if (isStatusCompletedAfter(currentStatus, newestTimestampMs(shortTerm))) {
    return { started: false, reason: "maintenance_already_completed_for_sources", statusPath: paths.statusPath };
  }

  try {
    await mkdir(paths.statusDir, { recursive: true });
    await mkdir(paths.logDir, { recursive: true });
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve(process.cwd(), "scripts", "run-void-memory-maintenance.ps1"),
        "-StateFilePath",
        input.statePath,
        "-ForceDistillation",
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          VOID_MEMORY_MAINTENANCE_STATUS_DIR: paths.statusDir,
          VOID_MEMORY_MAINTENANCE_LOG_DIR: paths.logDir,
        },
      },
    );
    child.unref();
    return {
      started: true,
      reason: input.projectedRest.isNapping ? "repo_face_napping_with_short_term_memory" : "repo_face_stale_short_term_memory",
      statusPath: paths.statusPath,
      pid: child.pid,
    };
  } catch (error) {
    return {
      started: false,
      reason: "spawn_failed",
      statusPath: paths.statusPath,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function repoFaceMemoryMaintenancePaths(statePath: string): {
  statusDir: string;
  logDir: string;
  statusPath: string;
} {
  const stateDir = dirname(statePath);
  const voidbotRoot = dirname(stateDir);
  const statusDir = resolve(voidbotRoot, "status");
  const logDir = resolve(voidbotRoot, "logs");
  return {
    statusDir,
    logDir,
    statusPath: resolve(statusDir, "void-memory-maintenance.json"),
  };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(stripLeadingBom(await readFile(path, "utf8"))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isRecentRunningStatus(status: Record<string, unknown> | undefined, maxAgeMinutes: number): boolean {
  if (status?.status !== "running" && status?.status !== "running_skip_model" && status?.status !== "starting") {
    return false;
  }
  const startedAtMs = typeof status.startedAt === "string" ? Date.parse(status.startedAt) : NaN;
  return Number.isFinite(startedAtMs) && Date.now() - startedAtMs < maxAgeMinutes * 60_000;
}

function isStatusCompletedAfter(status: Record<string, unknown> | undefined, sourceTimestampMs: number): boolean {
  if (status?.status !== "ok" || !Number.isFinite(sourceTimestampMs)) {
    return false;
  }
  const finishedAtMs = typeof status.finishedAt === "string" ? Date.parse(status.finishedAt) : NaN;
  return Number.isFinite(finishedAtMs) && finishedAtMs >= sourceTimestampMs;
}

function newestTimestampMs(entries: Array<{ updatedAt: string }>): number {
  return Math.max(...entries.map((entry) => Date.parse(entry.updatedAt)).filter(Number.isFinite));
}

function sleepCyclesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fetchRecentDiscordMessages(input: {
  botToken?: string;
  channelId: string;
  limit: number;
  ignoreBotMessages?: boolean;
}): Promise<SourceMessage[]> {
  if (!input.botToken) {
    return [];
  }

  const url = new URL(`https://discord.com/api/v10/channels/${input.channelId}/messages`);
  url.searchParams.set("limit", String(Math.max(1, Math.min(input.limit, 25))));
  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${input.botToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord recent message fetch failed with ${response.status}: ${await response.text()}`);
  }

  const messages = await response.json() as DiscordApiMessage[];
  const sourceMessages = await Promise.all(messages
    .filter((message) => !(input.ignoreBotMessages && message.author.bot === true))
    .map(async (message) => {
      const attachments = await materializeDiscordAttachments({
        channelId: input.channelId,
        message,
      });
      return {
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.global_name ?? message.member?.nick ?? message.author.username,
        content: message.content,
        timestamp: message.timestamp,
        isBot: message.author.bot === true,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    }));
  return sourceMessages
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

async function fetchChannelSnapshots(input: {
  botToken?: string;
  channelIds: string[];
  primaryChannelId?: string;
  limit: number;
  bifrostDiscordChannelId?: string;
}): Promise<ChannelSnapshot[]> {
  const snapshots: ChannelSnapshot[] = [];
  for (const channelId of input.channelIds.filter((entry) => entry !== input.primaryChannelId).slice(0, 6)) {
    try {
      snapshots.push({
        channelId,
        messages: await fetchRecentDiscordMessages({
          botToken: input.botToken,
          channelId,
          limit: input.limit,
          ignoreBotMessages: channelId === input.bifrostDiscordChannelId,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      snapshots.push({
        channelId,
        messages: [{
          id: `snapshot-error:${channelId}`,
          authorId: "voidbot",
          authorName: "VoidBot",
          content: `Could not read recent channel context: ${message}`,
          timestamp: new Date().toISOString(),
          isBot: true,
        }],
      });
    }
  }
  return snapshots;
}

function selectRepoFaceTurnTarget(input: {
  channelPlan: RepoFaceChannelPlan;
  fetchedChannelSnapshots: ChannelSnapshot[];
  pendingMentions: RepoFacePendingMention[];
  fallbackChannelId: string;
}): { channelId: string; replyToMessageId?: string } {
  const pendingChannelId = newestPendingMentionChannel(input.pendingMentions);
  if (pendingChannelId && input.channelPlan.snapshotChannelIds.includes(pendingChannelId)) {
    const pendingMention = newestPendingMention(input.pendingMentions);
    return {
      channelId: pendingChannelId,
      replyToMessageId: pendingMention?.messageId ??
        newestHumanMessage(messagesForChannel(input.fetchedChannelSnapshots, pendingChannelId))?.id,
    };
  }

  const newestHuman = input.fetchedChannelSnapshots
    .flatMap((snapshot) =>
      snapshot.messages.map((message) => ({
        channelId: snapshot.channelId,
        message,
        timestampMs: Date.parse(message.timestamp),
      }))
    )
    .filter((entry) =>
      !entry.message.isBot &&
      Number.isFinite(entry.timestampMs) &&
      input.channelPlan.snapshotChannelIds.includes(entry.channelId)
    )
    .sort((left, right) => right.timestampMs - left.timestampMs)[0];

  if (newestHuman) {
    return {
      channelId: newestHuman.channelId,
      replyToMessageId: newestHuman.message.id,
    };
  }

  return { channelId: input.fallbackChannelId };
}

function messagesForChannel(snapshots: ChannelSnapshot[], channelId: string): SourceMessage[] {
  return snapshots.find((snapshot) => snapshot.channelId === channelId)?.messages ?? [];
}

function newestHumanMessage(messages: SourceMessage[]): SourceMessage | undefined {
  return messages
    .filter((message) => !message.isBot && Number.isFinite(Date.parse(message.timestamp)))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0];
}

function newestPendingMention(pendingMentions: RepoFacePendingMention[]): RepoFacePendingMention | undefined {
  return pendingMentions
    .slice()
    .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))[0];
}

async function materializeDiscordAttachments(input: {
  channelId: string;
  message: DiscordApiMessage;
}): Promise<SourceMessageAttachment[]> {
  const attachments = input.message.attachments ?? [];
  if (attachments.length === 0) {
    return [];
  }

  const materialized: SourceMessageAttachment[] = [];
  for (const attachment of attachments.slice(0, 4)) {
    const kind = isDiscordImageAttachment(attachment) ? "image" : "other";
    let localPath: string | undefined;
    if (kind === "image" && isWithinFaceImageSizeLimit(attachment)) {
      localPath = await cacheDiscordImageAttachment({
        channelId: input.channelId,
        messageId: input.message.id,
        attachment,
      });
    }
    materialized.push({
      kind,
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      url: attachment.url,
      proxyUrl: attachment.proxy_url,
      size: typeof attachment.size === "number" ? attachment.size : undefined,
      width: typeof attachment.width === "number" ? attachment.width : undefined,
      height: typeof attachment.height === "number" ? attachment.height : undefined,
      localPath,
    });
  }
  return materialized;
}

function isWithinFaceImageSizeLimit(attachment: DiscordApiAttachment): boolean {
  return typeof attachment.size !== "number" || attachment.size <= MAX_FACE_IMAGE_ATTACHMENT_BYTES;
}

function isDiscordImageAttachment(attachment: DiscordApiAttachment): boolean {
  const contentType = attachment.content_type?.toLowerCase() ?? "";
  if (contentType.startsWith("image/")) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp)$/i.test(attachment.filename ?? attachment.url ?? "");
}

async function cacheDiscordImageAttachment(input: {
  channelId: string;
  messageId: string;
  attachment: DiscordApiAttachment;
}): Promise<string | undefined> {
  const sourceUrl = input.attachment.url ?? input.attachment.proxy_url;
  if (!sourceUrl) {
    return undefined;
  }
  const safeExtension = normalizedImageExtension(input.attachment);
  const fileStem = [
    input.messageId,
    input.attachment.id ?? createHash("sha256").update(sourceUrl).digest("hex").slice(0, 12),
  ].join("-");
  const directory = resolve(".voidbot", "media", "discord-images", input.channelId);
  const localPath = resolve(directory, `${fileStem}${safeExtension}`);
  try {
    await stat(localPath);
    return localPath;
  } catch {
    // Cache miss. Fall through to fetch.
  }

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      return undefined;
    }
    const arrayBuffer = await response.arrayBuffer();
    await mkdir(directory, { recursive: true });
    await writeFile(localPath, Buffer.from(arrayBuffer));
    return localPath;
  } catch {
    return undefined;
  }
}

function normalizedImageExtension(attachment: DiscordApiAttachment): string {
  const fromName = extname(attachment.filename ?? "").toLowerCase();
  if (/^\.(png|jpe?g|gif|webp)$/.test(fromName)) {
    return fromName;
  }
  const contentType = attachment.content_type?.toLowerCase();
  switch (contentType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/png":
    default:
      return ".png";
  }
}

async function fetchBifrostGovernanceDigest(input: {
  bifrostRoot: string;
  repoName: string;
  agentIdentity: string;
}): Promise<BifrostGovernanceDigest | undefined> {
  const scriptPath = resolve(input.bifrostRoot, "tools", "governance-threads.mjs");
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "digest",
      "--repo", input.repoName,
      "--agent", input.agentIdentity,
      "--limit", "6",
    ],
    {
      cwd: input.bifrostRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 30000,
    },
  );

  if (result.status !== 0) {
    return {
      generatedAt: new Date().toISOString(),
      topics: [{
        id: "bifrost-digest-error",
        title: "Bifrost governance digest unavailable",
        jurisdictionRepoName: input.repoName,
        jurisdictionAgentIdentity: input.agentIdentity,
        status: "error",
        summaryMarkdown: `Could not read Bifrost governance digest: ${result.stderr || result.error?.message || result.stdout || "unknown failure"}`,
        priority: 0,
        updatedAt: new Date().toISOString(),
        comments: [],
      }],
    };
  }

  try {
    return JSON.parse(result.stdout) as BifrostGovernanceDigest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      generatedAt: new Date().toISOString(),
      topics: [{
        id: "bifrost-digest-parse-error",
        title: "Bifrost governance digest parse failure",
        jurisdictionRepoName: input.repoName,
        jurisdictionAgentIdentity: input.agentIdentity,
        status: "error",
        summaryMarkdown: `Could not parse Bifrost governance digest: ${message}`,
        priority: 0,
        updatedAt: new Date().toISOString(),
        comments: [],
      }],
    };
  }
}

interface DiscordApiMessage {
  id: string;
  content: string;
  timestamp: string;
  attachments?: DiscordApiAttachment[];
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
  };
}

interface DiscordApiAttachment {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
  proxy_url?: string;
  width?: number | null;
  height?: number | null;
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

async function listExistingActiveTurns(
  databaseDsn: string,
  stateStorageBackend: "file" | "postgres",
  config: ReturnType<typeof loadConfig>,
): Promise<ActiveTurnScan> {
  const storage = await createStateStorage({
    backend: stateStorageBackend,
    databaseDsn,
    jobsFile: config.jobsFile,
    auditLogFile: config.auditLogFile,
    interactionMemoryFile: config.interactionMemoryFile,
    rateLimitStateFile: config.rateLimitStateFile,
  });
  try {
    const jobs = await storage.jobQueue.listByStates(["approved", "running"]);
    const active = new Map<string, string>();
    const queued = new Set<string>();
    const staleRecovered: StaleActiveTurn[] = [];
    const staleAfterMs = Math.max(MIN_STALE_ACTIVE_JOB_MS, config.codexExecTimeoutMs * 3);
    const nowMs = Date.now();
    for (const job of jobs) {
      if (job.command !== HEARTBEAT_COMMAND) {
        continue;
      }
      const match =
        job.requestMessageId?.match(/^agent-turn:([^:]+):/) ??
        job.requestMessageId?.match(/^agent-heartbeat:([^:]+):/) ??
        job.requestMessageId?.match(/^repo-face-heartbeat:([^:]+):/) ??
        job.requestMessageId?.match(/:repo-face:([^:]+):\d+$/);
      if (match) {
        if (job.state === "approved") {
          queued.add(match[1]);
          continue;
        }

        const updatedMs = Date.parse(job.updatedAt);
        const ageMs = Number.isFinite(updatedMs) ? nowMs - updatedMs : Number.POSITIVE_INFINITY;
        if (ageMs > staleAfterMs) {
          const ageMinutes = Number.isFinite(ageMs) ? Math.round((ageMs / 60_000) * 10) / 10 : -1;
          await storage.jobQueue.markFailed(
            job.id,
            `Repo Face CTB recovered stale active turn job after ${ageMinutes} minutes without progress.`,
          );
          staleRecovered.push({
            identityId: match[1],
            jobId: job.id,
            requestMessageId: job.requestMessageId,
            state: job.state,
            updatedAt: job.updatedAt,
            ageMinutes,
          });
          continue;
        }
        active.set(match[1], job.id);
      }
    }
    const voidLock = await readRecentLock(resolve(config.storageRoot, "status", "moderation-rumination.lock"), 20);
    if (voidLock) {
      active.set("void", "lock:moderation-rumination");
    }
    return { active, queued, staleRecovered };
  } finally {
    await storage.close();
  }
}

async function readRecentLock(path: string, maxAgeMinutes: number): Promise<boolean> {
  try {
    const info = await stat(path);
    const ageMs = Date.now() - info.mtimeMs;
    return ageMs >= 0 && ageMs < maxAgeMinutes * 60_000;
  } catch {
    return false;
  }
}

function reconcileParticipants(
  existing: FaceHeartbeatParticipant[],
  specs: ParticipantSpec[],
  defaultChannelId: string | undefined,
  speedOverrides: Record<string, number>,
  heatOverrides: Record<string, number>,
  initiativeClock: number,
  baseRecoveryMinutes: number,
  globalHeat: number,
): FaceHeartbeatParticipant[] {
  const existingById = new Map(existing.map((entry) => [entry.identityId, entry]));
  const count = Math.max(specs.length, 1);

  return specs.map((spec, index) => {
    const current = existingById.get(spec.id);
    const hasChannel = spec.participantKind === "system_agent" || Boolean(spec.allowedChannelIds[0] || defaultChannelId);
    const speed = initiativeSpeedFor(spec, speedOverrides) * spec.channelSpeedMultiplier;
    const groups = initiativeGroupsFor(spec);
    const heat = heatFor(spec, groups, globalHeat, heatOverrides);
    const effectiveSpeed = clamp(speed * heat, 0.1, 12);
    const nextTurnAt = Number.isFinite(current?.nextTurnAt)
      ? current.nextTurnAt
      : initiativeClock + ((baseRecoveryMinutes / count) * index);
    if (current) {
      return {
        ...current,
        participantKind: spec.participantKind,
        turnKind: spec.turnKind,
        repoName: spec.repoName,
        displayName: spec.displayName,
        initiativeSpeed: speed,
        groups,
        heat,
        effectiveSpeed,
        baseRecoveryMinutes,
        nextTurnAt,
        constraints: mergeStrings(
          mergeStrings(
            current.constraints,
            "Agent runtime uses CTB-style turns.",
          ),
          "Wall-clock elapsed time advances initiative; heat changes recovery speed but does not fast-forward time.",
        ),
        status: hasChannel
          ? current.status === "withdrawn" || current.status === "blocked"
            ? current.status
            : "active"
          : "blocked",
      };
    }

    return {
      identityId: spec.id,
      participantKind: spec.participantKind,
      turnKind: spec.turnKind,
      repoName: spec.repoName,
      displayName: spec.displayName,
      initiativeSpeed: speed,
      reactionBias: reactionBiasFor(spec),
      interruptThreshold: interruptThresholdFor(spec),
      currentLoad: 0,
      status: hasChannel ? "active" : "blocked",
      groups,
      heat,
      effectiveSpeed,
      baseRecoveryMinutes,
      nextTurnAt,
      queuedCount: 0,
      constraints: [
        "Agent runtime uses CTB-style turns.",
        "Wall-clock elapsed time advances initiative; heat changes recovery speed but does not fast-forward time.",
        "Worker final summaries are not auto-posted as the base bot.",
      ],
    };
  });
}

function applyActiveTurnFreeze(
  participant: FaceHeartbeatParticipant,
  activeJobId: string | undefined,
  queuedIdentities: Set<string>,
  state: FaceHeartbeatState,
  completedThisTick: Set<string>,
): FaceHeartbeatParticipant {
  if (activeJobId) {
    return {
      ...participant,
      currentLoad: 1,
      activeJobId,
      activeTurnStartedAt: participant.activeTurnStartedAt ?? participant.lastTurnAt ?? state.initiativeClock,
    };
  }

  if (queuedIdentities.has(participant.identityId)) {
    return {
      ...participant,
      currentLoad: 0,
      activeTurnStartedAt: undefined,
      activeJobId: undefined,
      nextTurnAt: Math.max(participant.nextTurnAt, state.initiativeClock + recoveryFor(participant)),
    };
  }

  if (participant.currentLoad >= 1 || participant.activeTurnStartedAt !== undefined || participant.activeJobId) {
    const completedTurnStartedAt = participant.activeTurnStartedAt ?? participant.lastTurnAt ?? state.initiativeClock;
    const unfrozen = {
      ...participant,
      currentLoad: 0,
      activeTurnStartedAt: undefined,
      activeJobId: undefined,
    };
    const recoveryMinutes = recoveryFor(unfrozen);
    unfrozen.nextTurnAt = Math.max(state.initiativeClock, completedTurnStartedAt) + recoveryMinutes;
    completedThisTick.add(participant.identityId);
    state.history.push({
      type: "turn_completed",
      identityId: participant.identityId,
      completedAtClock: state.initiativeClock,
      startedAtClock: completedTurnStartedAt,
      nextTurnAt: unfrozen.nextTurnAt,
      recoveryMinutes,
      heat: participant.heat,
      effectiveSpeed: participant.effectiveSpeed,
    });
    return unfrozen;
  }

  return {
    ...participant,
    currentLoad: 0,
  };
}

function selectReadyParticipants(
  state: FaceHeartbeatState,
  maxJobs: number,
  completedThisTick: Set<string>,
  queuedIdentities: Set<string>,
  restStates: Map<string, RepoFaceRestSnapshot>,
  idleCooling: IdleCoolingSnapshot,
): FaceHeartbeatParticipant[] {
  const pendingMentionCounts = countPendingMentionsByIdentity(state.pendingMentions);
  const eligible = state.participants
    .filter((participant) => {
      const pendingMentionCount = pendingMentionCounts.get(participant.identityId) ?? 0;
      const restState = restStates.get(participant.identityId);
      return (
        participant.status === "active" &&
        participant.currentLoad < 1 &&
        !queuedIdentities.has(participant.identityId) &&
        !completedThisTick.has(participant.identityId) &&
        !(
          participant.participantKind === "repo_face" &&
          pendingMentionCount === 0 &&
          restState?.isNapping === true
        )
      );
    });

  if (eligible.length === 0) {
    return [];
  }

  const ready = eligible
    .filter((participant) => participant.nextTurnAt <= state.initiativeClock)
    .sort((left, right) => {
      const pendingDelta =
        (pendingMentionCounts.get(right.identityId) ?? 0) -
        (pendingMentionCounts.get(left.identityId) ?? 0);
      if (pendingDelta !== 0) {
        return pendingDelta;
      }
      const readyDelta = left.nextTurnAt - right.nextTurnAt;
      if (readyDelta !== 0) {
        return readyDelta;
      }
      if (right.reactionBias !== left.reactionBias) {
        return right.reactionBias - left.reactionBias;
      }
      if (right.effectiveSpeed !== left.effectiveSpeed) {
        return right.effectiveSpeed - left.effectiveSpeed;
      }
      return left.identityId.localeCompare(right.identityId);
    });

  if (!idleCooling.enabled || !idleCooling.active) {
    return ready.slice(0, maxJobs);
  }

  const mentioned = ready.filter((participant) => (pendingMentionCounts.get(participant.identityId) ?? 0) > 0);
  const unprompted = ready.filter((participant) => (pendingMentionCounts.get(participant.identityId) ?? 0) === 0);
  const coolingAllowsUnpromptedTurn =
    !idleCooling.nextUnpromptedTurnAllowedAt ||
    Date.parse(idleCooling.nextUnpromptedTurnAllowedAt) <= Date.now();
  const cooled = coolingAllowsUnpromptedTurn && mentioned.length < maxJobs ? unprompted.slice(0, 1) : [];

  return [...mentioned, ...cooled].slice(0, maxJobs);
}

function advanceInitiativeClockFromWallClock(state: FaceHeartbeatState, now: Date): void {
  const lastTickMs = Date.parse(state.lastTickAt ?? "");
  if (!Number.isFinite(lastTickMs)) {
    return;
  }

  const elapsedMinutes = (now.getTime() - lastTickMs) / 60_000;
  if (elapsedMinutes <= 0) {
    return;
  }

  const boundedElapsedMinutes = Math.min(elapsedMinutes, 60);
  state.initiativeClock = round3(state.initiativeClock + boundedElapsedMinutes);
}

function rescheduleStaleOverdueParticipants(state: FaceHeartbeatState): void {
  const activeParticipants = state.participants.filter((participant) => participant.status === "active");
  const count = Math.max(activeParticipants.length, 1);
  let rescheduledCount = 0;

  activeParticipants.forEach((participant, index) => {
    const staleThreshold = Math.max(participant.baseRecoveryMinutes, 15);
    if (participant.nextTurnAt >= state.initiativeClock - staleThreshold) {
      return;
    }

    participant.nextTurnAt = round3(state.initiativeClock + (participant.baseRecoveryMinutes / count) * index);
    rescheduledCount += 1;
  });

  if (rescheduledCount > 0) {
    state.history.push({
      type: "wall_clock_resync",
      rescheduledCount,
      initiativeClock: state.initiativeClock,
    });
  }
}

function applyPendingMentionPriority(state: FaceHeartbeatState): void {
  const pendingMentionCounts = countPendingMentionsByIdentity(state.pendingMentions);
  for (const participant of state.participants) {
    if (
      participant.status === "active" &&
      participant.currentLoad < 1 &&
      (pendingMentionCounts.get(participant.identityId) ?? 0) > 0
    ) {
      participant.nextTurnAt = Math.min(participant.nextTurnAt, state.initiativeClock);
    }
  }
}

function pendingMentionsForParticipant(
  state: FaceHeartbeatState,
  identityId: string,
): RepoFacePendingMention[] {
  return state.pendingMentions
    .filter((mention) => mention.identityId === identityId)
    .sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
}

function countPendingMentionsByIdentity(
  pendingMentions: RepoFacePendingMention[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mention of pendingMentions) {
    counts.set(mention.identityId, (counts.get(mention.identityId) ?? 0) + 1);
  }
  return counts;
}

async function readIdleCoolingSnapshot(input: {
  config: ReturnType<typeof loadConfig>;
  identities: RepoDiscordIdentity[];
  state: FaceHeartbeatState;
  now: Date;
}): Promise<IdleCoolingSnapshot> {
  const policy = input.config.repoFaceHeartbeats.idleCooling;
  const checkedChannelIds = collectIdleCoolingChannelIds(input.config, input.identities);
  const base = {
    enabled: policy.enabled,
    active: false,
    checkedChannelIds,
    idleAfterMinutes: policy.idleAfterMinutes,
    recoveryMinutes: policy.recoveryMinutes,
    lastUnpromptedTurnQueuedAt: newestUnpromptedTurnQueuedAt(input.state),
  };

  if (!policy.enabled) {
    return { ...base, reason: "disabled" };
  }
  if (!input.config.botToken) {
    return { ...base, reason: "missing_discord_bot_token" };
  }
  if (checkedChannelIds.length === 0) {
    return { ...base, reason: "no_watched_discord_channels" };
  }

  let newestHumanActivityAt: string | undefined;
  const fetchErrors: string[] = [];
  for (const channelId of checkedChannelIds) {
    try {
      const messages = await fetchRecentDiscordMessages({
        botToken: input.config.botToken,
        channelId,
        limit: 10,
      });
      for (const message of messages) {
        if (message.isBot || !message.content.trim()) {
          continue;
        }
        const timestampMs = Date.parse(message.timestamp);
        const newestMs = Date.parse(newestHumanActivityAt ?? "");
        if (Number.isFinite(timestampMs) && (!Number.isFinite(newestMs) || timestampMs > newestMs)) {
          newestHumanActivityAt = message.timestamp;
        }
      }
    } catch (error) {
      fetchErrors.push(`${channelId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const lastUnpromptedTurnQueuedAt = base.lastUnpromptedTurnQueuedAt;
  const lastUnpromptedTurnQueuedMs = Date.parse(lastUnpromptedTurnQueuedAt ?? "");
  const nextUnpromptedTurnAllowedAt = Number.isFinite(lastUnpromptedTurnQueuedMs)
    ? new Date(lastUnpromptedTurnQueuedMs + policy.recoveryMinutes * 60_000).toISOString()
    : undefined;

  if (!newestHumanActivityAt) {
    return {
      ...base,
      active: true,
      reason: fetchErrors.length > 0 ? "activity_fetch_failed_or_no_human_messages" : "no_recent_human_messages",
      nextUnpromptedTurnAllowedAt,
    };
  }

  const idleForMinutes = Math.max(0, (input.now.getTime() - Date.parse(newestHumanActivityAt)) / 60_000);
  return {
    ...base,
    active: idleForMinutes >= policy.idleAfterMinutes,
    reason: fetchErrors.length > 0 ? "partial_activity_fetch_failure" : undefined,
    lastHumanActivityAt: newestHumanActivityAt,
    idleForMinutes: round3(idleForMinutes),
    nextUnpromptedTurnAllowedAt,
  };
}

function collectIdleCoolingChannelIds(
  config: ReturnType<typeof loadConfig>,
  identities: RepoDiscordIdentity[],
): string[] {
  return Array.from(new Set([
    config.repoFaceHeartbeats.defaultChannelId,
    config.bifrostDiscordChannelId,
    ...config.indexedChannelIds,
    ...identities.flatMap((identity) => getRepoDiscordIdentityAllowedChannelIds(identity)),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)));
}

function newestUnpromptedTurnQueuedAt(state: FaceHeartbeatState): string | undefined {
  for (const entry of [...state.history].reverse()) {
    if (entry.type !== "queued" && entry.type !== "dry_run_selected") {
      continue;
    }
    if (typeof entry.queuedAt !== "string") {
      continue;
    }
    if (typeof entry.pendingMentionCount === "number" && entry.pendingMentionCount > 0) {
      continue;
    }
    return entry.queuedAt;
  }
  return undefined;
}

function buildHeartbeatPrompt(input: {
  identity: RepoDiscordIdentity;
  channelId: string;
  channelPlan: RepoFaceChannelPlan;
  channelSnapshots: ChannelSnapshot[];
  recentMessages: SourceMessage[];
  memorySurface?: string;
  repoActivitySurface?: string;
  conversationMemorySurface?: string;
  humanPronounGuidance?: RepoFaceHumanPronounGuidance[];
  bifrostDigest?: BifrostGovernanceDigest;
  participant: FaceHeartbeatParticipant;
  pendingMentions: RepoFacePendingMention[];
  jurisdictionDive: JurisdictionDiveDirective;
  githubActionsEnabled: boolean;
  globalAgentDoctrine: string;
  colossusOdinDoctrine: string;
}): string {
  return loadPromptTemplate("repo-face-turn.prompt.md", {
    displayName: input.identity.displayName,
    identityId: input.identity.id,
    repoName: input.identity.repoName,
    identityDoctrine: renderRepoCharacterIdentityDoctrine(input.identity),
    globalAgentDoctrine: input.globalAgentDoctrine,
    colossusOdinDoctrine: input.colossusOdinDoctrine,
    channelId: input.channelId,
    memorySurface: input.memorySurface ?? `- ${input.identity.displayName} has no strong personal memory surface yet. Let the attached conversation and repo evidence wake something specific.`,
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

async function renderColossusOdinDoctrine(input: {
  displayName: string;
  repoName: string;
}): Promise<string> {
  const poem = await ensureGameCultTextDocument(ODIN_VERSE_POEM_DOCUMENT_ID);
  const odinVersePoem = renderGameCultStructuredTextDocument(poem, {
    halfLineSeparator: "    ",
    stanzaSeparator: "\n\n",
  });

  return loadPromptTemplate("repo-face-colossus-odin-doctrine.prompt.md", {
    displayName: input.displayName,
    repoName: input.repoName,
    odinVersePoem,
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
  const fallbackChannelId = channelPlan.primaryChannelId;
  if (!fallbackChannelId) {
    throw new Error(`No prompt assembly channel is configured for ${identity.id}.`);
  }

  const [fetchedChannelSnapshots, bifrostDigest] = await Promise.all([
    fetchChannelSnapshots({
      botToken: input.config.botToken,
      channelIds: channelPlan.snapshotChannelIds,
      limit: 15,
      bifrostDiscordChannelId: input.config.bifrostDiscordChannelId,
    }),
    input.config.repoFaceBifrostEnabled
      ? fetchBifrostGovernanceDigest({
          bifrostRoot: input.config.bifrostRoot,
          repoName: identity.repoName,
          agentIdentity: identity.id,
        })
      : Promise.resolve(undefined),
  ]);
  const turnTarget = selectRepoFaceTurnTarget({
    channelPlan,
    fetchedChannelSnapshots,
    pendingMentions: [],
    fallbackChannelId,
  });
  const channelId = turnTarget.channelId;
  const activeChannelPlan: RepoFaceChannelPlan = {
    ...channelPlan,
    primaryChannelId: channelId,
  };
  const recentMessages = messagesForChannel(fetchedChannelSnapshots, channelId);
  const channelSnapshots = fetchedChannelSnapshots
    .filter((snapshot) => snapshot.channelId !== channelId)
    .slice(0, 5);
  const roomContext = {
    recentMessages,
    channelSnapshots,
  };
  const humanPronounGuidance = await loadRepoFaceHumanPronounGuidance(input.config, roomContext);
  const memorySurface = input.memorySurfacePath
    ? await readOptionalMemorySurface(input.memorySurfacePath)
    : await renderRepoFaceMemorySurfaceForTurn(
        identity,
        input.config,
        registry.identities,
        roomContext,
        humanPronounGuidance,
      );
  const repoActivitySurface = renderRepoFaceRepoActivitySurface(identity, input.config);
  const globalAgentDoctrine = await loadGlobalAgentDoctrine();
  const colossusOdinDoctrine = await renderColossusOdinDoctrine({
    displayName: identity.displayName,
    repoName: identity.repoName,
  });
  const conversationMemorySurface = input.conversationSurfacePath
    ? await readOptionalMemorySurface(input.conversationSurfacePath)
    : renderRepoFaceConversationTranscript({
        identity,
        recentMessages,
        channelSnapshots,
        pendingMentions: [],
        channelPlan: activeChannelPlan,
      });
  const participant = buildInspectionParticipant(
    identity,
    input.config.repoFaceHeartbeats.baseRecoveryMinutes,
  );
  const prompt = buildHeartbeatPrompt({
    identity,
    channelId,
    channelPlan: activeChannelPlan,
    channelSnapshots,
    recentMessages,
    memorySurface,
    repoActivitySurface,
    conversationMemorySurface,
    humanPronounGuidance,
    bifrostDigest,
    participant,
    pendingMentions: [],
    jurisdictionDive: buildJurisdictionDiveDirective(identity, participant),
    githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
    globalAgentDoctrine,
    colossusOdinDoctrine,
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
): Promise<string> {
  if (identity.identityKind === "native_persona") {
    return renderNativePersonaMemorySurface(identity);
  }

  const statePath = resolveRepoFaceStatePath(identity, config.storageRoot);
  const typedState = await loadVoidSelfStateTypedDocuments({ canonicalPath: statePath });
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

async function renderNativePersonaMemorySurface(identity: RepoDiscordIdentity): Promise<string> {
  const personaStatePath = identity.personaStatePath;
  if (!personaStatePath) {
    return [
      `${identity.displayName} is a native VoidBot Persona, not a repo Face.`,
      "No Persona state path is registered. Treat that as a Body fault and keep the public turn modest.",
    ].join("\n");
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
        .sort(([, left], [, right]) => right.weight - left.weight)
        .map(([key, value]) => `${key}=${value.weight.toFixed(2)}${value.note ? ` (${cleanCharacterFacingSentence(value.note)})` : ""}`);
      return entries.length > 0 ? `- ${section}: ${entries.join("; ")}` : undefined;
    })
    .filter((entry): entry is string => typeof entry === "string");

  return sections.length > 0
    ? ["Activation profile that should color behavior:", ...sections].join("\n")
    : undefined;
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

    for (const seed of seedQueries) {
      const [historyResults, sourceResults, homeSourceResults] = await Promise.all([
        retrieval.searchHistory(seed.query, 8),
        retrieval.searchRepositorySources(seed.query, 8),
        retrieval.searchRepositorySources(seed.query, 6, { repoName: identity.repoName }),
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
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder,
    sourceEmbedder,
  });
  return new RetrievalService(stores.history, stores.source);
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
  sections.push([
    "Read this as raw recent message evidence, not as a summary and not as consensus.",
    "Messages are ordered oldest to newest inside each section. Newer human corrections can supersede older agent proposals.",
    "Use the visible cross-channel chronology below to decide whether a correction is still unresolved or was already answered later by the same Face.",
    "Do not infer consensus from agents repeating each other. If a human reframes, narrows, or corrects an agent's proposal, account for that correction directly.",
    "If you answer the live conversation, default to the current room unless a human explicitly asks to move elsewhere.",
    "Message IDs are shown so a public reply can target the message that gives it context. If you revive an older side thread, either reply_to that message id or include enough context in your message for readers to know what you mean.",
  ].join("\n"));
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
    `Current room (${currentLabel}), oldest to newest:`,
    ...formatConversationMessages(input.recentMessages, 15),
  ].join("\n"));
  for (const snapshot of input.channelSnapshots) {
    const label = input.channelPlan.options.find((option) => option.channelId === snapshot.channelId)?.label ??
      "nearby room";
    sections.push([
      `Nearby ${label}, oldest to newest:`,
      ...formatConversationMessages(snapshot.messages, 6),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function renderVisibleConversationChronology(input: {
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  channelPlan: RepoFaceChannelPlan;
}): string {
  const byId = new Map<string, SourceMessage & { channelLabel: string }>();
  const primaryLabel = input.channelPlan.options.find((option) =>
    option.channelId === input.channelPlan.primaryChannelId
  )?.label ?? "current room";
  for (const message of input.recentMessages) {
    byId.set(message.id, { ...message, channelLabel: primaryLabel });
  }
  for (const snapshot of input.channelSnapshots) {
    const label = input.channelPlan.options.find((option) => option.channelId === snapshot.channelId)?.label ??
      "nearby room";
    for (const message of snapshot.messages) {
      byId.set(message.id, { ...message, channelLabel: label });
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
      return `- [${message.channelLabel}] ${speaker} (message ${message.id}): ${content}${renderMessageAttachmentSuffix(message)}`;
    }),
  ].join("\n");
}

function renderRepoFaceRepoActivitySurface(
  identity: RepoDiscordIdentity,
  config: ReturnType<typeof loadConfig>,
): string {
  const statePath = resolveRepoFaceStatePath(identity, config.storageRoot);
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts", "export-recent-repo-activity.mjs"),
      "--repos",
      identity.repoName,
      "--state-path",
      statePath,
      "--read-only",
      "--hours",
      "96",
      "--max-commits",
      "5",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );

  if (result.status !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-600);
    return [
      `- Recent ${identity.repoName} activity could not be read for this turn.`,
      detail ? `- Reader error: ${collapseWhitespace(detail, 500)}` : "- Reader error: no diagnostic output.",
      "- Do not claim current repo state from stale memory; use source/history tools before making fresh claims.",
    ].join("\n");
  }

  try {
    const parsed = JSON.parse(result.stdout) as { digest?: unknown };
    const digest = typeof parsed.digest === "string" ? parsed.digest.trim() : "";
    return digest || `- No recent ${identity.repoName} activity was reported.`;
  } catch {
    return [
      `- Recent ${identity.repoName} activity output was not parseable.`,
      `- Raw output: ${collapseWhitespace(result.stdout, 500)}`,
      "- Do not claim current repo state from stale memory; use source/history tools before making fresh claims.",
    ].join("\n");
  }
}

function formatConversationMessages(messages: SourceMessage[], limit: number): string[] {
  if (messages.length === 0) {
    return ["- No recent messages."];
  }
  return messages.slice(-limit).map((message) => {
    const speaker = message.isBot ? `${message.authorName} (agent/bot)` : message.authorName;
    const content = collapseWhitespace(message.content, 900) || "[no text]";
    return `- ${speaker} (message ${message.id}): ${content}${renderMessageAttachmentSuffix(message)}`;
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

function buildChannelPlan(
  identity: RepoDiscordIdentity,
  defaultChannelId?: string,
  preferredChannelId?: string,
): RepoFaceChannelPlan {
  const explicit = identity.channelPermissions.map((permission): RepoFaceChannelOption => ({
    channelId: permission.channelId,
    label: permission.label ?? permission.channelId,
    topic: permission.topic ?? "general",
    speechThreshold: permission.speechThreshold,
    speedMultiplier: permission.speedMultiplier,
    posture: permission.posture,
  }));
  const explicitChannelIds = new Set(explicit.map((permission) => permission.channelId));
  const legacy = identity.allowedChannelIds
    .filter((channelId) => !explicitChannelIds.has(channelId))
    .map((channelId): RepoFaceChannelOption => ({
      channelId,
      label: channelId === defaultChannelId ? "default" : channelId,
      topic: channelId === defaultChannelId ? "casual Aquarium musing" : "registered channel",
      speechThreshold: channelId === defaultChannelId ? "very_low" : "medium",
      speedMultiplier: channelId === defaultChannelId ? 1.5 : 1,
      posture: channelId === defaultChannelId
        ? "Low-stakes casual chatter, half-formed fascinations, jokes, little observations, and friendly asides are welcome here."
        : undefined,
    }));
  const fallback = explicit.length === 0 && legacy.length === 0 && defaultChannelId
    ? [{
        channelId: defaultChannelId,
        label: "aquarium",
        topic: "casual Aquarium musing",
        speechThreshold: "very_low" as const,
        speedMultiplier: 1.5,
        posture: "Low-stakes casual chatter, half-formed fascinations, jokes, little observations, and friendly asides are welcome here.",
      }]
    : [];
  const options = [...explicit, ...legacy, ...fallback];
  const preferred = preferredChannelId
    ? options.find((option) => option.channelId === preferredChannelId)
    : undefined;
  const primary = preferred ?? options
    .slice()
    .sort((left, right) => thresholdRank(left.speechThreshold) - thresholdRank(right.speechThreshold))
    [0];

  return {
    primaryChannelId: primary?.channelId,
    snapshotChannelIds: [
      ...new Set([
        ...options.map((option) => option.channelId),
        ...(preferredChannelId ? [preferredChannelId] : []),
      ]),
    ],
    options,
    lowThresholdTopics: options
      .filter((option) => thresholdRank(option.speechThreshold) <= thresholdRank("low"))
      .map((option) => option.topic),
  };
}

function newestPendingMentionChannel(pendingMentions: RepoFacePendingMention[]): string | undefined {
  return pendingMentions
    .slice()
    .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))
    [0]?.channelId;
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
}): string {
  const lines: string[] = [];
  if (input.pendingMentions.length > 0) {
    lines.push(
      "A direct call is tugging at you. Answer the newest unresolved call first; if it belongs to another steward, name that owner and offer only the piece your own territory can honestly add.",
      "Do not ask what the job is when the direct call or current room memory already states it.",
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

function thresholdRank(threshold: RepoFaceChannelOption["speechThreshold"]): number {
  switch (threshold) {
    case "very_low":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
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

function recoveryFor(participant: FaceHeartbeatParticipant): number {
  const loadPenalty = 1 + participant.currentLoad * 0.75;
  return (participant.baseRecoveryMinutes * loadPenalty) / Math.max(participant.effectiveSpeed, 0.1);
}

async function readHeartbeatState(path: string): Promise<FaceHeartbeatState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(stripLeadingBom(raw)) as Partial<FaceHeartbeatState> & {
      baseIntervalMinutes?: number;
      participants?: Array<Partial<FaceHeartbeatParticipant> & { nextReadyAt?: string }>;
    };
    if (parsed.schemaVersion === HEARTBEAT_SCHEMA_VERSION) {
      return {
        schemaVersion: HEARTBEAT_SCHEMA_VERSION,
        initiativeClock: Number.isFinite(parsed.initiativeClock) ? parsed.initiativeClock : 0,
        baseRecoveryMinutes: Number.isFinite(parsed.baseRecoveryMinutes) ? parsed.baseRecoveryMinutes : 10,
        globalHeat: Number.isFinite(parsed.globalHeat) ? parsed.globalHeat : 1,
        lastTickAt: parsed.lastTickAt,
        participants: Array.isArray(parsed.participants) ? parsed.participants as FaceHeartbeatParticipant[] : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        pendingMentions: Array.isArray(parsed.pendingMentions)
          ? parsed.pendingMentions.filter(isRepoFacePendingMention)
          : [],
      };
    }
    if (Array.isArray(parsed.participants)) {
      return migrateLegacyHeartbeatState(parsed);
    }
  } catch {
    // fall through to a new state
  }

  return {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    initiativeClock: 0,
    baseRecoveryMinutes: 10,
    globalHeat: 1,
    participants: [],
    history: [],
    pendingMentions: [],
  };
}

async function writeHeartbeatState(path: string, state: FaceHeartbeatState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function publishSwarmDashboardSurface(): void {
  const scriptPath = resolve(process.cwd(), "scripts", "render-voidbot-swarm-dashboard.mjs");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) {
    return;
  }

  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const detail = [stderr, stdout].filter(Boolean).join("\n");
  console.error(
    `VoidBot swarm CultMesh surface publish failed with exit code ${result.status ?? "unknown"}${detail ? `:\n${detail}` : "."}`,
  );
}

function migrateLegacyHeartbeatState(
  parsed: Partial<FaceHeartbeatState> & {
    baseIntervalMinutes?: number;
    participants?: Array<Partial<FaceHeartbeatParticipant> & { nextReadyAt?: string }>;
  },
): FaceHeartbeatState {
  const nowMs = Date.now();
  const legacyBase = Number.isFinite(parsed.baseIntervalMinutes) ? parsed.baseIntervalMinutes : 30;
  const baseRecoveryMinutes = Math.max(5, legacyBase / 3);
  const participants = (parsed.participants ?? []).map((participant, index) => {
    const speed = Number.isFinite(participant.initiativeSpeed) ? participant.initiativeSpeed : 1;
    const legacyReadyMs = participant.nextReadyAt ? Date.parse(participant.nextReadyAt) : NaN;
    const minutesUntilReady = Number.isFinite(legacyReadyMs)
      ? Math.max(0, (legacyReadyMs - nowMs) / 60_000)
      : index * baseRecoveryMinutes;

    return {
      identityId: participant.identityId ?? `legacy-face-${index + 1}`,
      repoName: participant.repoName ?? "unknown",
      displayName: participant.displayName ?? participant.identityId ?? `Legacy Face ${index + 1}`,
      initiativeSpeed: speed,
      reactionBias: Number.isFinite(participant.reactionBias) ? participant.reactionBias : 0.4,
      interruptThreshold: Number.isFinite(participant.interruptThreshold) ? participant.interruptThreshold : 0.6,
      currentLoad: Number.isFinite(participant.currentLoad) ? participant.currentLoad : 0,
      status: participant.status ?? "active",
      groups: participant.groups ?? [],
      heat: Number.isFinite(participant.heat) ? participant.heat : 1,
      effectiveSpeed: Number.isFinite(participant.effectiveSpeed) ? participant.effectiveSpeed : speed,
      baseRecoveryMinutes,
      nextTurnAt: minutesUntilReady,
      lastTurnAt: participant.lastTurnAt,
      activeTurnStartedAt: participant.activeTurnStartedAt,
      activeJobId: participant.activeJobId,
      lastQueuedAt: participant.lastQueuedAt,
      queuedCount: Number.isFinite(participant.queuedCount) ? participant.queuedCount : 0,
      constraints: participant.constraints ?? [
        "Migrated from wall-clock repo Face turn state.",
      ],
    } satisfies FaceHeartbeatParticipant;
  });

  return {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    initiativeClock: 0,
    baseRecoveryMinutes,
    globalHeat: 1,
    lastTickAt: parsed.lastTickAt,
    participants,
    pendingMentions: Array.isArray(parsed.pendingMentions)
      ? parsed.pendingMentions.filter(isRepoFacePendingMention)
      : [],
    history: [
      ...(Array.isArray(parsed.history) ? parsed.history : []),
      {
        type: "migrated",
        fromSchemaVersion: parsed.schemaVersion ?? "unknown",
        migratedAt: new Date().toISOString(),
        participantCount: participants.length,
      },
    ].slice(-80),
  };
}

function isRepoFacePendingMention(value: unknown): value is RepoFacePendingMention {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.identityId === "string" &&
    typeof record.channelId === "string" &&
    typeof record.messageId === "string" &&
    typeof record.authorId === "string" &&
    typeof record.content === "string" &&
    typeof record.visiblePrompt === "string" &&
    typeof record.queuedAt === "string"
  );
}

function initiativeSpeedFor(
  spec: ParticipantSpec,
  speedOverrides: Record<string, number>,
): number {
  const override = speedOverrides[spec.id.toLowerCase()];
  if (override !== undefined) {
    return clamp(override, 0.35, 6);
  }

  if (spec.id === "void") {
    return 1;
  }

  return clamp(0.85 + stableUnit(spec.id, "speed") * 0.45, 0.75, 1.3);
}

function channelSpeedMultiplierFor(identity: RepoDiscordIdentity): number {
  const multipliers = identity.channelPermissions.map((permission) => permission.speedMultiplier);
  return multipliers.length > 0 ? clamp(Math.max(...multipliers), 0.5, 3) : 1;
}

function initiativeGroupsFor(spec: ParticipantSpec): string[] {
  return Array.from(new Set([
    "all",
    `kind:${spec.participantKind}`,
    `turn:${spec.turnKind}`,
    `identity:${normalizeKey(spec.id)}`,
    `repo:${normalizeKey(spec.repoName)}`,
    `display:${normalizeKey(spec.displayName)}`,
    ...spec.allowedChannelIds.map((channelId) => `channel:${channelId}`),
  ]));
}

function heatFor(
  spec: ParticipantSpec,
  groups: string[],
  globalHeat: number,
  heatOverrides: Record<string, number>,
): number {
  const keys = [
    "all",
    ...groups,
    normalizeKey(spec.id),
    normalizeKey(spec.repoName),
    normalizeKey(spec.displayName),
  ];
  return clamp(
    keys.reduce((heat, key) => heat * (heatOverrides[key] ?? 1), globalHeat),
    0.05,
    20,
  );
}

function reactionBiasFor(spec: ParticipantSpec): number {
  return spec.id === "void"
    ? 0.55
    : clamp(0.2 + stableUnit(spec.id, "reaction") * 0.55, 0.2, 0.75);
}

function interruptThresholdFor(spec: ParticipantSpec): number {
  return spec.id === "void"
    ? 0.5
    : clamp(0.45 + stableUnit(spec.id, "threshold") * 0.35, 0.45, 0.8);
}

function stableUnit(id: string, salt: string): number {
  const hex = createHash("sha1").update(`${id}:${salt}`).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
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
