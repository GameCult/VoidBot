import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  buildEpiphanyIdentityRegistry,
  ContextBuilder,
  createStateStorage,
  ensureRepoFaceInitialized,
  loadRepoDiscordIdentityRegistry,
  renderFaceIdentityDoctrine,
  resolveRepoFaceStatePath,
  type RepoDiscordIdentity,
} from "@voidbot/core";

const HEARTBEAT_SCHEMA_VERSION = "voidbot.repo_face_heartbeat_state.v1";
const HEARTBEAT_COMMAND = "repo-face-rumination";

interface FaceHeartbeatParticipant {
  identityId: string;
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
    ? new Set<string>()
    : await listExistingFaceJobs(config.databaseDsn, config.stateStorageBackend, config);

  state.baseRecoveryMinutes = config.repoFaceHeartbeats.baseRecoveryMinutes;
  state.globalHeat = config.repoFaceHeartbeats.globalHeat;
  state.participants = reconcileParticipants(
    state.participants,
    registry.identities,
    config.repoFaceHeartbeats.defaultChannelId,
    config.repoFaceHeartbeats.speedOverrides,
    config.repoFaceHeartbeats.heatOverrides,
    state.initiativeClock,
    config.repoFaceHeartbeats.baseRecoveryMinutes,
    config.repoFaceHeartbeats.globalHeat,
  ).map((participant) => ({
    ...participant,
    currentLoad: pendingJobs.has(participant.identityId) ? 1 : 0,
  }));

  const selected = selectReadyParticipants(
    state,
    config.repoFaceHeartbeats.maxJobsPerTick,
  );
  const queuedIdentityIds: string[] = [];

  if (selected.length > 0 && dryRun) {
    const queuedAt = new Date().toISOString();
    for (const participant of selected) {
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
      const contextBuilder = new ContextBuilder();
      for (const participant of selected) {
        const identity = registry.identities.find((entry) => entry.id === participant.identityId);
        if (!identity) {
          continue;
        }

        const channelId = identity.allowedChannelIds[0] ?? config.repoFaceHeartbeats.defaultChannelId;
        if (!channelId) {
          participant.status = "blocked";
          participant.constraints = mergeStrings(
            participant.constraints,
            "No heartbeat channel is configured for this Face.",
          );
          continue;
        }

        const queuedAt = new Date().toISOString();
        const initialization = await ensureRepoFaceInitialized({
          identity,
          storageRoot: config.storageRoot,
          sourceRepoRoot: config.sourceRepoRoot,
          epiphanyAgentRoot: config.epiphanyAgentRoot,
          workspaceRoot: process.cwd(),
          birthMode: config.repoFaceBirthMode,
          birthExecutor: config.repoFaceBirthExecutor,
        });
        const prompt = buildHeartbeatPrompt({
          identity,
          faceStatePath: resolveRepoFaceStatePath(identity, config.storageRoot),
          channelId,
          queuedAt,
          participant,
          repoVoidbotRoot: initialization.repoVoidbotRoot,
          birthStatusPath: initialization.birthStatusPath,
        });
        const contextBundle = contextBuilder.build({
          prompt,
          actor: {
            id: "voidbot-repo-face-heartbeat",
            displayName: "VoidBot Repo Face Heartbeat",
            isAdmin: true,
            isBot: true,
          },
          guildContext: {
            channelId,
          },
          recentMessages: [],
          retrieval: [],
        });
        const requestMessageId = `repo-face-heartbeat:${identity.id}:${queuedAt}`;
        const result = await storage.jobQueue.createJob({
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

        if (result.created) {
          queuedIdentityIds.push(identity.id);
          const recoveryMinutes = recoveryFor(participant);
          participant.lastQueuedAt = queuedAt;
          participant.lastTurnAt = state.initiativeClock;
          participant.queuedCount += 1;
          participant.nextTurnAt = Math.max(state.initiativeClock, participant.nextTurnAt) + recoveryMinutes;
          state.history.push({
            type: "queued",
            identityId: identity.id,
            jobId: result.job.id,
            requestMessageId,
            queuedAt,
            initiativeClock: state.initiativeClock,
            nextTurnAt: participant.nextTurnAt,
            recoveryMinutes,
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

async function listExistingFaceJobs(
  databaseDsn: string,
  stateStorageBackend: "file" | "postgres",
  config: ReturnType<typeof loadConfig>,
): Promise<Set<string>> {
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
    const active = new Set<string>();
    for (const job of jobs) {
      if (job.command !== HEARTBEAT_COMMAND) {
        continue;
      }
      const match =
        job.requestMessageId?.match(/^repo-face-heartbeat:([^:]+):/) ??
        job.requestMessageId?.match(/:repo-face:([^:]+):\d+$/);
      if (match) {
        active.add(match[1]);
      }
    }
    return active;
  } finally {
    await storage.close();
  }
}

function reconcileParticipants(
  existing: FaceHeartbeatParticipant[],
  identities: RepoDiscordIdentity[],
  defaultChannelId: string | undefined,
  speedOverrides: Record<string, number>,
  heatOverrides: Record<string, number>,
  initiativeClock: number,
  baseRecoveryMinutes: number,
  globalHeat: number,
): FaceHeartbeatParticipant[] {
  const existingById = new Map(existing.map((entry) => [entry.identityId, entry]));
  const count = Math.max(identities.length, 1);

  return identities.map((identity, index) => {
    const current = existingById.get(identity.id);
    const hasChannel = Boolean(identity.allowedChannelIds[0] || defaultChannelId);
    const speed = initiativeSpeedFor(identity, speedOverrides);
    const groups = initiativeGroupsFor(identity);
    const heat = heatFor(identity, groups, globalHeat, heatOverrides);
    const effectiveSpeed = clamp(speed * heat, 0.1, 12);
    const nextTurnAt = Number.isFinite(current?.nextTurnAt)
      ? current.nextTurnAt
      : initiativeClock + ((baseRecoveryMinutes / count) * index);
    if (current) {
      return {
        ...current,
        repoName: identity.repoName,
        displayName: identity.displayName,
        initiativeSpeed: speed,
        groups,
        heat,
        effectiveSpeed,
        baseRecoveryMinutes,
        nextTurnAt,
        constraints: mergeStrings(
          mergeStrings(
            current.constraints,
            "Face heartbeat uses CTB-style owner-Codex repo-face-rumination jobs.",
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
      identityId: identity.id,
      repoName: identity.repoName,
      displayName: identity.displayName,
      initiativeSpeed: speed,
      reactionBias: reactionBiasFor(identity),
      interruptThreshold: interruptThresholdFor(identity),
      currentLoad: 0,
      status: hasChannel ? "active" : "blocked",
      groups,
      heat,
      effectiveSpeed,
      baseRecoveryMinutes,
      nextTurnAt,
      queuedCount: 0,
      constraints: [
        "Face heartbeat uses CTB-style owner-Codex repo-face-rumination jobs.",
        "The wall-clock task only ticks the initiative engine; virtual initiative chooses turns.",
        "Worker final summaries are not auto-posted as the base bot.",
      ],
    };
  });
}

function selectReadyParticipants(
  state: FaceHeartbeatState,
  maxJobs: number,
): FaceHeartbeatParticipant[] {
  const eligible = state.participants
    .filter((participant) => {
      return (
        participant.status === "active" &&
        participant.currentLoad < 1
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

function buildHeartbeatPrompt(input: {
  identity: RepoDiscordIdentity;
  faceStatePath: string;
  channelId: string;
  queuedAt: string;
  participant: FaceHeartbeatParticipant;
  repoVoidbotRoot?: string;
  birthStatusPath?: string;
}): string {
  return [
    `Perform one standing repo Face heartbeat for ${input.identity.displayName} (${input.identity.id}) over repo ${input.identity.repoName}.`,
    renderRepoFaceIdentityDoctrine(input.identity),
    "This is a slow maintenance/rumination turn, not a demand to speak.",
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
      reactionBias: input.participant.reactionBias,
      interruptThreshold: input.participant.interruptThreshold,
      queuedCount: input.participant.queuedCount,
      groups: input.participant.groups,
    })}.`,
    `Read Face state with read_repo_face_state for identity "${input.identity.id}".`,
    "Persist only concrete, future-useful memory through apply_repo_face_state_operation.",
    "Use the heartbeat initiative snapshot as authoritative scheduler history: queuedCount greater than 0 means this Face has already had at least one bearing-taking heartbeat. If queuedCount is greater than 0 and the Face state shows no public speech receipt or clear memory that it already introduced itself, a brief in-channel introduction is warranted now.",
    `Do not call post_repo_identity_message from this unattended heartbeat. If an in-channel note is warranted, output one final line beginning with VOIDBOT_REPO_IDENTITY_POST: followed by compact JSON like {"identity":"${input.identity.id}","channelId":"${input.channelId}","content":"..."}; the worker owns delivery and receipt recording.`,
    "If nothing earns persistence or speech, return a short private summary.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function renderRepoFaceIdentityDoctrine(identity: RepoDiscordIdentity): string {
  const face = buildEpiphanyIdentityRegistry({ identities: [identity] }).faces[0];
  if (face) {
    return [
      renderFaceIdentityDoctrine(face),
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

function initiativeSpeedFor(
  identity: RepoDiscordIdentity,
  speedOverrides: Record<string, number>,
): number {
  const override = speedOverrides[identity.id.toLowerCase()];
  if (override !== undefined) {
    return clamp(override, 0.35, 6);
  }

  return clamp(0.85 + stableUnit(identity.id, "speed") * 0.45, 0.75, 1.3);
}

function initiativeGroupsFor(identity: RepoDiscordIdentity): string[] {
  return Array.from(new Set([
    "all",
    `identity:${normalizeKey(identity.id)}`,
    `repo:${normalizeKey(identity.repoName)}`,
    `display:${normalizeKey(identity.displayName)}`,
    ...identity.allowedChannelIds.map((channelId) => `channel:${channelId}`),
  ]));
}

function heatFor(
  identity: RepoDiscordIdentity,
  groups: string[],
  globalHeat: number,
  heatOverrides: Record<string, number>,
): number {
  const keys = [
    "all",
    ...groups,
    normalizeKey(identity.id),
    normalizeKey(identity.repoName),
    normalizeKey(identity.displayName),
  ];
  return clamp(
    keys.reduce((heat, key) => heat * (heatOverrides[key] ?? 1), globalHeat),
    0.05,
    20,
  );
}

function reactionBiasFor(identity: RepoDiscordIdentity): number {
  return clamp(0.2 + stableUnit(identity.id, "reaction") * 0.55, 0.2, 0.75);
}

function interruptThresholdFor(identity: RepoDiscordIdentity): number {
  return clamp(0.45 + stableUnit(identity.id, "threshold") * 0.35, 0.45, 0.8);
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
