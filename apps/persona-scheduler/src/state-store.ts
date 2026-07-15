import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  acknowledgeRepoFaceMentionInbox,
  readRepoFaceMentionInbox,
  REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
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

export async function readPersonaSchedulerState(path: string, nowMs = Date.now()): Promise<PersonaSchedulerState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return mergeMentionInbox(path, newPersonaSchedulerState());
    throw error;
  }

  let parsed: PersistedStateCandidate;
  try {
    parsed = JSON.parse(stripLeadingBom(raw)) as PersistedStateCandidate;
  } catch (error) {
    throw new Error(`Persona scheduler state at ${path} is malformed; refusing to replace it with empty state.`, { cause: error });
  }

  if (parsed.schemaVersion === REPO_FACE_HEARTBEAT_SCHEMA_VERSION) {
    if (!Array.isArray(parsed.participants)) {
      throw new Error(`Persona scheduler state at ${path} has no participants array.`);
    }
    return mergeMentionInbox(path, {
      schemaVersion: REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
      initiativeClock: finiteOr(parsed.initiativeClock, 0),
      baseRecoveryMinutes: finiteOr(parsed.baseRecoveryMinutes, 10),
      globalHeat: finiteOr(parsed.globalHeat, 1),
      lastTickAt: parsed.lastTickAt,
      participants: parsed.participants as InitiativeParticipant[],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      pendingMentions: Array.isArray(parsed.pendingMentions)
        ? parsed.pendingMentions.filter(isRepoFacePendingMention)
        : [],
    });
  }

  if (Array.isArray(parsed.participants)) return mergeMentionInbox(path, migrateLegacyHeartbeatState(parsed, nowMs));
  throw new Error(`Persona scheduler state at ${path} has unsupported schema ${String(parsed.schemaVersion ?? "unknown")}.`);
}

export async function writePersonaSchedulerState(path: string, state: PersonaSchedulerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
    await acknowledgeRepoFaceMentionInbox(path, durableMentionIds(state));
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
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

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
