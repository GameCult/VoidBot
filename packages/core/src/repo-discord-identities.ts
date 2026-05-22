import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { z } from "zod";

const repoDiscordIdentitySchema = z.object({
  id: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(80),
  repoPath: z.string().trim().min(1).optional(),
  roleId: z.string().trim().min(1).optional(),
  allowedChannelIds: z.array(z.string().trim().min(1)).default([]),
  channelPermissions: z.array(z.object({
    channelId: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    topic: z.string().trim().min(1).optional(),
    speechThreshold: z.enum(["very_low", "low", "medium", "high"]).default("medium"),
    speedMultiplier: z.number().positive().default(1),
    posture: z.string().trim().min(1).optional(),
  })).default([]),
  avatarUrl: z.string().trim().url().max(512).optional(),
  faceStatePath: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
});

const repoDiscordIdentityRegistrySchema = z.object({
  identities: z.array(repoDiscordIdentitySchema).default([]),
});

export type RepoDiscordIdentity = z.infer<typeof repoDiscordIdentitySchema>;

export interface RepoDiscordIdentityRegistry {
  identities: RepoDiscordIdentity[];
  epiphanies?: unknown;
}

export interface RepoDiscordIdentityJurisdictionMention {
  identityId: string;
  repoName: string;
  matched: string;
}

export async function loadRepoDiscordIdentityRegistry(
  path: string,
): Promise<RepoDiscordIdentityRegistry> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { identities: [] };
    }

    throw error;
  }

  const parsed = JSON.parse(stripLeadingBom(raw)) as unknown;
  const registry = Array.isArray(parsed)
    ? repoDiscordIdentityRegistrySchema.parse({ identities: parsed })
    : repoDiscordIdentityRegistrySchema.parse(parsed);

  return {
    identities: normalizeRepoDiscordIdentities(registry.identities),
    epiphanies: isRecord(parsed) ? parsed.epiphanies : undefined,
  };
}

export function findRepoDiscordIdentity(
  registry: RepoDiscordIdentityRegistry,
  selector: string,
): RepoDiscordIdentity | undefined {
  const normalizedSelector = normalizeIdentityKey(selector);

  return registry.identities.find((identity) => {
    return [
      identity.id,
      identity.repoName,
      identity.displayName,
      identity.roleId,
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => normalizeIdentityKey(value) === normalizedSelector);
  });
}

export function findRepoDiscordIdentityByRoleIds(
  registry: RepoDiscordIdentityRegistry,
  roleIds: Iterable<string>,
  channelId: string,
): RepoDiscordIdentity | undefined {
  const mentionedRoles = new Set(roleIds);
  void channelId;

  return registry.identities.find((identity) => {
    return identity.roleId && mentionedRoles.has(identity.roleId);
  });
}

export function findRepoDiscordIdentityByPersonaName(
  registry: RepoDiscordIdentityRegistry,
  personaName: string | undefined,
  channelId: string,
): RepoDiscordIdentity | undefined {
  if (!personaName || personaName.trim().length === 0) {
    return undefined;
  }

  const normalizedPersonaName = normalizeIdentityKey(personaName);

  return registry.identities.find((identity) => {
    return (
      isRepoDiscordIdentityAllowedInChannel(identity, channelId) &&
      normalizeIdentityKey(identity.displayName) === normalizedPersonaName
    );
  });
}

export function isRepoDiscordIdentityAllowedInChannel(
  identity: RepoDiscordIdentity,
  channelId: string,
): boolean {
  const allowed = identity.allowedChannelIds.includes(channelId) ||
    identity.channelPermissions.some((permission) => permission.channelId === channelId);
  return identity.allowedChannelIds.length === 0 && identity.channelPermissions.length === 0
    ? true
    : allowed;
}

export function getRepoDiscordIdentityAllowedChannelIds(identity: RepoDiscordIdentity): string[] {
  return [
    ...new Set([
      ...identity.allowedChannelIds,
      ...identity.channelPermissions.map((permission) => permission.channelId),
    ]),
  ];
}

export function resolveRepoFaceStatePath(
  identity: RepoDiscordIdentity,
  storageRoot: string,
): string {
  if (identity.faceStatePath) {
    return resolve(identity.faceStatePath);
  }

  return resolve(storageRoot, "private", "repo-faces", `${sanitizePathSegment(identity.id)}.cc`);
}

export function findCrossRepoJurisdictionMentions(
  identity: RepoDiscordIdentity,
  registry: RepoDiscordIdentityRegistry,
  text: string,
): RepoDiscordIdentityJurisdictionMention[] {
  const matches: RepoDiscordIdentityJurisdictionMention[] = [];
  const seen = new Set<string>();

  for (const candidate of registry.identities) {
    if (normalizeIdentityKey(candidate.id) === normalizeIdentityKey(identity.id)) {
      continue;
    }

    for (const token of repoJurisdictionTokens(candidate)) {
      if (!containsStandaloneToken(text, token)) {
        continue;
      }

      const key = `${candidate.id}:${normalizeIdentityKey(token)}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      matches.push({
        identityId: candidate.id,
        repoName: candidate.repoName,
        matched: token,
      });
    }
  }

  return matches;
}

function normalizeRepoDiscordIdentities(
  identities: RepoDiscordIdentity[],
): RepoDiscordIdentity[] {
  const seen = new Set<string>();

  return identities.map((identity) => {
    const normalizedId = normalizeIdentityKey(identity.id);

    if (seen.has(normalizedId)) {
      throw new Error(`Duplicate repo Discord identity id "${identity.id}".`);
    }

    seen.add(normalizedId);

    return {
      ...identity,
      id: identity.id.trim(),
      repoName: identity.repoName.trim(),
      displayName: identity.displayName.trim().slice(0, 80),
      repoPath: identity.repoPath?.trim(),
      roleId: identity.roleId?.trim(),
      allowedChannelIds: [...new Set(identity.allowedChannelIds.map((entry) => entry.trim()))],
      channelPermissions: normalizeChannelPermissions(identity.channelPermissions),
      avatarUrl: identity.avatarUrl?.trim(),
      faceStatePath: identity.faceStatePath?.trim(),
      description: identity.description?.trim(),
    };
  });
}

function normalizeChannelPermissions(
  permissions: RepoDiscordIdentity["channelPermissions"],
): RepoDiscordIdentity["channelPermissions"] {
  const seen = new Set<string>();
  const normalized: RepoDiscordIdentity["channelPermissions"] = [];

  for (const permission of permissions) {
    const channelId = permission.channelId.trim();
    const key = `${channelId}:${permission.topic?.trim().toLowerCase() ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      channelId,
      label: permission.label?.trim(),
      topic: permission.topic?.trim(),
      speechThreshold: permission.speechThreshold,
      speedMultiplier: permission.speedMultiplier,
      posture: permission.posture?.trim(),
    });
  }

  return normalized;
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "repo-face";
}

function normalizeIdentityKey(value: string): string {
  return value.trim().toLowerCase();
}

function repoJurisdictionTokens(identity: RepoDiscordIdentity): string[] {
  const tokens = [identity.repoName];
  if (identity.repoPath) {
    tokens.push(basename(identity.repoPath));
  }

  return [...new Set(tokens.map((token) => token.trim()).filter((token) => token.length > 0))];
}

function containsStandaloneToken(text: string, token: string): boolean {
  const escaped = escapeRegExp(token);
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
