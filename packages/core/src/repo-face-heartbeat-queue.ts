import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentType,
} from "cultcache-ts";
import { z } from "zod";

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

const pendingMentionSchema = z.object({
  id: z.string().trim().min(1),
  identityId: z.string().trim().min(1),
  channelId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  authorId: z.string().trim().min(1),
  authorName: z.string().nullish().transform((value) => value ?? undefined),
  content: z.string(),
  visiblePrompt: z.string(),
  queuedAt: z.string().trim().min(1),
}).strict();

const pendingMentionDefinition = defineDocumentType({
  type: "voidbot.persona_attention_command",
  schema: pendingMentionSchema,
  name: "id",
});

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
  const id = `${input.identityId}:${input.channelId}:${input.messageId}`;
  const command = pendingMentionSchema.parse({
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
  const inboxDirectory = resolveRepoFaceMentionInboxDirectory(input.statePath);
  await mkdir(inboxDirectory, { recursive: true });
  const commandPath = resolve(inboxDirectory, mentionFileName(command));
  const existing = await readMentionDocument(commandPath);
  if (!existing) {
    const cache = mentionCache(commandPath);
    await cache.put(pendingMentionDefinition, command.id, command);
  }
  const pendingCount = (await readRepoFaceMentionInbox(input.statePath))
    .filter((entry) => entry.identityId === input.identityId).length;

  return {
    queued: !existing,
    pendingCount,
  };
}

export function resolveRepoFaceMentionInboxDirectory(statePath: string): string {
  return `${resolveRepoFaceHeartbeatStatePath(statePath)}.mentions`;
}

export function resolveRepoFaceHeartbeatStatePath(statePath: string): string {
  const resolved = resolve(statePath);
  if (resolved.toLowerCase().endsWith(".cc")) return resolved;
  if (resolved.toLowerCase().endsWith(".json")) return `${resolved.slice(0, -5)}.cc`;
  return `${resolved}.cc`;
}

export function resolveRepoFaceHeartbeatDebugProjectionPath(statePath: string): string {
  const canonical = resolveRepoFaceHeartbeatStatePath(statePath);
  return `${canonical.slice(0, -3)}.json`;
}

export async function readRepoFaceMentionInbox(statePath: string): Promise<RepoFacePendingMention[]> {
  const directory = resolveRepoFaceMentionInboxDirectory(statePath);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const mentions = await Promise.all(
    names.filter((name) => name.endsWith(".cc")).map((name) => readMentionDocument(resolve(directory, name))),
  );
  return mentions.filter((mention): mention is RepoFacePendingMention => Boolean(mention))
    .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export async function acknowledgeRepoFaceMentionInbox(statePath: string, mentionIds: Iterable<string>): Promise<void> {
  const directory = resolveRepoFaceMentionInboxDirectory(statePath);
  const ids = new Set(mentionIds);
  if (ids.size === 0) return;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  await Promise.all(names.filter((name) => name.endsWith(".cc")).map(async (name) => {
    const path = resolve(directory, name);
    const mention = await readMentionDocument(path);
    if (mention && ids.has(mention.id)) await rm(path, { force: true });
  }));
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

function mentionCache(path: string): CultCache {
  return CultCache.builder()
    .withDocumentType(pendingMentionDefinition)
    .withGenericStore(new SingleFileMessagePackBackingStore(path))
    .build();
}

async function readMentionDocument(path: string): Promise<RepoFacePendingMention | undefined> {
  const cache = mentionCache(path);
  try {
    await cache.pullAllBackingStores();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  return cache.getAll(pendingMentionDefinition)[0];
}

function mentionFileName(mention: RepoFacePendingMention): string {
  const identity = mention.identityId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "persona";
  const digest = createHash("sha256").update(mention.id).digest("hex").slice(0, 20);
  return `${identity}--${digest}.cc`;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsStandaloneToken(text: string, token: string): boolean {
  const escaped = escapeRegExp(token.trim());
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(text);
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
