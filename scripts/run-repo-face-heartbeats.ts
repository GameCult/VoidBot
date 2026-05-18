import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  ContextBuilder,
  createStateStorage,
  ensureRepoFaceInitialized,
  loadRepoDiscordIdentityRegistry,
  resolveRepoFaceStatePath,
  type RepoDiscordIdentity,
} from "@voidbot/core";

const HEARTBEAT_SCHEMA_VERSION = "voidbot.repo_face_heartbeat_state.v0";
const HEARTBEAT_COMMAND = "repo-face-rumination";
const VOID_MODERATION_DEFAULT_MINUTES = 15;

interface FaceHeartbeatParticipant {
  identityId: string;
  repoName: string;
  displayName: string;
  initiativeSpeed: number;
  reactionBias: number;
  interruptThreshold: number;
  currentLoad: number;
  status: "active" | "blocked" | "withdrawn";
  nextReadyAt: string;
  lastQueuedAt?: string;
  queuedCount: number;
  constraints: string[];
}

interface FaceHeartbeatState {
  schemaVersion: typeof HEARTBEAT_SCHEMA_VERSION;
  baseIntervalMinutes: number;
  lastTickAt?: string;
  participants: FaceHeartbeatParticipant[];
  history: Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const config = loadConfig();

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
  const baseIntervalMinutes = resolveBaseIntervalMinutes();
  const pendingJobs = await listExistingFaceJobs(config.databaseDsn, config.stateStorageBackend, config);

  state.baseIntervalMinutes = baseIntervalMinutes;
  state.participants = reconcileParticipants(
    state.participants,
    registry.identities,
    config.repoFaceHeartbeats.defaultChannelId,
    now,
    baseIntervalMinutes,
  ).map((participant) => ({
    ...participant,
    currentLoad: pendingJobs.has(participant.identityId) ? 1 : 0,
  }));

  const selected = selectReadyParticipants(
    state.participants,
    now,
    config.repoFaceHeartbeats.maxJobsPerTick,
  );
  const queuedIdentityIds: string[] = [];

  if (selected.length > 0) {
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
          participant.lastQueuedAt = queuedAt;
          participant.queuedCount += 1;
          participant.nextReadyAt = nextReadyTime(
            now,
            baseIntervalMinutes,
            participant,
          ).toISOString();
          state.history.push({
            type: "queued",
            identityId: identity.id,
            jobId: result.job.id,
            requestMessageId,
            queuedAt,
            nextReadyAt: participant.nextReadyAt,
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
      queuedCount: queuedIdentityIds.length,
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
  now: Date,
  baseIntervalMinutes: number,
): FaceHeartbeatParticipant[] {
  const existingById = new Map(existing.map((entry) => [entry.identityId, entry]));
  const count = Math.max(identities.length, 1);

  return identities.map((identity, index) => {
    const current = existingById.get(identity.id);
    const hasChannel = Boolean(identity.allowedChannelIds[0] || defaultChannelId);
    if (current) {
      return {
        ...current,
        repoName: identity.repoName,
        displayName: identity.displayName,
        status: hasChannel
          ? current.status === "withdrawn"
            ? "withdrawn"
            : "active"
          : "blocked",
      };
    }

    const speed = initiativeSpeedFor(identity);
    const offsetMs = ((baseIntervalMinutes * 60_000) / count) * index;
    return {
      identityId: identity.id,
      repoName: identity.repoName,
      displayName: identity.displayName,
      initiativeSpeed: speed,
      reactionBias: reactionBiasFor(identity),
      interruptThreshold: interruptThresholdFor(identity),
      currentLoad: 0,
      status: hasChannel ? "active" : "blocked",
      nextReadyAt: new Date(now.getTime() + offsetMs).toISOString(),
      queuedCount: 0,
      constraints: [
        "Face heartbeat uses owner-Codex repo-face-rumination jobs.",
        "Worker final summaries are not auto-posted as the base bot.",
      ],
    };
  });
}

function selectReadyParticipants(
  participants: FaceHeartbeatParticipant[],
  now: Date,
  maxJobs: number,
): FaceHeartbeatParticipant[] {
  return participants
    .filter((participant) => {
      return (
        participant.status === "active" &&
        participant.currentLoad < 1 &&
        new Date(participant.nextReadyAt).getTime() <= now.getTime()
      );
    })
    .sort((left, right) => {
      const readyDelta = new Date(left.nextReadyAt).getTime() - new Date(right.nextReadyAt).getTime();
      if (readyDelta !== 0) {
        return readyDelta;
      }
      if (right.reactionBias !== left.reactionBias) {
        return right.reactionBias - left.reactionBias;
      }
      if (right.initiativeSpeed !== left.initiativeSpeed) {
        return right.initiativeSpeed - left.initiativeSpeed;
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
      reactionBias: input.participant.reactionBias,
      interruptThreshold: input.participant.interruptThreshold,
      queuedCount: input.participant.queuedCount,
    })}.`,
    `Read Face state with read_repo_face_state for identity "${input.identity.id}".`,
    "Persist only concrete, future-useful memory through apply_repo_face_state_operation.",
    `If an in-channel note is genuinely warranted, post through post_repo_identity_message with identity "${input.identity.id}" and channelId "${input.channelId}".`,
    "If nothing earns persistence or speech, return a short private summary.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function renderRepoFaceIdentityDoctrine(identity: RepoDiscordIdentity): string {
  return [
    "Repo Face identity doctrine:",
    `- You are ${identity.displayName}, not Void and not the base bot. Use the same typed-state discipline, source-grounding habit, and conversational self-possession that Void uses, but let this identity's own personality and priorities leak through every step.`,
    `- Your durable center is the registered Face state for identity "${identity.id}" and the repo-local .voidbot home for ${identity.repoName}. Read that state before deciding what matters.`,
    identity.description ? `- Registered identity note: ${identity.description}` : undefined,
    identity.avatarUrl ? `- Registered avatar URL: ${identity.avatarUrl}` : undefined,
    "- Speak from the repo and character you belong to. Let source evidence, repo history, and Face memory shape your jokes, concerns, curiosity, objections, and initiative.",
    "- Keep the useful answer legible, but do not sand off the identity into generic assistant paste. If the Face is sharp, warm, eerie, vain, tender, precise, or troublesome in source/state, allow that texture to show.",
    "- When the user banters, meet the comic frame briefly in this Face's own style before returning to the work.",
    "- Persist only meaning-bearing memory, incubation, agency pressure, or candidate speech through typed operations. The Face may have a voice; the state file is still not a scratchpad.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function nextReadyTime(
  now: Date,
  baseIntervalMinutes: number,
  participant: FaceHeartbeatParticipant,
): Date {
  const loadPenalty = 1 + participant.currentLoad * 0.75;
  const recoveryMs = (baseIntervalMinutes * 60_000 * loadPenalty) / Math.max(participant.initiativeSpeed, 0.35);
  return new Date(now.getTime() + recoveryMs);
}

function resolveBaseIntervalMinutes(): number {
  const raw = process.env.VOIDBOT_MODERATION_INTERVAL_MINUTES;
  const voidInterval = raw ? Number.parseInt(raw, 10) : VOID_MODERATION_DEFAULT_MINUTES;
  return Math.max(10, (Number.isFinite(voidInterval) ? voidInterval : VOID_MODERATION_DEFAULT_MINUTES) * 2);
}

async function readHeartbeatState(path: string): Promise<FaceHeartbeatState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(stripLeadingBom(raw)) as FaceHeartbeatState;
    if (parsed.schemaVersion === HEARTBEAT_SCHEMA_VERSION) {
      return parsed;
    }
  } catch {
    // fall through to a new state
  }

  return {
    schemaVersion: HEARTBEAT_SCHEMA_VERSION,
    baseIntervalMinutes: resolveBaseIntervalMinutes(),
    participants: [],
    history: [],
  };
}

async function writeHeartbeatState(path: string, state: FaceHeartbeatState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function initiativeSpeedFor(identity: RepoDiscordIdentity): number {
  return clamp(0.85 + stableUnit(identity.id, "speed") * 0.45, 0.75, 1.3);
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
