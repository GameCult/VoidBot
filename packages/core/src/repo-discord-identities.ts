import { readFile } from "node:fs/promises";

import { z } from "zod";

const repoDiscordIdentitySchema = z.object({
  id: z.string().trim().min(1),
  repoName: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(80),
  roleId: z.string().trim().min(1).optional(),
  allowedChannelIds: z.array(z.string().trim().min(1)).default([]),
  avatarUrl: z.string().trim().url().max(512).optional(),
  description: z.string().trim().min(1).optional(),
});

const repoDiscordIdentityRegistrySchema = z.object({
  identities: z.array(repoDiscordIdentitySchema).default([]),
});

export type RepoDiscordIdentity = z.infer<typeof repoDiscordIdentitySchema>;

export interface RepoDiscordIdentityRegistry {
  identities: RepoDiscordIdentity[];
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

  return registry.identities.find((identity) => {
    return (
      identity.roleId &&
      mentionedRoles.has(identity.roleId) &&
      isRepoDiscordIdentityAllowedInChannel(identity, channelId)
    );
  });
}

export function isRepoDiscordIdentityAllowedInChannel(
  identity: RepoDiscordIdentity,
  channelId: string,
): boolean {
  return identity.allowedChannelIds.length === 0 || identity.allowedChannelIds.includes(channelId);
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
      roleId: identity.roleId?.trim(),
      allowedChannelIds: [...new Set(identity.allowedChannelIds.map((entry) => entry.trim()))],
      avatarUrl: identity.avatarUrl?.trim(),
      description: identity.description?.trim(),
    };
  });
}

function normalizeIdentityKey(value: string): string {
  return value.trim().toLowerCase();
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
