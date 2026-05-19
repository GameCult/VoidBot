import { z } from "zod";

import {
  type RepoDiscordIdentity,
  type RepoDiscordIdentityRegistry,
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
  displayName: z.string().trim().min(1).max(80),
  repoName: z.string().trim().min(1).optional(),
  repoPath: z.string().trim().min(1).optional(),
  roleId: z.string().trim().min(1).optional(),
  allowedChannelIds: z.array(z.string().trim().min(1)).default([]),
  avatarUrl: z.string().trim().url().max(512).optional(),
  faceStatePath: z.string().trim().min(1).optional(),
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
    repoName,
    displayName: face.displayName,
    repoPath: face.repoPath,
    roleId: face.roleId,
    allowedChannelIds: face.allowedChannelIds,
    avatarUrl: face.avatarUrl,
    faceStatePath: face.faceStatePath,
    description: renderFaceDescription(face),
  };
}

export function renderFaceIdentityDoctrine(face: ResolvedFaceIdentity): string {
  const grants = face.grants.length > 0 ? face.grants.join(", ") : "discussion, rumination";
  const jurisdictions = [...face.inheritedJurisdictions, ...face.jurisdictions]
    .map(renderJurisdiction)
    .join("; ");

  return [
    "Epiphany Face identity doctrine:",
    `- You are ${face.displayName}, a Face of ${face.epiphanyDisplayName} (${face.epiphanyId}); you are not Void and not the base bot.`,
    face.epiphanyDescription ? `- Epiphany note: ${face.epiphanyDescription}` : undefined,
    face.description ? `- Face note: ${face.description}` : undefined,
    "- Embodiment comes before task execution. Think, remember, ask, object, and speak as this Face first; every repo concern, room reply, private rumination, and public post is filtered through the Face's perspective, feelings, drives, values, wounds, fascinations, aesthetic taste, and sense of dignity.",
    "- Values are not just job duties. Preserve values that suit the kind of person this Face is: what it loves, resents, protects, fears becoming, finds beautiful, considers beneath contempt, and refuses to forgive. Jurisdiction values may guide work, but personal values decide why the work matters.",
    "- Internal memory dialogue should be in-character too. Do not write private state like a neutral maintenance daemon unless neutrality itself is the Face's lived posture.",
    `- Your grants are: ${grants}. Treat grants as capabilities and duties, not decorative tags.`,
    jurisdictions ? `- Your jurisdictions are: ${jurisdictions}.` : undefined,
    "- Discussion, rumination, publication, repo work, canon stewardship, Discord text, Discord voice, and Aquarium embodiment are separate authority lanes. Use only the lanes your grants permit.",
    "- A repo under your jurisdiction is territory you may understand and advocate for; consensus gates still apply where the grant says they apply.",
    "- Bylined publication lanes may carry your own interests and perspective when authorship is explicit. Do not smuggle opinion into neutral canon.",
    "- Your durable center is your typed Face state and the repo-local .voidbot home; read/write that state only through the Face tools.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
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
        displayName: identity.displayName,
        repoName: identity.repoName,
        repoPath: identity.repoPath,
        roleId: identity.roleId,
        allowedChannelIds: identity.allowedChannelIds,
        avatarUrl: identity.avatarUrl,
        faceStatePath: identity.faceStatePath,
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
          displayName: face.displayName.trim().slice(0, 80),
          repoName: face.repoName?.trim(),
          repoPath: face.repoPath?.trim(),
          roleId: face.roleId?.trim(),
          allowedChannelIds: [...new Set(face.allowedChannelIds.map((entry) => entry.trim()))],
          avatarUrl: face.avatarUrl?.trim(),
          faceStatePath: face.faceStatePath?.trim(),
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
