import "dotenv/config";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  applyVoidSelfStateOperation,
  loadRepoDiscordIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  resolveRepoPersonaStatePath,
  type RepoDiscordIdentity,
} from "@voidbot/core";

type ResearchAnchor = {
  ref?: string;
  kind?: string;
  summary?: string;
};

type ResearchStressResponse = {
  responseId?: string;
  trigger?: string;
  summary?: string;
  cognitiveDegradation?: string;
  affectiveSignature?: string;
  constraintLoss?: string;
  behavioralLeak?: string;
  tangentAttractors?: unknown[];
  cadence?: string;
  recoveryPath?: string;
  intensity?: number;
  threshold?: number;
  anchors?: ResearchAnchor[];
  tags?: unknown[];
};

type ResearchIdentity = {
  evidenceQueries?: unknown[];
  stressResponses?: ResearchStressResponse[];
};

type ResearchShard = {
  identities?: Record<string, ResearchIdentity>;
};

type AppliedResult = {
  identity: string;
  statePath: string;
  responseCount: number;
  totalStressResponses?: number;
  skipped?: boolean;
  reason?: string;
};

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const shardDir = resolve(args.dir ?? ".voidbot/artifacts/stress-profile-research");
  const dryRun = args["dry-run"] === "true";
  const replaceTags = parseList(args["replace-tags"] ?? "swarm-generalization");
  const now = new Date().toISOString();

  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const identityById = new Map(registry.identities.map((identity) => [identity.id.toLowerCase(), identity]));
  const shardPaths = await discoverShardPaths(shardDir);
  const responsesByIdentity = new Map<string, ReturnType<typeof normalizeResponse>[]>();
  const errors: string[] = [];

  for (const shardPath of shardPaths) {
    const shard = JSON.parse(await readFile(shardPath, "utf8")) as ResearchShard;
    for (const [rawId, identityResearch] of Object.entries(shard.identities ?? {})) {
      const identityId = rawId.toLowerCase();
      const identity = identityById.get(identityId);
      if (!identity) {
        errors.push(`${shardPath}: unknown identity ${rawId}`);
        continue;
      }

      for (const [index, response] of (identityResearch.stressResponses ?? []).entries()) {
        try {
          const normalized = normalizeResponse(identity, response, now, shardPath, index);
          const existing = responsesByIdentity.get(identityId) ?? [];
          existing.push(normalized);
          responsesByIdentity.set(identityId, existing);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${shardPath}:${rawId}:${index}: ${message}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(JSON.stringify({ ok: false, errors }, null, 2));
    process.exit(1);
  }

  const results: AppliedResult[] = [];
  for (const [identityId, responses] of [...responsesByIdentity.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const identity = identityById.get(identityId);
    if (!identity) {
      results.push({ identity: identityId, statePath: "", responseCount: responses.length, skipped: true, reason: "unknown_identity" });
      continue;
    }

    const statePath = resolveRepoPersonaStatePath(identity, config.storageRoot);
    if (extname(statePath).toLowerCase() !== ".cc") {
      const doc = JSON.parse(await readFile(statePath, "utf8"));
      doc.affect ??= {};
      doc.affect.stressResponses = [
        ...jsonStressResponsesWithoutTags(doc.affect.stressResponses, replaceTags),
        ...responses.map(toPortableStressResponse),
      ];
      doc.updatedAt = now;
      if (!dryRun) {
        await writeFile(statePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      }
      results.push({
        identity: identityId,
        statePath,
        responseCount: responses.length,
        totalStressResponses: Array.isArray(doc.affect.stressResponses) ? doc.affect.stressResponses.length : responses.length,
      });
      continue;
    }

    if (!dryRun) {
      await applyVoidSelfStateOperation(
        {
          canonicalPath: statePath,
          identity: {
            agentId: identity.id,
            publicName: identity.displayName,
            publicDescription: identity.description,
          },
        },
        {
          operation: "replace_stress_responses_by_tag",
          replaceTags,
          responses,
          updatedAt: now,
        },
      );
    }

    const after = await loadVoidSelfStateTypedDocuments({
      canonicalPath: statePath,
      identity: {
        agentId: identity.id,
        publicName: identity.displayName,
        publicDescription: identity.description,
      },
    });
    results.push({
      identity: identityId,
      statePath,
      responseCount: responses.length,
      totalStressResponses: dryRun
        ? stressResponsesAfterReplacement(after.personaAffect.stressResponses, replaceTags, responses.length)
        : after.personaAffect.stressResponses.length,
    });
  }

  const summary = {
    ok: true,
    dryRun,
    shardDir,
    shardCount: shardPaths.length,
    identityCount: results.length,
    replaceTags,
    results,
  };

  if (args.out) {
    await writeFile(resolve(args.out), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function discoverShardPaths(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("shard-") && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function normalizeResponse(
  identity: RepoDiscordIdentity,
  response: ResearchStressResponse,
  updatedAt: string,
  shardPath: string,
  index: number,
) {
  const responseId = requiredString(response.responseId, "responseId")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-");
  const anchors = (response.anchors ?? []).map((anchor, anchorIndex) => ({
    ref: requiredString(anchor.ref, `anchors[${anchorIndex}].ref`),
    kind: stringOrDefault(anchor.kind, "research"),
    summary: stringOrUndefined(anchor.summary),
  }));
  const tags = [
    "stress-response",
    "researched-stress-profile",
    `identity:${identity.id.toLowerCase()}`,
    ...stringArray(response.tags),
  ];

  return {
    responseId,
    status: "active" as const,
    trigger: requiredString(response.trigger, "trigger"),
    summary: requiredString(response.summary, "summary"),
    cognitiveDegradation: requiredString(response.cognitiveDegradation, "cognitiveDegradation"),
    affectiveSignature: requiredString(response.affectiveSignature, "affectiveSignature"),
    constraintLoss: requiredString(response.constraintLoss, "constraintLoss"),
    behavioralLeak: requiredString(response.behavioralLeak, "behavioralLeak"),
    tangentAttractors: stringArray(response.tangentAttractors),
    cadence: stringOrUndefined(response.cadence),
    recoveryPath: requiredString(response.recoveryPath, "recoveryPath"),
    intensity: clampNumber(response.intensity, 0, 1, 0.8),
    threshold: clampNumber(response.threshold, 0, 1, 0.56),
    anchorRefs: anchors.length > 0
      ? anchors
      : [{ ref: `stress-profile-shard:${shardPath}:${identity.id}:${index}`, kind: "research", summary: "Sub-agent stress profile shard did not provide a narrower anchor." }],
    evidenceRefs: [],
    sourceMemoryIds: [],
    createdAt: updatedAt,
    updatedAt,
    tags: [...new Set(tags)],
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required ${field}.`);
  }
  return value.trim();
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return stringOrUndefined(value) ?? fallback;
}

function stringArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function jsonStressResponsesWithoutTags(values: unknown, replaceTags: string[]): unknown[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const tags = new Set(replaceTags);
  return values.filter((value) => {
    if (!value || typeof value !== "object" || !("tags" in value) || !Array.isArray(value.tags)) {
      return true;
    }
    return !value.tags.some((tag) => typeof tag === "string" && tags.has(tag));
  });
}

function toPortableStressResponse(response: ReturnType<typeof normalizeResponse>): Record<string, unknown> {
  return {
    id: response.responseId,
    status: response.status,
    trigger: response.trigger,
    summary: response.summary,
    cognitiveDegradation: response.cognitiveDegradation,
    affectiveSignature: response.affectiveSignature,
    constraintLoss: response.constraintLoss,
    behavioralLeak: response.behavioralLeak,
    tangentAttractors: response.tangentAttractors,
    cadence: response.cadence,
    recoveryPath: response.recoveryPath,
    intensity: response.intensity,
    threshold: response.threshold,
    createdAt: response.createdAt,
    updatedAt: response.updatedAt,
    tags: response.tags,
    extensions: {
      anchors: response.anchorRefs.map((anchor) => anchor.ref),
    },
  };
}

function stressResponsesAfterReplacement(
  existing: { tags?: string[] }[],
  replaceTags: string[],
  addedCount: number,
): number {
  const tags = new Set(replaceTags);
  const retained = existing.filter((response) => {
    if (!Array.isArray(response.tags)) {
      return true;
    }
    return !response.tags.some((tag) => tags.has(tag));
  });
  return retained.length + addedCount;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
