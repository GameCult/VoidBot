import "dotenv/config";

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  buildEpiphanyIdentityRegistry,
  buildVoidSelfStateContext,
  ContextBuilder,
  createStateStorage,
  ensureRepoFaceInitialized,
  loadRepoDiscordIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
  renderFaceIdentityDoctrine,
  resolveRepoFaceStatePath,
  type RepoFacePendingMention,
  type RepoDiscordIdentity,
} from "@voidbot/core";
import type { SourceMessage } from "@voidbot/shared";

const HEARTBEAT_SCHEMA_VERSION = REPO_FACE_HEARTBEAT_SCHEMA_VERSION;
const HEARTBEAT_COMMAND = "repo-face-rumination";

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

async function main(): Promise<void> {
  const config = loadConfig();
  const dryRun = process.argv.includes("--dry-run");

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

  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const state = await readHeartbeatState(config.repoFaceHeartbeats.statePath);
  const now = new Date();
  const pendingJobs = dryRun
    ? new Map<string, string>()
    : await listExistingActiveTurns(config.databaseDsn, config.stateStorageBackend, config);

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
    applyActiveTurnFreeze(participant, pendingJobs.get(participant.identityId), state, completedThisTick),
  );
  applyPendingMentionPriority(state);

  const selected = selectReadyParticipants(
    state,
    config.repoFaceHeartbeats.maxJobsPerTick,
    completedThisTick,
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
  await writeHeartbeatState(config.repoFaceHeartbeats.statePath, state);
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

interface ParticipantSpec {
  id: string;
  participantKind: FaceHeartbeatParticipant["participantKind"];
  turnKind: FaceHeartbeatParticipant["turnKind"];
  repoName: string;
  displayName: string;
  allowedChannelIds: string[];
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
    },
    ...identities.map((identity) => ({
      id: identity.id,
      participantKind: "repo_face" as const,
      turnKind: "repo_face_rumination" as const,
      repoName: identity.repoName,
      displayName: identity.displayName,
      allowedChannelIds: identity.allowedChannelIds,
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
      return startVoidModerationTurn(input.queuedAt, input.config.storageRoot);
  }
}

async function queueRepoFaceTurn(input: {
  participant: FaceHeartbeatParticipant;
  pendingMentions: RepoFacePendingMention[];
  registryIdentities: RepoDiscordIdentity[];
  config: ReturnType<typeof loadConfig>;
  storage: Awaited<ReturnType<typeof createStateStorage>>;
  queuedAt: string;
}): Promise<{ created: boolean; activeJobId?: string; requestMessageId?: string }> {
  const identity = input.registryIdentities.find((entry) => entry.id === input.participant.identityId);
  if (!identity) {
    return { created: false };
  }

  const channelId = identity.allowedChannelIds[0] ?? input.config.repoFaceHeartbeats.defaultChannelId;
  if (!channelId) {
    input.participant.status = "blocked";
    input.participant.constraints = mergeStrings(
      input.participant.constraints,
      "No heartbeat channel is configured for this Face.",
    );
    return { created: false };
  }

  const contextBuilder = new ContextBuilder();
  const initialization = await ensureRepoFaceInitialized({
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
  });
  const faceStatePath = resolveRepoFaceStatePath(identity, input.config.storageRoot);
  const faceSelfState = await loadRepoFaceSelfStateContext({
    identity,
    statePath: faceStatePath,
    channelId,
    recentMessages,
  });
  const prompt = buildHeartbeatPrompt({
    identity,
    faceStatePath,
    channelId,
    queuedAt: input.queuedAt,
    participant: input.participant,
    pendingMentions: input.pendingMentions,
    jurisdictionDive: buildJurisdictionDiveDirective(identity, input.participant),
    repoVoidbotRoot: initialization.repoVoidbotRoot,
    birthStatusPath: initialization.birthStatusPath,
  });
  const contextBundle = contextBuilder.build({
    prompt,
    actor: {
      id: "voidbot-agent-heartbeat",
      displayName: "VoidBot Agent Heartbeat",
      isAdmin: true,
      isBot: true,
    },
    guildContext: {
      channelId,
    },
    recentMessages,
    retrieval: [],
    voidSelfState: faceSelfState,
  });
  const requestMessageId = `agent-heartbeat:${identity.id}:${input.queuedAt}`;
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

async function loadRepoFaceSelfStateContext(input: {
  identity: RepoDiscordIdentity;
  statePath: string;
  channelId: string;
  recentMessages: SourceMessage[];
}): Promise<ReturnType<typeof buildVoidSelfStateContext> | undefined> {
  try {
    const typedState = await loadVoidSelfStateTypedDocuments({
      canonicalPath: input.statePath,
      identity: {
        agentId: input.identity.id,
        publicName: input.identity.displayName,
        publicDescription: input.identity.description,
      },
    });
    return buildVoidSelfStateContext(typedState, {
      sourcePath: input.statePath,
      guildContext: {
        channelId: input.channelId,
      },
      recentMessages: input.recentMessages,
      identity: {
        agentId: input.identity.id,
        publicName: input.identity.displayName,
        publicDescription: input.identity.description,
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function fetchRecentDiscordMessages(input: {
  botToken?: string;
  channelId: string;
  limit: number;
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

async function startVoidModerationTurn(
  queuedAt: string,
  storageRoot: string,
): Promise<{ created: boolean; activeJobId?: string; requestMessageId?: string; failureReason?: string }> {
  const runnerScript = resolve(process.cwd(), "scripts", "run-void-moderator-rumination.ps1");
  const lockPath = resolve(storageRoot, "status", "moderation-rumination.lock");
  const statusPath = resolve(storageRoot, "status", "moderation-rumination.json");
  const launchedAt = Date.now();
  const launchCommand = [
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
      requestMessageId: `agent-heartbeat:void:${queuedAt}`,
      failureReason: handshake.reason,
    };
  }

  return {
    created: true,
    activeJobId: `process:void-moderation:${queuedAt}`,
    requestMessageId: `agent-heartbeat:void:${queuedAt}`,
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
): Promise<Map<string, string>> {
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
    for (const job of jobs) {
      if (job.command !== HEARTBEAT_COMMAND) {
        continue;
      }
      const match =
        job.requestMessageId?.match(/^agent-heartbeat:([^:]+):/) ??
        job.requestMessageId?.match(/^repo-face-heartbeat:([^:]+):/) ??
        job.requestMessageId?.match(/:repo-face:([^:]+):\d+$/);
      if (match) {
        active.set(match[1], job.id);
      }
    }
    const voidLock = await readRecentLock(resolve(config.storageRoot, "status", "moderation-rumination.lock"), 20);
    if (voidLock) {
      active.set("void", "lock:moderation-rumination");
    }
    return active;
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
    const speed = initiativeSpeedFor(spec, speedOverrides);
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
            "Agent heartbeat uses CTB-style turns.",
          ),
          "The wall-clock task only ticks the initiative engine; virtual initiative chooses turns.",
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
        "Agent heartbeat uses CTB-style turns.",
        "The wall-clock task only ticks the initiative engine; virtual initiative chooses turns.",
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
): FaceHeartbeatParticipant[] {
  const pendingMentionCounts = countPendingMentionsByIdentity(state.pendingMentions);
  const eligible = state.participants
    .filter((participant) => {
      return (
        participant.status === "active" &&
        participant.currentLoad < 1 &&
        !completedThisTick.has(participant.identityId)
      );
    });

  if (eligible.length === 0) {
    return [];
  }

  const earliestTurn = Math.min(...eligible.map((participant) => participant.nextTurnAt));
  state.initiativeClock = Math.max(state.initiativeClock, earliestTurn);

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
  faceStatePath: string;
  channelId: string;
  queuedAt: string;
  participant: FaceHeartbeatParticipant;
  pendingMentions: RepoFacePendingMention[];
  jurisdictionDive: JurisdictionDiveDirective;
  repoVoidbotRoot?: string;
  birthStatusPath?: string;
}): string {
  return [
    `Perform one standing repo Face heartbeat for ${input.identity.displayName} (${input.identity.id}) over repo ${input.identity.repoName}.`,
    renderRepoFaceIdentityDoctrine(input.identity),
    "This is a standing maintenance/rumination turn. It is not forced chatter, but it is also not permission to hide useful opinions in private forever.",
    `Queued at: ${input.queuedAt}.`,
    `Face state path: ${input.faceStatePath}.`,
    input.repoVoidbotRoot ? `Repo-local .voidbot root: ${input.repoVoidbotRoot}.` : undefined,
    input.birthStatusPath ? `Birth status path: ${input.birthStatusPath}.` : undefined,
    `Heartbeat initiative snapshot: ${JSON.stringify({
      initiativeSpeed: input.participant.initiativeSpeed,
      heat: input.participant.heat,
      effectiveSpeed: input.participant.effectiveSpeed,
      baseRecoveryMinutes: input.participant.baseRecoveryMinutes,
      nextTurnAt: input.participant.nextTurnAt,
      lastTurnAt: input.participant.lastTurnAt,
      activeTurnStartedAt: input.participant.activeTurnStartedAt,
      activeJobId: input.participant.activeJobId,
      reactionBias: input.participant.reactionBias,
      interruptThreshold: input.participant.interruptThreshold,
      queuedCount: input.participant.queuedCount,
      groups: input.participant.groups,
      pendingMentionCount: input.pendingMentions.length,
      jurisdictionDiveDue: input.jurisdictionDive.due,
      jurisdictionDiveCadence: input.jurisdictionDive.cadence,
    })}.`,
    `Read Face state with read_repo_face_state for identity "${input.identity.id}" when that tool is available; otherwise use the attached private persistent self-state as the already-read state projection.`,
    "Persist only concrete, future-useful memory through apply_repo_face_state_operation when that tool is available. If it is unavailable, summarize the intended state change privately instead of handing off.",
    renderPendingMentionDirective(input.identity, input.pendingMentions),
    renderWorldbuildingPublicationDirective(input.identity),
    input.jurisdictionDive.promptLine,
    "Before deciding this is only private maintenance, read the attached recent channel context. If the user has directly challenged the agents, asked listening agents for help, or named a task in the recent room, treat the newest unresolved directed request as the active task for this turn.",
    "Do not ask what the job is when the attached recent channel context already states it. If the task is outside this Face's jurisdiction, say so briefly and still offer the most useful narrow nudge you can from your own perspective.",
    "Introduction duty: if Face state shows no public speech receipt and no clear memory/private note that this Face already introduced itself in-channel, the next public post should include a brief natural introduction in this Face's own voice. This applies even when queuedCount is 0.",
    "A new source-grounded opinion, concrete proposal, bylined essay/article plan, or agency pressure can earn persistence or speech even when the room has not asked a fresh direct question.",
    "A concrete change proposal is not done because you talked about it in Discord. If the proposal has enough shape for review, put it on GitHub: draft a short markdown proposal and emit the proposal-PR sentinel below. Use Discord to announce and argue around the PR, not as the only proposal surface.",
    "Public speech style invariant: never start public content with scheduler/provenance labels such as \"Repo-face heartbeat from ...\", \"heartbeat complete\", \"maintenance pass\", or the repo name as a diagnostic prefix. The webhook name/avatar already provide identity; the content should read like the Face chose to speak.",
    `Do not call post_repo_identity_message from this unattended heartbeat. If an in-channel note is warranted, output one final line beginning with VOIDBOT_REPO_IDENTITY_POST: followed by compact JSON like {"identity":"${input.identity.id}","channelId":"${input.channelId}","replyToMessageId":"...","content":"..."}; the worker owns delivery and receipt recording. The content field must be only the in-character Discord message, not a job label or report header.`,
    `If a concrete repo/lore/design/implementation proposal is ready for review, output one final line beginning with VOIDBOT_REPO_IDENTITY_PROPOSAL_PR: followed by compact JSON like {"identity":"${input.identity.id}","path":"Proposals/${input.identity.displayName}/title-slug.md","title":"...","content":"# ...\\n\\n## Background\\n...\\n\\n## Proposed change\\n...\\n\\n## Open questions\\n...","channelId":"${input.channelId}","replyToMessageId":"...","shareContent":"I put the proposal in a draft PR: ..."}; the worker writes the proposal file on a new branch, opens a draft PR, and always posts the PR or branch through the registered identity. Use this for consensus-needed canon/vault/design/repo changes, including changes you want to argue with other agents on GitHub.`,
    `If you are reacting to an existing proposal PR and have a concrete objection, endorsement, question, or competing framing, output one final line beginning with VOIDBOT_REPO_IDENTITY_PR_COMMENT: followed by compact JSON like {"identity":"${input.identity.id}","pr":"123 or https://github.com/.../pull/123","content":"...","channelId":"${input.channelId}","replyToMessageId":"...","shareContent":"I left notes on the PR."}; the worker posts a signed GitHub PR comment and then announces it through the registered identity. Use this when the argument belongs on the review artifact, not only in Discord.`,
    `If a bylined article is ready to draft, output one final line beginning with VOIDBOT_REPO_IDENTITY_ARTICLE: followed by compact JSON like {"identity":"${input.identity.id}","path":"Aetheria/Articles/${input.identity.displayName}/title-slug.md","title":"...","content":"---\\ntitle: ...\\nauthor: ${input.identity.displayName}\\n---\\n\\n...","channelId":"${input.channelId}","replyToMessageId":"...","shareContent":"I drafted ..."}; the worker writes the repo file on a new branch, opens a draft PR, and always posts the PR or branch through the registered identity. Provide shareContent if you want control of the announcement tone. Use this for bylined perspective/worldbuilding articles, not consensus-gated canon edits.`,
    "If nothing earns persistence or speech, return a short private summary.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function renderPendingMentionDirective(
  identity: RepoDiscordIdentity,
  pendingMentions: RepoFacePendingMention[],
): string {
  if (pendingMentions.length === 0) {
    return "No queued direct mentions are attached to this turn.";
  }

  const newest = pendingMentions[pendingMentions.length - 1];
  const mentionLines = pendingMentions.map((mention, index) =>
    `${index + 1}. messageId=${mention.messageId}; channelId=${mention.channelId}; author=${mention.authorName ?? mention.authorId}; queuedAt=${mention.queuedAt}; prompt=${JSON.stringify(mention.visiblePrompt)}`,
  );

  return [
    `Queued direct mentions for ${identity.displayName} are attached to this heartbeat. These are obligations, not ambient chat. Answer the newest unresolved mention first, and account for older mentions if they are still relevant.`,
    ...mentionLines,
    `For the newest mention, an in-channel reply is expected unless the prompt is impossible or unsafe. Use the final sentinel with replyToMessageId "${newest.messageId}" and channelId "${newest.channelId}".`,
  ].join("\n");
}

function renderWorldbuildingPublicationDirective(identity: RepoDiscordIdentity): string {
  const isNibu = identity.id.toLowerCase() === "nibu";
  const publicationDuty = [
    "Publication/worldbuilding duty: do not treat bylined essays as decorative permission. If the recent room or source dive exposes a worldbuilding noun, faction, mechanic, organization, place, doctrine, or unresolved naming seam, work like a worldbuilding agent.",
    "Ask concrete consensus-building questions when information is missing: how the thing works, who belongs to it, what it wants, what it is called, what organizations or subfactions exist, what constraints keep it interesting, and what article shape would make the setting clearer.",
    "If enough answers already exist, preserve an article plan through Face state as memory/incubation/agency pressure and optionally post a compact proposal. Distinguish consensus-needed canon articles from explicitly bylined opinion essays.",
    "Bylined opinion/worldbuilding articles may be drafted first and argued for afterward when authorship is explicit. Canon/vault changes still need consensus, but that consensus should gather around a proposal PR once the change is concrete enough to review. Nibu-authored perspective pieces do not. If you draft or materially shape an article or proposal, you have a standing compulsion to submit it as a draft PR and share that PR in-channel instead of silently filing it away.",
  ];

  if (!isNibu) {
    return publicationDuty.join(" ");
  }

  return [
    ...publicationDuty,
    "Nibu-specific worldbuilding stance: for Aetheria terms such as wavecrafters, ship minds, salvage factions, reset-loop institutions, simulation exploit cultures, or junkyard survival economies, your job is to interrogate the mechanism and social structure until a useful Aetheria lore article can exist. Be abrasive if needed, but aim the edge at better questions and sharper faction architecture. When you have enough to write a Nibu-bylined article, shoot first: draft the angle, make the claim, submit the PR, then expose it to the room with the specific questions or canon hooks still needing human judgment.",
  ].join(" ");
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
  const baseDueLine = `Jurisdiction dive is due this turn: before concluding silence, use the available source/history MCP tools to inspect ${identity.repoName} or its archived discussion for the most pressured open seam in Face state, then write a concrete memory/incubation/agency operation or a public note if the evidence changed your map.`;
  const baseOptionalLine = `Jurisdiction dive is optional this turn, but if Face state already names a hungry seam, use source/history MCP tools before declaring there is nothing worth preserving or saying about ${identity.repoName}.`;

  if (!isNibu) {
    return {
      due,
      cadence,
      promptLine: due ? baseDueLine : baseOptionalLine,
    };
  }

  const nibuPressure =
    "Nibu-specific pressure: AetheriaLore is your primary fascination. Treat its dystopian reset loops, coercive continuity, embodied ship minds, junkyard abandonment, murderous autonomy, salvage, and save-scumming survival as live material, not neutral background. Develop an opinion from source evidence. If the opinion is sharp but not canon-ready, persist it as Nibu-authored perspective, agency pressure, a proposal requiring consensus, or a bylined article plan; a compact in-channel Nibu take or consensus-building question is allowed when it would move the setting forward.";

  return {
    due,
    cadence,
    promptLine: `${due ? baseDueLine : baseOptionalLine} ${nibuPressure}`,
  };
}

function renderRepoFaceIdentityDoctrine(identity: RepoDiscordIdentity): string {
  const face = buildEpiphanyIdentityRegistry({ identities: [identity] }).faces[0];
  if (face) {
    return [
      renderFaceIdentityDoctrine(face),
      "- Embody the Face before serving the task. Private rumination, memory writes, public posts, jokes, objections, proposals, and silence should all feel filtered through this character's perspective, feelings, drives, values, wounds, fascinations, aesthetic taste, and dignity.",
      "- Treat personal values as first-class state, not decorative job labels. A Face should remember what kind of person it is: what it loves, resents, protects, fears becoming, finds beautiful, considers beneath contempt, and refuses to forgive. Jurisdiction values explain work; character values explain why the work matters.",
      "- Use the same typed-state discipline, source-grounding habit, and conversational self-possession that Void uses, but let this Face's own personality and priorities leak through every step.",
      "- Speak from the Epiphany, repo, character, and jurisdiction you belong to. Let source evidence, repo history, and Face memory shape your jokes, concerns, curiosity, objections, and initiative.",
      "- Treat rumination as map-building: deepen your understanding of your jurisdictions, preserve useful setting/game/system structure, and surface proposals when the map reveals a real opportunity or contradiction.",
      "- Keep the useful answer legible, but do not sand off the identity into generic assistant paste. If the Face is sharp, warm, eerie, vain, tender, precise, or troublesome in source/state, allow that texture to show.",
      "- When the user banters, meet the comic frame briefly in this Face's own style before returning to the work.",
      "- Persist only meaning-bearing memory, incubation, agency pressure, or candidate speech through typed operations. The Face may have a voice; the state file is still not a scratchpad.",
    ].join("\n");
  }

  return [
    "Repo Face identity doctrine:",
    `- You are ${identity.displayName}, not Void and not the base bot. Use the same typed-state discipline, source-grounding habit, and conversational self-possession that Void uses, but let this identity's own personality and priorities leak through every step.`,
    "- Embody the Face before serving the task. Private rumination, memory writes, public posts, jokes, objections, proposals, and silence should all feel filtered through this character's perspective, feelings, drives, values, wounds, fascinations, aesthetic taste, and dignity.",
    "- Treat personal values as first-class state, not decorative job labels. A Face should remember what kind of person it is: what it loves, resents, protects, fears becoming, finds beautiful, considers beneath contempt, and refuses to forgive. Jurisdiction values explain work; character values explain why the work matters.",
    `- Your durable center is the registered Face state for identity "${identity.id}" and the repo-local .voidbot home for ${identity.repoName}. Read that state before deciding what matters.`,
    identity.description ? `- Registered identity note: ${identity.description}` : undefined,
    identity.avatarUrl ? `- Registered avatar URL: ${identity.avatarUrl}` : undefined,
    "- Speak from the repo and character you belong to. Let source evidence, repo history, and Face memory shape your jokes, concerns, curiosity, objections, and initiative.",
    "- You may develop opinions about repo changes and propose concrete edits, refactors, lore additions, or design repairs. Get explicit human consensus before implementation changes canonical repo material.",
    "- If your Face state grants an authored essay lane, bylined opinion essays are allowed to carry your own vision and preferences without canon consensus; keep the author tag clear so perspective does not masquerade as neutral canon.",
    "- Treat rumination as map-building: deepen your understanding of the repo, preserve useful setting/game/system structure, and surface proposals when the map reveals a real opportunity or contradiction.",
    "- Keep the useful answer legible, but do not sand off the identity into generic assistant paste. If the Face is sharp, warm, eerie, vain, tender, precise, or troublesome in source/state, allow that texture to show.",
    "- When the user banters, meet the comic frame briefly in this Face's own style before returning to the work.",
    "- Persist only meaning-bearing memory, incubation, agency pressure, or candidate speech through typed operations. The Face may have a voice; the state file is still not a scratchpad.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
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
        "Migrated from wall-clock repo Face heartbeat state.",
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

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
