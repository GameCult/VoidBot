import { z } from "zod";
import { loadPromptTemplate } from "@voidbot/shared";

import {
  type RepoDiscordIdentity,
  type RepoDiscordIdentityRegistry,
  getRepoDiscordIdentityAllowedChannelIds,
  resolveRepoFaceStatePath,
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

const faceIdentitySchema = z.object({
  id: z.string().trim().min(1),
  identityKind: z.enum(["repo_face", "native_persona"]).default("repo_face"),
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
  faceStatePath: z.string().trim().min(1).optional(),
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
  faces: z.array(faceIdentitySchema).default([]),
});

export const epiphanyIdentityRegistrySchema = z.object({
  epiphanies: z.array(epiphanyIdentitySchema).default([]),
});

export type AgencyGrant = z.infer<typeof agencyGrantSchema>;
export type EpiphanyJurisdiction = z.infer<typeof jurisdictionSchema>;
export type FaceIdentity = z.infer<typeof faceIdentitySchema>;
export type EpiphanyIdentity = z.infer<typeof epiphanyIdentitySchema>;

export interface ResolvedFaceIdentity extends FaceIdentity {
  epiphanyId: string;
  epiphanyDisplayName: string;
  epiphanyDescription?: string;
  inheritedJurisdictions: EpiphanyJurisdiction[];
}

export interface EpiphanyIdentityRegistry {
  epiphanies: EpiphanyIdentity[];
  faces: ResolvedFaceIdentity[];
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
    faces: normalizedEpiphanies.flatMap((epiphany) =>
      epiphany.faces.map((face) => ({
        ...face,
        epiphanyId: epiphany.id,
        epiphanyDisplayName: epiphany.displayName,
        epiphanyDescription: epiphany.description,
        inheritedJurisdictions: epiphany.jurisdictions,
      })),
    ),
  };
}

export function faceToRepoDiscordIdentity(face: ResolvedFaceIdentity): RepoDiscordIdentity {
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
    faceStatePath: face.faceStatePath,
    personaStatePath: face.personaStatePath,
    description: renderFaceDescription(face),
  };
}

export function renderFaceIdentityDoctrine(face: ResolvedFaceIdentity): string {
  const grants = face.grants.length > 0 ? face.grants.join(", ") : "discussion, rumination";
  const jurisdictions = [...face.inheritedJurisdictions, ...face.jurisdictions]
    .map(renderJurisdiction)
    .join("; ");

  return loadPromptTemplate("epiphany-face-identity-doctrine.prompt.md", {
    displayName: face.displayName,
    epiphanyDisplayName: face.epiphanyDisplayName,
    epiphanyId: face.epiphanyId,
    epiphanyDescription: face.epiphanyDescription,
    faceDescription: face.description,
    grants,
    jurisdictions,
  });
}

export function resolveFaceStatePath(face: ResolvedFaceIdentity, storageRoot: string): string {
  return resolveRepoFaceStatePath(faceToRepoDiscordIdentity(face), storageRoot);
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
    faces: [
      {
        id: identity.id,
        identityKind: identity.identityKind,
        displayName: identity.displayName,
        repoName: identity.repoName,
        repoPath: identity.repoPath,
        roleId: identity.roleId,
        allowedChannelIds: getRepoDiscordIdentityAllowedChannelIds(identity),
        channelPermissions: identity.channelPermissions,
        avatarUrl: identity.avatarUrl,
        avatarPath: identity.avatarPath,
        faceStatePath: identity.faceStatePath,
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
  const seenFaces = new Set<string>();

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
      faces: epiphany.faces.map((face) => {
        const faceId = normalizeKey(face.id);
        if (seenFaces.has(faceId)) {
          throw new Error(`Duplicate Face id "${face.id}".`);
        }

        seenFaces.add(faceId);
        return {
          ...face,
          id: face.id.trim(),
          identityKind: face.identityKind,
          displayName: face.displayName.trim().slice(0, 80),
          repoName: face.repoName?.trim(),
          repoPath: face.repoPath?.trim(),
          roleId: face.roleId?.trim(),
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
          faceStatePath: face.faceStatePath?.trim(),
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

function renderFaceDescription(face: ResolvedFaceIdentity): string | undefined {
  const parts = [
    face.description,
    `Face of ${face.epiphanyDisplayName}`,
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
