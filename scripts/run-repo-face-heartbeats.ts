import "dotenv/config";

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  buildEpiphanyIdentityRegistry,
  ContextBuilder,
  createStateStorage,
  ensureRepoFaceInitialized,
  getRepoDiscordIdentityAllowedChannelIds,
  faceRegistryAsRepoDiscordRegistry,
  projectRepoFaceSleepCycleForNow,
  applyVoidSelfStateOperation,
  loadFaceIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
  type RepoFaceRestSnapshot,
  resolveRepoFaceStatePath,
  type RepoFacePendingMention,
  type RepoDiscordIdentity,
} from "@voidbot/core";
import { loadPromptTemplate, type SourceMessage } from "@voidbot/shared";

const HEARTBEAT_SCHEMA_VERSION = REPO_FACE_HEARTBEAT_SCHEMA_VERSION;
const HEARTBEAT_COMMAND = "repo-face-rumination";
const MIN_STALE_ACTIVE_JOB_MS = 45 * 60_000;

interface FaceHeartbeatParticipant {
  identityId: string;
  participantKind: "repo_face" | "system_agent";
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
  staleRecovered: StaleActiveTurn[];
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
    return;
  }

  const faceRegistry = await loadFaceIdentityRegistry(config.repoDiscordIdentitiesPath);
  const registry = faceRegistryAsRepoDiscordRegistry(faceRegistry);
  const state = await readHeartbeatState(config.repoFaceHeartbeats.statePath);
  const restStates = await loadRepoFaceRestStates(registry.identities, config.storageRoot, state, { dryRun });
  const now = new Date();
  advanceInitiativeClockFromWallClock(state, now);
  const activeTurnScan = dryRun
    ? { active: new Map<string, string>(), staleRecovered: [] }
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
      state,
      completedThisTick,
    ),
  );
  rescheduleStaleOverdueParticipants(state);
  applyPendingMentionPriority(state);

  const selected = selectReadyParticipants(
    state,
    config.repoFaceHeartbeats.maxJobsPerTick,
    completedThisTick,
    restStates,
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
          participant.activeTurnStartedAt = state.initiativeClock;
          participant.activeJobId = turn.activeJobId;
          participant.lastTurnAt = state.initiativeClock;
          participant.queuedCount += 1;
          participant.currentLoad = 1;
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
      participantKind: "repo_face" as const,
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

  const channelPlan = buildChannelPlan(identity, input.config.repoFaceHeartbeats.defaultChannelId);
  const channelId = channelPlan.primaryChannelId;
  if (!channelId) {
    input.participant.status = "blocked";
    input.participant.constraints = mergeStrings(
      input.participant.constraints,
      "No CTB turn channel is configured for this Face.",
    );
    return { created: false };
  }

  const contextBuilder = new ContextBuilder();
  await ensureRepoFaceInitialized({
    identity,
    storageRoot: input.config.storageRoot,
    sourceRepoRoot: input.config.sourceRepoRoot,
    epiphanyAgentRoot: input.config.epiphanyAgentRoot,
    workspaceRoot: process.cwd(),
    birthMode: input.config.repoFaceBirthMode,
    birthExecutor: input.config.repoFaceBirthExecutor,
  });
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
  const bifrostDigest = await fetchBifrostGovernanceDigest({
    bifrostRoot: input.config.bifrostRoot,
    repoName: identity.repoName,
    agentIdentity: identity.id,
  });
  const prompt = buildHeartbeatPrompt({
    identity,
    channelId,
    channelPlan,
    channelSnapshots,
    recentMessages,
    memorySurface: undefined,
    bifrostDigest,
    participant: input.participant,
    pendingMentions: input.pendingMentions,
    jurisdictionDive: buildJurisdictionDiveDirective(identity, input.participant),
    githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
  });
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
    },
    recentMessages,
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
  return messages
    .filter((message) => !(input.ignoreBotMessages && message.author.bot === true))
    .map((message) => ({
      id: message.id,
      authorId: message.author.id,
      authorName: message.author.global_name ?? message.member?.nick ?? message.author.username,
      content: message.content,
      timestamp: message.timestamp,
      isBot: message.author.bot === true,
    }))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

async function fetchChannelSnapshots(input: {
  botToken?: string;
  channelIds: string[];
  primaryChannelId: string;
  limit: number;
  bifrostDiscordChannelId?: string;
}): Promise<ChannelSnapshot[]> {
  const snapshots: ChannelSnapshot[] = [];
  for (const channelId of input.channelIds.filter((entry) => entry !== input.primaryChannelId).slice(0, 5)) {
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
    return { active, staleRecovered };
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
          ? current.status === "withdrawn"
            ? "withdrawn"
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
  restStates: Map<string, RepoFaceRestSnapshot>,
): FaceHeartbeatParticipant[] {
  const pendingMentionCounts = countPendingMentionsByIdentity(state.pendingMentions);
  const eligible = state.participants
    .filter((participant) => {
      const pendingMentionCount = pendingMentionCounts.get(participant.identityId) ?? 0;
      const restState = restStates.get(participant.identityId);
      return (
        participant.status === "active" &&
        participant.currentLoad < 1 &&
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

  return eligible
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
    })
    .slice(0, maxJobs);
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

function buildHeartbeatPrompt(input: {
  identity: RepoDiscordIdentity;
  channelId: string;
  channelPlan: RepoFaceChannelPlan;
  channelSnapshots: ChannelSnapshot[];
  recentMessages: SourceMessage[];
  memorySurface?: string;
  conversationMemorySurface?: string;
  bifrostDigest?: BifrostGovernanceDigest;
  participant: FaceHeartbeatParticipant;
  pendingMentions: RepoFacePendingMention[];
  jurisdictionDive: JurisdictionDiveDirective;
  githubActionsEnabled: boolean;
}): string {
  return loadPromptTemplate("repo-face-turn.prompt.md", {
    displayName: input.identity.displayName,
    identityId: input.identity.id,
    repoName: input.identity.repoName,
    identityDoctrine: renderRepoCharacterIdentityDoctrine(input.identity),
    channelId: input.channelId,
    memorySurface: input.memorySurface ?? `- ${input.identity.displayName} has no strong personal memory surface yet. Let the attached conversation and repo evidence wake something specific.`,
    conversationMemorySurface: input.conversationMemorySurface ?? "- No Interpreter-shaped conversation memory was projected for this turn.",
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

  const [recentMessages, channelSnapshots, bifrostDigest, memorySurface, conversationMemorySurface] = await Promise.all([
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
    fetchBifrostGovernanceDigest({
      bifrostRoot: input.config.bifrostRoot,
      repoName: identity.repoName,
      agentIdentity: identity.id,
    }),
    readOptionalMemorySurface(input.memorySurfacePath),
    readOptionalMemorySurface(input.conversationSurfacePath),
  ]);
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
    conversationMemorySurface,
    bifrostDigest,
    participant,
    pendingMentions: [],
    jurisdictionDive: buildJurisdictionDiveDirective(identity, participant),
    githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
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
  const primary = options
    .slice()
    .sort((left, right) => thresholdRank(left.speechThreshold) - thresholdRank(right.speechThreshold))
    [0];

  return {
    primaryChannelId: primary?.channelId,
    snapshotChannelIds: options.map((option) => option.channelId),
    options,
    lowThresholdTopics: options
      .filter((option) => thresholdRank(option.speechThreshold) <= thresholdRank("low"))
      .map((option) => option.topic),
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
    lines.push("If you speak publicly, make it a brief natural introduction in your own voice before asking the room for work or attention.");
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
  if (!digest || digest.topics.length === 0) {
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
