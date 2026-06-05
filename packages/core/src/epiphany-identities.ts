import { z } from "zod";
import { loadPromptTemplate } from "@voidbot/shared";

import {
  type RepoDiscordIdentity,
  type RepoDiscordIdentityRegistry,
  getRepoDiscordIdentityAllowedChannelIds,
  resolveRepoPersonaStatePath,
} from "./repo-discord-identities";

const agencyGrantSchema = z.enum([
  "discussion",
  "rumination",
  "publication",
  "repo_read",
  "repo_propose",
  "repo_write_with_consensus",
  "canon_stewardship",
  "canon_write_with_consensus",
  "bylined_essay",
  "discord_text",
  "discord_voice",
  "aquarium_embodiment",
]);

const jurisdictionSchema = z.object({
  kind: z.enum(["repo", "path", "lore", "discord_channel", "aquarium_space", "publication_lane"]),
  id: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  repoName: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  authority: z
    .enum(["observe", "discuss", "propose", "steward", "write_with_consensus", "publish_bylined"])
    .default("discuss"),
});

const personaIdentitySchema = z.object({
  id: z.string().trim().min(1),
  identityKind: z.enum(["repo_persona", "native_persona"]).default("repo_persona"),
  displayName: z.string().trim().min(1).max(80),
  repoName: z.string().trim().min(1).optional(),
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
  avatarPath: z.string().trim().min(1).optional(),
  personaStatePath: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  grants: z.array(agencyGrantSchema).default(["discussion", "rumination", "discord_text"]),
  jurisdictions: z.array(jurisdictionSchema).default([]),
});

const epiphanyIdentitySchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).optional(),
  repoNames: z.array(z.string().trim().min(1)).default([]),
  jurisdictions: z.array(jurisdictionSchema).default([]),
  personas: z.array(personaIdentitySchema).default([]),
});

export const epiphanyIdentityRegistrySchema = z.object({
  epiphanies: z.array(epiphanyIdentitySchema).default([]),
});

export type AgencyGrant = z.infer<typeof agencyGrantSchema>;
export type EpiphanyJurisdiction = z.infer<typeof jurisdictionSchema>;
export type PersonaIdentity = z.infer<typeof personaIdentitySchema>;
export type EpiphanyIdentity = z.infer<typeof epiphanyIdentitySchema>;

export interface ResolvedPersonaIdentity extends PersonaIdentity {
  epiphanyId: string;
  epiphanyDisplayName: string;
  epiphanyDescription?: string;
  inheritedJurisdictions: EpiphanyJurisdiction[];
}

export interface EpiphanyIdentityRegistry {
  epiphanies: EpiphanyIdentity[];
  personas: ResolvedPersonaIdentity[];
}

export function buildEpiphanyIdentityRegistry(
  repoRegistry: RepoDiscordIdentityRegistry,
): EpiphanyIdentityRegistry {
  const explicit = parseExplicitEpiphanies(repoRegistry);
  const epiphanies = explicit.length > 0
    ? explicit
    : repoRegistry.identities.map(repoIdentityToEpiphany);
  const normalizedEpiphanies = normalizeEpiphanies(epiphanies);

  return {
    epiphanies: normalizedEpiphanies,
    personas: normalizedEpiphanies.flatMap((epiphany) =>
      epiphany.personas.map((persona) => ({
        ...persona,
        epiphanyId: epiphany.id,
        epiphanyDisplayName: epiphany.displayName,
        epiphanyDescription: epiphany.description,
        inheritedJurisdictions: epiphany.jurisdictions,
      })),
    ),
  };
}

export function personaToRepoDiscordIdentity(face: ResolvedPersonaIdentity): RepoDiscordIdentity {
  const repoName = face.repoName
    ?? face.jurisdictions.find((jurisdiction) => jurisdiction.kind === "repo")?.repoName
    ?? face.jurisdictions.find((jurisdiction) => jurisdiction.kind === "repo")?.id
    ?? face.epiphanyId;

  return {
    id: face.id,
    identityKind: face.identityKind,
    repoName,
    displayName: face.displayName,
    repoPath: face.repoPath,
    roleId: face.roleId,
    allowedChannelIds: face.allowedChannelIds,
    channelPermissions: face.channelPermissions,
    avatarUrl: face.avatarUrl,
    avatarPath: face.avatarPath,
    personaStatePath: face.personaStatePath,
    description: renderPersonaDescription(face),
  };
}

export function renderPersonaIdentityDoctrine(face: ResolvedPersonaIdentity): string {
  const grants = face.grants.length > 0 ? face.grants.join(", ") : "discussion, rumination";
  const jurisdictions = [...face.inheritedJurisdictions, ...face.jurisdictions]
    .map(renderJurisdiction)
    .join("; ");

  return loadPromptTemplate("epiphany-persona-identity-doctrine.prompt.md", {
    displayName: face.displayName,
    epiphanyDisplayName: face.epiphanyDisplayName,
    epiphanyId: face.epiphanyId,
    epiphanyDescription: face.epiphanyDescription,
    faceDescription: face.description,
    grants,
    jurisdictions,
  });
}

export function resolvePersonaStatePath(face: ResolvedPersonaIdentity, storageRoot: string): string {
  return resolveRepoPersonaStatePath(personaToRepoDiscordIdentity(face), storageRoot);
}

function parseExplicitEpiphanies(
  repoRegistry: RepoDiscordIdentityRegistry,
): EpiphanyIdentity[] {
  const candidate = repoRegistry as RepoDiscordIdentityRegistry & { epiphanies?: unknown };
  if (!candidate.epiphanies) {
    return [];
  }

  return epiphanyIdentityRegistrySchema.parse({ epiphanies: candidate.epiphanies }).epiphanies;
}

function repoIdentityToEpiphany(identity: RepoDiscordIdentity): EpiphanyIdentity {
  const repoJurisdiction: EpiphanyJurisdiction = {
    kind: "repo",
    id: identity.repoName,
    repoName: identity.repoName,
    path: identity.repoPath,
    authority: "propose",
  };

  return {
    id: identity.repoName,
    displayName: identity.repoName,
    repoNames: [identity.repoName],
    jurisdictions: [repoJurisdiction],
    personas: [
      {
        id: identity.id,
        displayName: identity.displayName,
        repoName: identity.repoName,
        repoPath: identity.repoPath,
        roleId: identity.roleId,
        identityKind: identity.identityKind,
        allowedChannelIds: getRepoDiscordIdentityAllowedChannelIds(identity),
        channelPermissions: identity.channelPermissions,
        avatarUrl: identity.avatarUrl,
        avatarPath: identity.avatarPath,
        personaStatePath: identity.personaStatePath,
        description: identity.description,
        grants: [
          "discussion",
          "rumination",
          "repo_read",
          "repo_propose",
          "discord_text",
          "aquarium_embodiment",
        ],
        jurisdictions: [],
      },
    ],
  };
}

function normalizeEpiphanies(epiphanies: EpiphanyIdentity[]): EpiphanyIdentity[] {
  const seenEpiphanies = new Set<string>();
  const seenPersonas = new Set<string>();

  return epiphanies.map((epiphany) => {
    const epiphanyId = normalizeKey(epiphany.id);
    if (seenEpiphanies.has(epiphanyId)) {
      throw new Error(`Duplicate Epiphany id "${epiphany.id}".`);
    }

    seenEpiphanies.add(epiphanyId);
    return {
      ...epiphany,
      id: epiphany.id.trim(),
      displayName: epiphany.displayName.trim().slice(0, 80),
      description: epiphany.description?.trim(),
      repoNames: [...new Set(epiphany.repoNames.map((repoName) => repoName.trim()))],
      jurisdictions: epiphany.jurisdictions.map(normalizeJurisdiction),
      personas: epiphany.personas.map((face) => {
        const faceId = normalizeKey(face.id);
        if (seenPersonas.has(faceId)) {
          throw new Error(`Duplicate Persona id "${face.id}".`);
        }

        seenPersonas.add(faceId);
        return {
          ...face,
          id: face.id.trim(),
          displayName: face.displayName.trim().slice(0, 80),
          repoName: face.repoName?.trim(),
          repoPath: face.repoPath?.trim(),
          roleId: face.roleId?.trim(),
          identityKind: face.identityKind,
          allowedChannelIds: [...new Set(face.allowedChannelIds.map((entry) => entry.trim()))],
          channelPermissions: face.channelPermissions.map((permission) => ({
            ...permission,
            channelId: permission.channelId.trim(),
            label: permission.label?.trim(),
            topic: permission.topic?.trim(),
            posture: permission.posture?.trim(),
          })),
          avatarUrl: face.avatarUrl?.trim(),
          avatarPath: face.avatarPath?.trim(),
          personaStatePath: face.personaStatePath?.trim(),
          description: face.description?.trim(),
          grants: [...new Set(face.grants)],
          jurisdictions: face.jurisdictions.map(normalizeJurisdiction),
        };
      }),
    };
  });
}

function normalizeJurisdiction(jurisdiction: EpiphanyJurisdiction): EpiphanyJurisdiction {
  return {
    ...jurisdiction,
    id: jurisdiction.id.trim(),
    label: jurisdiction.label?.trim(),
    repoName: jurisdiction.repoName?.trim(),
    path: jurisdiction.path?.trim(),
  };
}

function renderPersonaDescription(face: ResolvedPersonaIdentity): string | undefined {
  const parts = [
    face.description,
    `Persona of ${face.epiphanyDisplayName}`,
    `grants: ${face.grants.join(", ")}`,
    [...face.inheritedJurisdictions, ...face.jurisdictions].length > 0
      ? `jurisdictions: ${[...face.inheritedJurisdictions, ...face.jurisdictions].map(renderJurisdiction).join("; ")}`
      : undefined,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);

  return parts.join(" | ");
}

function renderJurisdiction(jurisdiction: EpiphanyJurisdiction): string {
  const label = jurisdiction.label ? `${jurisdiction.label} ` : "";
  const repo = jurisdiction.repoName ? ` repo=${jurisdiction.repoName}` : "";
  const path = jurisdiction.path ? ` path=${jurisdiction.path}` : "";
  return `${label}${jurisdiction.kind}:${jurisdiction.id} (${jurisdiction.authority})${repo}${path}`;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}
