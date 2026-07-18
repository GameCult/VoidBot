import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const PERSONA_FEEDBACK_EVENT_TYPE = "voidbot.discord.persona_feedback_event";
export const PERSONA_FEEDBACK_EVENT_SCHEMA = "voidbot.discord.persona_feedback_event.v0";

export interface PersonaFeedbackInput {
  guildId: string; channelId: string; messageId: string; authorId: string; authorName: string;
  observedAt: string;
  addressingMode: "role" | "text" | "reply" | "broadcast";
  content: string; targetPersonaId: string; targetRepoName: string; targetRuntimeId: string;
}

export async function exportPersonaFeedbackObservation(input: PersonaFeedbackInput, config: {
  storePath: string; bifrostRoot: string; producerRuntimeId: string; cultlibRoot?: string;
}, dependencies: { openNode?: () => Promise<{ put: (definition: unknown, key: string, value: unknown) => Promise<void>; get?: (definition: unknown, key: string) => unknown; flush?: () => Promise<void>; cache?: { pullAllBackingStores?: () => Promise<void> } }>; definition?: unknown } = {}): Promise<string> {
  const payloadHash = createHash("sha256").update(input.content, "utf8").digest("hex");
  const eventId = `feedback-${createHash("sha256").update([input.guildId, input.channelId, input.messageId, input.targetRuntimeId, input.targetRepoName, input.targetPersonaId, config.producerRuntimeId].join(":"), "utf8").digest("hex").slice(0, 32)}`;
  const definition = dependencies.definition ?? loadDefinition(config);
  const node = await (dependencies.openNode ?? (() => openNode(config, definition)))();
  const event = {
    schemaName: PERSONA_FEEDBACK_EVENT_TYPE, schemaVersion: PERSONA_FEEDBACK_EVENT_SCHEMA,
    eventId, observedAt: input.observedAt,
    guildId: input.guildId, channelId: input.channelId, messageId: input.messageId,
    authorId: input.authorId, authorName: input.authorName, addressingMode: input.addressingMode,
    targetPersonaId: input.targetPersonaId, targetRepoName: input.targetRepoName, targetRuntimeId: input.targetRuntimeId,
    content: input.content, payloadHash, producerId: "voidbot", producerRuntimeId: config.producerRuntimeId,
    authorityClass: "feedback_only", status: "pending",
  };
  await node.cache?.pullAllBackingStores?.();
  const existing = unwrap(node.get?.(definition, eventId));
  if (existing && stable(existing) !== stable(event)) throw new Error(`Persona feedback event ${eventId} already exists with different immutable content.`);
  if (!existing) await node.put(definition, eventId, event);
  await node.flush?.();
  return eventId;
}

function loadDefinition(config: { bifrostRoot: string; cultlibRoot?: string }): unknown {
  const { defineDocumentType } = loadRuntime(config);
  return defineDocumentType({ type: PERSONA_FEEDBACK_EVENT_TYPE, schemaName: PERSONA_FEEDBACK_EVENT_TYPE, schemaId: PERSONA_FEEDBACK_EVENT_SCHEMA, schemaVersion: PERSONA_FEEDBACK_EVENT_SCHEMA, contentHash: PERSONA_FEEDBACK_EVENT_SCHEMA, global: false, name: "eventId", schema: { parse(value: unknown) { if (!value || typeof value !== "object") throw new Error("Persona feedback event must be an object."); return value; } } });
}
function openNode(config: { storePath: string; bifrostRoot: string; cultlibRoot?: string }, definition: unknown): Promise<any> { return loadRuntime(config).CultMesh.createNode(config.storePath, { documents: [definition] }); }
function loadRuntime(config: { bifrostRoot: string; cultlibRoot?: string }): any {
  const root = config.cultlibRoot ?? resolve(config.bifrostRoot, "..", "CultLib");
  const meshPath = resolve(root, "packages", "cultmesh-ts", "package.json");
  const cachePath = resolve(root, "packages", "cultcache-ts", "package.json");
  const CultMesh = createRequire(meshPath)("cultmesh-ts").CultMesh;
  const defineDocumentType = createRequire(cachePath)("cultcache-ts").defineDocumentType;
  return { CultMesh, defineDocumentType };
}
function unwrap(value: unknown): unknown { const record = value as { value?: unknown } | undefined; return Array.isArray(value) ? value[0] : record?.value ?? value; }
function stable(value: unknown): string { return JSON.stringify(value, (_key, current) => current instanceof Uint8Array ? Buffer.from(current).toString("hex") : current); }
