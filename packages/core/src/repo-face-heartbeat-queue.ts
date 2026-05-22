import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  type RepoDiscordIdentity,
  type RepoDiscordIdentityRegistry,
} from "./repo-discord-identities";

export const REPO_FACE_HEARTBEAT_SCHEMA_VERSION = "voidbot.repo_face_heartbeat_state.v1";

export interface RepoFacePendingMention {
  id: string;
  identityId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName?: string;
  content: string;
  visiblePrompt: string;
  queuedAt: string;
}

export async function queueRepoFaceMention(input: {
  statePath: string;
  identity: RepoDiscordIdentity;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName?: string;
  content: string;
  visiblePrompt: string;
  queuedAt?: string;
}): Promise<{ queued: boolean; pendingCount: number }> {
  return queueAgentHeartbeatMention({
    ...input,
    identityId: input.identity.id,
  });
}

export async function queueAgentHeartbeatMention(input: {
  statePath: string;
  identityId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName?: string;
  content: string;
  visiblePrompt: string;
  queuedAt?: string;
}): Promise<{ queued: boolean; pendingCount: number }> {
  const state = await readHeartbeatQueueState(input.statePath);
  const id = `${input.identityId}:${input.channelId}:${input.messageId}`;
  const existing = state.pendingMentions.find((entry) => entry.id === id);

  if (!existing) {
    state.pendingMentions.push({
      id,
      identityId: input.identityId,
      channelId: input.channelId,
      messageId: input.messageId,
      authorId: input.authorId,
      authorName: input.authorName,
      content: input.content,
      visiblePrompt: input.visiblePrompt,
      queuedAt: input.queuedAt ?? new Date().toISOString(),
    });
  }

  state.history.push({
    type: existing ? "pending_mention_duplicate" : "pending_mention_queued",
    identityId: input.identityId,
    channelId: input.channelId,
    messageId: input.messageId,
    queuedAt: input.queuedAt ?? new Date().toISOString(),
  });
  state.history = state.history.slice(-80);

  await writeHeartbeatQueueState(input.statePath, state);

  return {
    queued: !existing,
    pendingCount: state.pendingMentions.filter((entry) => entry.identityId === input.identityId).length,
  };
}

export function findRepoDiscordIdentityByTextAddress(
  registry: RepoDiscordIdentityRegistry,
  content: string,
  channelId: string,
): RepoDiscordIdentity | undefined {
  const trimmed = content.trimStart();
  void channelId;

  return registry.identities.find((identity) => {
    return textStartsWithIdentityAddress(trimmed, identity);
  });
}

export function findRepoDiscordIdentitiesByTextMentions(
  registry: RepoDiscordIdentityRegistry,
  content: string,
  channelId: string,
): RepoDiscordIdentity[] {
  void channelId;
  return registry.identities.filter((identity) => {
    return textContainsIdentityMention(content, identity);
  });
}

export function stripRepoIdentityTextAddress(
  content: string,
  identity: RepoDiscordIdentity,
): string {
  const trimmed = content.trimStart();
  const candidates = [identity.displayName, identity.id]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .sort((left, right) => right.length - left.length);

  for (const candidate of candidates) {
    const match = new RegExp(`^${escapeRegExp(candidate.trim())}(?:\\s*[,;:!?-]+|\\s+)`, "i").exec(trimmed);
    if (match) {
      return trimmed.slice(match[0].length).trim();
    }
  }

  return content.trim();
}

interface HeartbeatQueueState {
  schemaVersion: string;
  initiativeClock: number;
  baseRecoveryMinutes: number;
  globalHeat: number;
  lastTickAt?: string;
  participants: unknown[];
  history: Array<Record<string, unknown>>;
  pendingMentions: RepoFacePendingMention[];
}

async function readHeartbeatQueueState(path: string): Promise<HeartbeatQueueState> {
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(path, "utf8"))) as Partial<HeartbeatQueueState>;
    return {
      schemaVersion: typeof parsed.schemaVersion === "string"
        ? parsed.schemaVersion
        : REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
      initiativeClock: Number.isFinite(parsed.initiativeClock) ? parsed.initiativeClock as number : 0,
      baseRecoveryMinutes: Number.isFinite(parsed.baseRecoveryMinutes) ? parsed.baseRecoveryMinutes as number : 4,
      globalHeat: Number.isFinite(parsed.globalHeat) ? parsed.globalHeat as number : 1,
      lastTickAt: typeof parsed.lastTickAt === "string" ? parsed.lastTickAt : undefined,
      participants: Array.isArray(parsed.participants) ? parsed.participants : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      pendingMentions: Array.isArray(parsed.pendingMentions)
        ? parsed.pendingMentions.filter(isPendingMention)
        : [],
    };
  } catch {
    return {
      schemaVersion: REPO_FACE_HEARTBEAT_SCHEMA_VERSION,
      initiativeClock: 0,
      baseRecoveryMinutes: 4,
      globalHeat: 1,
      participants: [],
      history: [],
      pendingMentions: [],
    };
  }
}

async function writeHeartbeatQueueState(path: string, state: HeartbeatQueueState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function textStartsWithIdentityAddress(content: string, identity: RepoDiscordIdentity): boolean {
  return [identity.displayName, identity.id]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .some((candidate) => {
      const escaped = escapeRegExp(candidate.trim());
      return new RegExp(`^${escaped}(?:\\s*[,;:!?-]+|\\s+)`, "i").test(content);
    });
}

function textContainsIdentityMention(content: string, identity: RepoDiscordIdentity): boolean {
  return [identity.displayName, identity.id]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .some((candidate) => containsStandaloneToken(content, candidate));
}

function isPendingMention(value: unknown): value is RepoFacePendingMention {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsStandaloneToken(text: string, token: string): boolean {
  const escaped = escapeRegExp(token.trim());
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(text);
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
