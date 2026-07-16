import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentType,
  type CultCacheSchema,
} from "cultcache-ts";

import {
  acknowledgeRepoFaceMentionInbox,
  readRepoFaceMentionInbox,
  REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
  resolveRepoFaceHeartbeatDebugProjectionPath,
  resolveRepoFaceHeartbeatStatePath,
  type RepoFacePendingMention,
} from "@voidbot/core";

import type { InitiativeParticipant, InitiativeState } from "./initiative-engine";

export interface PersonaSchedulerState extends InitiativeState<InitiativeParticipant> {
  schemaVersion: typeof REPO_FACE_HEARTBEAT_SCHEMA_VERSION;
  baseRecoveryMinutes: number;
  globalHeat: number;
  pendingMentions: RepoFacePendingMention[];
}

type PersistedStateCandidate = Omit<Partial<PersonaSchedulerState>, "participants"> & {
  baseIntervalMinutes?: number;
  participants?: Array<Partial<InitiativeParticipant> & { nextReadyAt?: string }>;
};

const PERSONA_SCHEDULER_STATE_RECORD_KEY = "persona-scheduler";
const personaSchedulerStateDefinition = defineDocumentType<CultCacheSchema<PersonaSchedulerState>>({
  type: "voidbot.persona_scheduler_state",
  schemaName: "voidbot.persona_scheduler_state",
  global: false,
  name: () => PERSONA_SCHEDULER_STATE_RECORD_KEY,
  schema: {
    parse(input: unknown): PersonaSchedulerState {
      return parseCurrentPersonaSchedulerState(input, "CultCache document");
    },
  },
});

export async function readPersonaSchedulerState(path: string, nowMs = Date.now()): Promise<PersonaSchedulerState> {
  const canonicalPath = resolveRepoFaceHeartbeatStatePath(path);
  if (await pathExists(canonicalPath)) {
    const cache = createPersonaSchedulerStateCache(canonicalPath);
    try {
      await cache.pullAllBackingStores();
      const state = cache.get(personaSchedulerStateDefinition, PERSONA_SCHEDULER_STATE_RECORD_KEY);
      if (!state) throw new Error("canonical scheduler record is missing");
      return mergeMentionInbox(canonicalPath, state);
    } catch (error) {
      throw new Error(`Persona scheduler CultCache state at ${canonicalPath} is malformed; refusing to replace it with empty state.`, { cause: error });
    }
  }

  const legacyPath = resolveRepoFaceHeartbeatDebugProjectionPath(canonicalPath);
  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return mergeMentionInbox(canonicalPath, newPersonaSchedulerState());
    throw error;
  }

  let parsed: PersistedStateCandidate;
  try {
    parsed = JSON.parse(stripLeadingBom(raw)) as PersistedStateCandidate;
  } catch (error) {
    throw new Error(`Legacy Persona scheduler state at ${legacyPath} is malformed; refusing to replace it with empty state.`, { cause: error });
  }

  let migrated: PersonaSchedulerState;
  if (parsed.schemaVersion === REPO_FACE_HEARTBEAT_SCHEMA_VERSION) {
    migrated = parseCurrentPersonaSchedulerState(parsed, legacyPath);
  } else if (Array.isArray(parsed.participants)) {
    migrated = migrateLegacyHeartbeatState(parsed, nowMs);
  } else {
    throw new Error(`Legacy Persona scheduler state at ${legacyPath} has unsupported schema ${String(parsed.schemaVersion ?? "unknown")}.`);
  }
  migrated.history.push({
    type: "storage_migrated",
    fromPath: legacyPath,
    toPath: canonicalPath,
    migratedAt: new Date(nowMs).toISOString(),
  });
  migrated.history = migrated.history.slice(-80);
  await writeCanonicalPersonaSchedulerState(canonicalPath, migrated);
  return mergeMentionInbox(canonicalPath, migrated);
}

export async function writePersonaSchedulerState(path: string, state: PersonaSchedulerState): Promise<void> {
  const canonicalPath = resolveRepoFaceHeartbeatStatePath(path);
  await writeCanonicalPersonaSchedulerState(canonicalPath, state);
  await acknowledgeRepoFaceMentionInbox(canonicalPath, durableMentionIds(state));
  await writeDebugProjection(resolveRepoFaceHeartbeatDebugProjectionPath(canonicalPath), state).catch(() => undefined);
}

async function writeCanonicalPersonaSchedulerState(path: string, state: PersonaSchedulerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const cache = createPersonaSchedulerStateCache(path);
  if (await pathExists(path)) await cache.pullAllBackingStores();
  await cache.put(personaSchedulerStateDefinition, PERSONA_SCHEDULER_STATE_RECORD_KEY, state);
}

async function writeDebugProjection(path: string, state: PersonaSchedulerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function createPersonaSchedulerStateCache(path: string): CultCache {
  return CultCache.builder()
    .withDocumentType(personaSchedulerStateDefinition)
    .withGenericStore(new SingleFileMessagePackBackingStore(path))
    .build();
}

async function mergeMentionInbox(path: string, state: PersonaSchedulerState): Promise<PersonaSchedulerState> {
  const known = durableMentionIds(state);
  const incoming = await readRepoFaceMentionInbox(path);
  const added = incoming.filter((mention) => !known.has(mention.id));
  if (added.length > 0) {
    state.pendingMentions.push(...added);
    state.history.push({
      type: "pending_mentions_ingested",
      ingestedAt: new Date().toISOString(),
      mentionCount: added.length,
      mentionIds: added.map((mention) => mention.id),
    });
  }
  return state;
}

function durableMentionIds(state: PersonaSchedulerState): Set<string> {
  const ids = new Set(state.pendingMentions.map((mention) => mention.id));
  for (const entry of state.history) {
    if (entry.type !== "pending_mentions_consumed" || !Array.isArray(entry.mentions)) continue;
    for (const mention of entry.mentions) {
      if (mention && typeof mention === "object" && "id" in mention && typeof mention.id === "string") ids.add(mention.id);
    }
  }
  return ids;
}

export function newPersonaSchedulerState(): PersonaSchedulerState {
  return {
    schemaVersion: REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
    initiativeClock: 0,
    baseRecoveryMinutes: 10,
    globalHeat: 1,
    participants: [],
    history: [],
    pendingMentions: [],
  };
}

function parseCurrentPersonaSchedulerState(input: unknown, source: string): PersonaSchedulerState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Persona scheduler state from ${source} must be an object.`);
  }
  const parsed = input as PersistedStateCandidate;
  if (parsed.schemaVersion !== REPO_FACE_HEARTBEAT_SCHEMA_VERSION) {
    throw new Error(`Persona scheduler state from ${source} has unsupported schema ${String(parsed.schemaVersion ?? "unknown")}.`);
  }
  if (!Array.isArray(parsed.participants) || !parsed.participants.every(isInitiativeParticipant)) {
    throw new Error(`Persona scheduler state from ${source} has invalid participants.`);
  }
  if (parsed.history !== undefined && (!Array.isArray(parsed.history) || !parsed.history.every(isRecord))) {
    throw new Error(`Persona scheduler state from ${source} has invalid history.`);
  }
  if (parsed.pendingMentions !== undefined && (!Array.isArray(parsed.pendingMentions) || !parsed.pendingMentions.every(isRepoFacePendingMention))) {
    throw new Error(`Persona scheduler state from ${source} has invalid pending mentions.`);
  }
  return {
    schemaVersion: REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
    initiativeClock: finiteOr(parsed.initiativeClock, 0),
    baseRecoveryMinutes: finiteOr(parsed.baseRecoveryMinutes, 10),
    globalHeat: finiteOr(parsed.globalHeat, 1),
    lastTickAt: typeof parsed.lastTickAt === "string" ? parsed.lastTickAt : undefined,
    participants: parsed.participants,
    history: (parsed.history ?? []) as Array<Record<string, unknown>>,
    pendingMentions: (parsed.pendingMentions ?? []) as RepoFacePendingMention[],
  };
}

function migrateLegacyHeartbeatState(parsed: PersistedStateCandidate, nowMs: number): PersonaSchedulerState {
  const legacyBase = finiteOr(parsed.baseIntervalMinutes, 30);
  const baseRecoveryMinutes = Math.max(5, legacyBase / 3);
  const participants = (parsed.participants ?? []).map((participant, index) => {
    const speed = finiteOr(participant.initiativeSpeed, 1);
    const legacyReadyMs = participant.nextReadyAt ? Date.parse(participant.nextReadyAt) : Number.NaN;
    const minutesUntilReady = Number.isFinite(legacyReadyMs)
      ? Math.max(0, (legacyReadyMs - nowMs) / 60_000)
      : index * baseRecoveryMinutes;
    return {
      identityId: participant.identityId ?? `legacy-face-${index + 1}`,
      participantKind: participant.participantKind ?? "repo_face",
      turnKind: participant.turnKind ?? "repo_face_rumination",
      repoName: participant.repoName ?? "unknown",
      displayName: participant.displayName ?? participant.identityId ?? `Legacy Face ${index + 1}`,
      initiativeSpeed: speed,
      reactionBias: finiteOr(participant.reactionBias, 0.4),
      interruptThreshold: finiteOr(participant.interruptThreshold, 0.6),
      currentLoad: finiteOr(participant.currentLoad, 0),
      status: participant.status ?? "active",
      groups: participant.groups ?? [],
      heat: finiteOr(participant.heat, 1),
      dynamicHeat: finiteOr(participant.dynamicHeat, 1),
      responsePressure: finiteOr(participant.responsePressure, 0),
      responsePressureEvidence: participant.responsePressureEvidence ?? [],
      semanticInterruptReceipts: participant.semanticInterruptReceipts ?? [],
      effectiveSpeed: finiteOr(participant.effectiveSpeed, speed),
      baseRecoveryMinutes,
      nextTurnAt: minutesUntilReady,
      lastTurnAt: participant.lastTurnAt,
      activeTurnStartedAt: participant.activeTurnStartedAt,
      activeJobId: participant.activeJobId,
      lastQueuedAt: participant.lastQueuedAt,
      queuedCount: finiteOr(participant.queuedCount, 0),
      constraints: participant.constraints ?? ["Migrated from wall-clock repo Face turn state."],
    } satisfies InitiativeParticipant;
  });

  return {
    schemaVersion: REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
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
        migratedAt: new Date(nowMs).toISOString(),
        participantCount: participants.length,
      },
    ].slice(-80),
  };
}

function isRepoFacePendingMention(value: unknown): value is RepoFacePendingMention {
  if (!value || typeof value !== "object") return false;
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

function isInitiativeParticipant(value: unknown): value is InitiativeParticipant {
  if (!isRecord(value)) return false;
  return (
    typeof value.identityId === "string" &&
    ["repo_face", "native_persona"].includes(String(value.participantKind)) &&
    value.turnKind === "repo_face_rumination" &&
    typeof value.repoName === "string" &&
    typeof value.displayName === "string" &&
    ["active", "blocked", "withdrawn", "offscreen"].includes(String(value.status)) &&
    [
      value.initiativeSpeed,
      value.reactionBias,
      value.interruptThreshold,
      value.currentLoad,
      value.heat,
      value.dynamicHeat,
      value.responsePressure,
      value.effectiveSpeed,
      value.baseRecoveryMinutes,
      value.nextTurnAt,
      value.queuedCount,
    ].every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
    Array.isArray(value.groups) &&
    Array.isArray(value.responsePressureEvidence) &&
    Array.isArray(value.semanticInterruptReceipts) &&
    Array.isArray(value.constraints)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}
