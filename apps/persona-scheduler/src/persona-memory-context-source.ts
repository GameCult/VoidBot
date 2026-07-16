import type { loadConfig } from "@voidbot/config";
import type { RepoDiscordIdentity, VoidSelfStateTypedProjection } from "@voidbot/core";
import { createTextEmbedder, createVectorStores, normalizeText, RetrievalService } from "@voidbot/rag";
import type { EmbeddingChunk, SourceMessage } from "@voidbot/shared";

import type { PersonaStateObservation } from "./persona-state-source.js";
import type { ChannelSnapshot } from "./turn-context-source.js";

export type PersonaMemoryRecallObservation =
  | { status: "ok"; hits: PersonaMemoryRecallHit[] }
  | { status: "unavailable"; reason: string };

export interface PersonaMemoryRecallHit {
  score: number;
  text: string;
  memoryKind?: string;
  targetId?: string;
  targetLabel?: string;
}

export async function readPersonaMemoryRecall(input: {
  identity: RepoDiscordIdentity;
  config: ReturnType<typeof loadConfig>;
  state: PersonaStateObservation | undefined;
  projectedMemory: string;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  observedAt?: Date;
}): Promise<PersonaMemoryRecallObservation> {
  if (input.state?.status === "ok" && input.state.stateKind === "gamecult_persona") {
    return { status: "unavailable", reason: "Semantic recall indexing for canonical gamecult.persona_state.v0 CultCache documents is not yet implemented." };
  }
  if (!input.state || input.state.status !== "ok") {
    return { status: "unavailable", reason: input.state?.reason ?? "No typed Persona state observation was supplied." };
  }
  try {
    const store = createPersonaMemoryVectorStore(input.config);
    const chunks = buildPersonaMemoryChunks({
      identity: input.identity,
      statePath: input.state.statePath,
      state: input.state.typedState,
      projectedMemory: input.projectedMemory,
      observedAt: input.observedAt ?? new Date(),
    });
    await store.deleteByFilters({ corpusKind: "persona_memory", identityId: input.identity.id });
    await store.upsert(chunks);
    const retrieval = new RetrievalService(store, store, store);
    const results = await retrieval.searchPersonaMemory(buildRecallQuery(input), 12, { identityId: input.identity.id });
    return {
      status: "ok",
      hits: results.map((result) => ({
        score: result.score,
        text: result.text,
        memoryKind: stringMetadata(result.metadata.memoryKind),
        targetId: stringMetadata(result.metadata.targetId),
        targetLabel: stringMetadata(result.metadata.targetLabel),
      })),
    };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

function createPersonaMemoryVectorStore(config: ReturnType<typeof loadConfig>) {
  const embedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: "Given a Face turn, retrieve relevant memories, bonds, needs, status reads, and doctrine from this Persona's own typed state.",
  });
  return createVectorStores({
    kind: config.vectorStore.kind,
    historyPath: config.vectorStore.path,
    personaMemoryPath: config.vectorStore.personaMemoryPath,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: embedder,
    personaMemoryEmbedder: embedder,
  }).personaMemory;
}

function buildPersonaMemoryChunks(input: {
  identity: RepoDiscordIdentity;
  statePath: string;
  state: VoidSelfStateTypedProjection;
  projectedMemory: string;
  observedAt: Date;
}): EmbeddingChunk[] {
  const chunks: EmbeddingChunk[] = [];
  const sourceId = `persona:${input.identity.id}`;
  const push = (entry: { id: string; kind: string; target?: Record<string, unknown>; text: string; createdAt?: string; updatedAt?: string }): void => {
    const text = collapseWhitespace(entry.text, 1800);
    if (text.length < 24) return;
    chunks.push({
      id: `${sourceId}:${entry.id}`,
      sourceId,
      sourceKind: "persona_memory",
      text,
      normalizedText: normalizeText(text),
      metadata: {
        corpusKind: "persona_memory",
        identityId: input.identity.id,
        personaName: input.identity.displayName,
        sourceId,
        statePath: input.statePath,
        memoryKind: entry.kind,
        targetKind: stringMetadata(entry.target?.kind) ?? "",
        targetId: stringMetadata(entry.target?.id) ?? "",
        targetLabel: stringMetadata(entry.target?.label) ?? "",
        createdAt: entry.createdAt ?? "",
        updatedAt: entry.updatedAt ?? "",
      },
    });
  };
  push({ id: "projected-surface", kind: "projected_surface", target: { kind: "self", id: input.identity.id, label: input.identity.displayName }, text: input.projectedMemory, updatedAt: input.observedAt.toISOString() });
  for (const value of input.state.selfProfile.values) push({ id: `value:${value.id}`, kind: "value", target: { kind: "self", id: input.identity.id, label: input.identity.displayName }, text: joinFields(value.label, value.summary) });
  for (const memory of [...input.state.thoughtMemory.memories, ...input.state.thoughtMemory.shortTerm]) if (!memory.retiredAt) push({ id: `memory:${memory.memoryId}`, kind: memory.kind, target: memory.target, text: joinFields(memory.summary, memory.claim, memory.question, memory.tension, memory.actionImplication), createdAt: memory.createdAt, updatedAt: memory.updatedAt });
  for (const pressure of input.state.agencyPressure.pressures) if (pressure.status !== "retired") push({ id: `agency:${pressure.pressureId}`, kind: `agency:${pressure.kind}:${pressure.status}`, target: pressure.target, text: joinFields(pressure.summary, pressure.claim, pressure.question, pressure.tension, pressure.actionImplication), createdAt: pressure.createdAt, updatedAt: pressure.updatedAt });
  for (const need of input.state.faceAffect.needs) if (need.status !== "retired") push({ id: `need:${need.needId}`, kind: `need:${need.kind}:${need.status}`, target: need.target, text: joinFields(need.summary, need.claim, need.question, need.tension, need.actionImplication), createdAt: need.createdAt, updatedAt: need.updatedAt });
  for (const bond of input.state.faceAffect.socialBonds) if (bond.status === "active") push({ id: `bond:${bond.bondId}`, kind: `bond:${bond.stance}`, target: bond.target, text: joinFields(bond.summary, bond.claim, bond.tension, bond.actionImplication), createdAt: bond.createdAt, updatedAt: bond.updatedAt });
  for (const read of input.state.faceAffect.statusReads) if (!read.retiredAt) push({ id: `status:${read.readId}`, kind: `status:${read.status}`, target: read.target, text: joinFields(read.summary, read.claim, read.tension, read.actionImplication), createdAt: read.createdAt, updatedAt: read.updatedAt });
  for (const stance of input.state.faceAffect.doctrineStances) if (stance.status !== "retired") push({ id: `doctrine:${stance.stanceId}`, kind: `doctrine:${stance.doctrine}:${stance.status}`, target: stance.target, text: joinFields(stance.summary, stance.claim, stance.question, stance.tension, stance.actionImplication), createdAt: stance.createdAt, updatedAt: stance.updatedAt });
  return chunks;
}

function buildRecallQuery(input: { identity: RepoDiscordIdentity; projectedMemory: string; recentMessages: SourceMessage[]; channelSnapshots: ChannelSnapshot[] }): string {
  const recent = input.recentMessages.slice(-8).map((message) => `${message.authorName}: ${collapseWhitespace(message.content, 360)}`).join("\n");
  const nearby = input.channelSnapshots.flatMap((snapshot) => snapshot.messages.slice(-3).map((message) => `${snapshot.channelId} / ${message.authorName}: ${collapseWhitespace(message.content, 260)}`)).slice(-12).join("\n");
  return [`${input.identity.displayName} current Face turn`, "Projected memory surface:", collapseWhitespace(input.projectedMemory, 2200), "Recent room:", recent, "Nearby room texture:", nearby].join("\n");
}

function joinFields(...fields: Array<string | undefined>): string { return fields.filter((field): field is string => Boolean(field?.trim())).join(" "); }
function collapseWhitespace(value: string, maxLength: number): string { return value.replace(/\s+/g, " ").trim().slice(0, maxLength); }
function stringMetadata(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
