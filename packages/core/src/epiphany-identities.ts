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

export function personaToRepoDiscordIdentity(persona: ResolvedPersonaIdentity): RepoDiscordIdentity {
  const repoName = persona.repoName
    ?? persona.jurisdictions.find((jurisdiction) => jurisdiction.kind === "repo")?.repoName
    ?? persona.jurisdictions.find((jurisdiction) => jurisdiction.kind === "repo")?.id
    ?? persona.epiphanyId;

  return {
    id: persona.id,
    identityKind: persona.identityKind,
    repoName,
    displayName: persona.displayName,
    repoPath: persona.repoPath,
    roleId: persona.roleId,
    allowedChannelIds: persona.allowedChannelIds,
    channelPermissions: persona.channelPermissions,
    avatarUrl: persona.avatarUrl,
    avatarPath: persona.avatarPath,
    personaStatePath: persona.personaStatePath,
    description: renderPersonaDescription(persona),
  };
}

export function renderPersonaIdentityDoctrine(persona: ResolvedPersonaIdentity): string {
  const grants = persona.grants.length > 0 ? persona.grants.join(", ") : "discussion, rumination";
  const jurisdictions = [...persona.inheritedJurisdictions, ...persona.jurisdictions]
    .map(renderJurisdiction)
    .join("; ");

  return loadPromptTemplate("epiphany-persona-identity-doctrine.prompt.md", {
    displayName: persona.displayName,
    epiphanyDisplayName: persona.epiphanyDisplayName,
    epiphanyId: persona.epiphanyId,
    epiphanyDescription: persona.epiphanyDescription,
    personaDescription: persona.description,
    grants,
    jurisdictions,
  });
}

export function resolvePersonaStatePath(persona: ResolvedPersonaIdentity, storageRoot: string): string {
  return resolveRepoPersonaStatePath(personaToRepoDiscordIdentity(persona), storageRoot);
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
      personas: epiphany.personas.map((persona) => {
        const personaId = normalizeKey(persona.id);
        if (seenPersonas.has(personaId)) {
          throw new Error(`Duplicate Persona id "${persona.id}".`);
        }

        seenPersonas.add(personaId);
        return {
          ...persona,
          id: persona.id.trim(),
          displayName: persona.displayName.trim().slice(0, 80),
          repoName: persona.repoName?.trim(),
          repoPath: persona.repoPath?.trim(),
          roleId: persona.roleId?.trim(),
          identityKind: persona.identityKind,
          allowedChannelIds: [...new Set(persona.allowedChannelIds.map((entry) => entry.trim()))],
          channelPermissions: persona.channelPermissions.map((permission) => ({
            ...permission,
            channelId: permission.channelId.trim(),
            label: permission.label?.trim(),
            topic: permission.topic?.trim(),
            posture: permission.posture?.trim(),
          })),
          avatarUrl: persona.avatarUrl?.trim(),
          avatarPath: persona.avatarPath?.trim(),
          personaStatePath: persona.personaStatePath?.trim(),
          description: persona.description?.trim(),
          grants: [...new Set(persona.grants)],
          jurisdictions: persona.jurisdictions.map(normalizeJurisdiction),
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

function renderPersonaDescription(persona: ResolvedPersonaIdentity): string | undefined {
  const parts = [
    persona.description,
    `Persona of ${persona.epiphanyDisplayName}`,
    `grants: ${persona.grants.join(", ")}`,
    [...persona.inheritedJurisdictions, ...persona.jurisdictions].length > 0
      ? `jurisdictions: ${[...persona.inheritedJurisdictions, ...persona.jurisdictions].map(renderJurisdiction).join("; ")}`
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
