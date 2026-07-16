import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CultCache, SingleFileMessagePackBackingStore } from "cultcache-ts";

import { gamecultPersonaStateDocument, gamecultPersonaStateDocumentRegistry, gamecultPersonaStateSchema, type GamecultPersonaState } from "./persona-state-domain";

export async function loadGamecultPersonaState(canonicalPath: string): Promise<GamecultPersonaState> {
  const cache = createCache(resolve(canonicalPath));
  await cache.pullAllBackingStores();
  const state = cache.getGlobal(gamecultPersonaStateDocument);
  if (!state) throw new Error(`CultCache Persona state is missing gamecult.persona_state.v0: ${resolve(canonicalPath)}`);
  return state;
}

export async function inspectPersonaStateSurfaceKind(canonicalPath: string): Promise<"gamecult_persona" | "void_self_state" | "unknown"> {
  const envelopes = await new SingleFileMessagePackBackingStore(resolve(canonicalPath)).pullAll();
  const types = new Set(envelopes.map((entry) => entry.type));
  if (types.has(gamecultPersonaStateDocument.type)) return "gamecult_persona";
  if ([...types].some((type) => type.startsWith("void."))) return "void_self_state";
  return "unknown";
}

export async function migrateCanonicalPortablePersonaState(input: { sourcePath: string; targetPath: string }): Promise<{ sourcePath: string; targetPath: string; personaId: string }> {
  const sourcePath = resolve(input.sourcePath);
  const targetPath = resolve(input.targetPath);
  const state = await readCanonicalPortablePersonaState(sourcePath);
  try {
    await access(targetPath);
    throw new Error(`Refusing to overwrite existing Persona state target: ${targetPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const cache = createCache(targetPath);
  await cache.putGlobal(gamecultPersonaStateDocument, state);
  const verified = await loadGamecultPersonaState(targetPath);
  if (verified.personaId !== state.personaId || verified.updatedAt !== state.updatedAt) throw new Error(`Persona state verification failed after writing ${targetPath}`);
  return { sourcePath, targetPath, personaId: state.personaId };
}

export async function readCanonicalPortablePersonaState(sourcePathInput: string): Promise<GamecultPersonaState> {
  const sourcePath = resolve(sourcePathInput);
  const raw = JSON.parse(stripBom(await readFile(sourcePath, "utf8"))) as unknown;
  const claimedAuthority = readClaimedAuthority(raw);
  if (claimedAuthority !== "canonical") throw new Error(`Refusing to promote ${claimedAuthority ?? "unclaimed"} Persona state; only canonical portable state may migrate.`);
  return gamecultPersonaStateSchema.parse(normalizeLegacyPortableState(raw));
}

function normalizeLegacyPortableState(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const root = structuredClone(raw) as Record<string, unknown>;
  const affect = root.affect;
  const thoughtMemory = root.thoughtMemory;
  if (!affect || typeof affect !== "object" || Array.isArray(affect) || !("stressResponses" in affect)) return root;
  if (!thoughtMemory || typeof thoughtMemory !== "object" || Array.isArray(thoughtMemory)) return root;
  const legacy = (affect as Record<string, unknown>).stressResponses;
  if (!Array.isArray(legacy)) return root;
  const memories = Array.isArray((thoughtMemory as Record<string, unknown>).memories)
    ? (thoughtMemory as Record<string, unknown>).memories as unknown[]
    : [];
  for (const entry of legacy) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const stress = entry as Record<string, unknown>;
    const id = typeof stress.id === "string" ? stress.id : undefined;
    const summary = typeof stress.summary === "string" ? stress.summary : undefined;
    const createdAt = typeof stress.createdAt === "string" ? stress.createdAt : undefined;
    const updatedAt = typeof stress.updatedAt === "string" ? stress.updatedAt : createdAt;
    if (!id || !summary || !createdAt || !updatedAt || memories.some((memory) => (memory as Record<string, unknown> | undefined)?.id === id)) continue;
    memories.push({
      id,
      status: stress.status ?? "active",
      target: { kind: "self", id: `persona:${String(root.personaId ?? "unknown")}`, label: root.publicName },
      summary,
      claim: typeof stress.trigger === "string" ? stress.trigger : undefined,
      tension: typeof stress.cognitiveDegradation === "string" ? stress.cognitiveDegradation : summary,
      actionImplication: typeof stress.recoveryPath === "string" ? stress.recoveryPath : "Preserve this legacy stress response as migration evidence.",
      intensity: stress.intensity,
      createdAt,
      updatedAt,
      tags: [...(Array.isArray(stress.tags) ? stress.tags : []), "migration:legacy-stress-response"],
      extensions: { legacyStressResponse: stress },
    });
  }
  (thoughtMemory as Record<string, unknown>).memories = memories;
  delete (affect as Record<string, unknown>).stressResponses;
  return root;
}

function readClaimedAuthority(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const provenance = (raw as Record<string, unknown>).provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const authority = (provenance as Record<string, unknown>).authority;
  return typeof authority === "string" ? authority : undefined;
}

function createCache(path: string): CultCache {
  return CultCache.builder().withRegistry(gamecultPersonaStateDocumentRegistry).withGenericStore(new SingleFileMessagePackBackingStore(path)).build();
}

function stripBom(value: string): string { return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value; }
