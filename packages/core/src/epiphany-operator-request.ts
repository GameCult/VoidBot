import { createRequire } from "node:module";
import { resolve } from "node:path";

export const EPIPHANY_OPERATOR_REQUEST_TYPE = "voidbot.discord.epiphany_operator_request";
export const EPIPHANY_OPERATOR_REQUEST_SCHEMA = "voidbot.discord.epiphany_operator_request.v0";
export const EPIPHANY_OPERATOR_RUNTIME_ID = "epiphany-yggdrasil";
const MAX_REASON_LENGTH = 500;
const MAX_OBJECTIVE_LENGTH = 2_000;
const REQUEST_LIFETIME_MS = 60_000;

export type EpiphanyOperatorCommand =
  | { kind: "status" }
  | { kind: "sleep"; reason: string }
  | { kind: "wake" }
  | { kind: "directive"; objective: string };

export interface EpiphanyOperatorRequestInput {
  interactionId: string;
  actorDiscordId: string;
  guildId: string;
  channelId: string;
  command: EpiphanyOperatorCommand;
  issuedAt?: string;
}

export interface EpiphanyOperatorRequestConfig {
  storePath: string;
  bifrostRoot: string;
  producerRuntimeId: string;
  cultlibRoot?: string;
}

export interface EpiphanyOperatorRequestDocument {
  schemaName: typeof EPIPHANY_OPERATOR_REQUEST_TYPE;
  schemaVersion: typeof EPIPHANY_OPERATOR_REQUEST_SCHEMA;
  requestId: string;
  commandId: string;
  nonce: string;
  sourceEventId: string;
  sourceActorDiscordId: string;
  discordGuildId: string;
  discordChannelId: string;
  discordMessageId: string;
  targetRuntimeId: typeof EPIPHANY_OPERATOR_RUNTIME_ID;
  issuedAt: string;
  expiresAt: string;
  producerId: "voidbot";
  producerRuntimeId: string;
  authorityClass: "operator_request_only";
  status: "pending";
  command: EpiphanyOperatorCommand;
}

interface OperatorRequestNode {
  put: (definition: unknown, key: string, value: unknown) => Promise<void>;
  get?: (definition: unknown, key: string) => unknown;
  flush?: () => Promise<void>;
  cache?: { pullAllBackingStores?: () => Promise<void> };
}

export function buildEpiphanyOperatorRequest(
  input: EpiphanyOperatorRequestInput,
  producerRuntimeId: string,
): EpiphanyOperatorRequestDocument {
  const interactionId = boundedText(input.interactionId, "interaction id", 128);
  const actorDiscordId = boundedText(input.actorDiscordId, "actor Discord id", 128);
  const guildId = boundedText(input.guildId, "Discord guild id", 128);
  const channelId = boundedText(input.channelId, "Discord channel id", 128);
  const runtime = boundedText(producerRuntimeId, "producer runtime id", 128);
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const issuedAtMillis = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMillis)) throw new Error("Epiphany operator request issuedAt must be RFC3339.");
  const command = validateCommand(input.command);
  return {
    schemaName: EPIPHANY_OPERATOR_REQUEST_TYPE,
    schemaVersion: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
    requestId: interactionId,
    commandId: interactionId,
    nonce: interactionId,
    sourceEventId: interactionId,
    sourceActorDiscordId: actorDiscordId,
    discordGuildId: guildId,
    discordChannelId: channelId,
    discordMessageId: interactionId,
    targetRuntimeId: EPIPHANY_OPERATOR_RUNTIME_ID,
    issuedAt: new Date(issuedAtMillis).toISOString(),
    expiresAt: new Date(issuedAtMillis + REQUEST_LIFETIME_MS).toISOString(),
    producerId: "voidbot",
    producerRuntimeId: runtime,
    authorityClass: "operator_request_only",
    status: "pending",
    command,
  };
}

export async function submitEpiphanyOperatorRequest(
  input: EpiphanyOperatorRequestInput,
  config: EpiphanyOperatorRequestConfig,
  dependencies: { openNode?: () => Promise<OperatorRequestNode>; definition?: unknown } = {},
): Promise<EpiphanyOperatorRequestDocument> {
  const request = buildEpiphanyOperatorRequest(input, config.producerRuntimeId);
  const definition = dependencies.definition ?? loadDefinition(config);
  const node = await (dependencies.openNode ?? (() => openNode(config, definition)))();
  await node.cache?.pullAllBackingStores?.();
  const existing = unwrap(node.get?.(definition, request.requestId));
  if (existing && stable(existing) !== stable(request)) {
    throw new Error(`Epiphany operator request ${request.requestId} already exists with different immutable content.`);
  }
  if (!existing) await node.put(definition, request.requestId, request);
  await node.flush?.();
  return request;
}

function validateCommand(command: EpiphanyOperatorCommand): EpiphanyOperatorCommand {
  if (!command || typeof command !== "object") throw new Error("Epiphany operator command is required.");
  switch (command.kind) {
    case "status":
      return { kind: "status" };
    case "sleep":
      return { kind: "sleep", reason: boundedText(command.reason, "sleep reason", MAX_REASON_LENGTH) };
    case "wake":
      return { kind: "wake" };
    case "directive":
      return { kind: "directive", objective: boundedText(command.objective, "directive objective", MAX_OBJECTIVE_LENGTH) };
    default:
      throw new Error("Unsupported Epiphany operator command.");
  }
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return normalized;
}

function loadDefinition(config: EpiphanyOperatorRequestConfig): unknown {
  const { defineDocumentType } = loadRuntime(config);
  return defineDocumentType({
    type: EPIPHANY_OPERATOR_REQUEST_TYPE,
    schemaName: EPIPHANY_OPERATOR_REQUEST_TYPE,
    schemaId: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
    schemaVersion: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
    contentHash: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
    global: false,
    name: "requestId",
    schema: { parse(value: unknown) { return value; } },
  });
}

function openNode(config: EpiphanyOperatorRequestConfig, definition: unknown): Promise<OperatorRequestNode> {
  return loadRuntime(config).CultMesh.createNode(config.storePath, { documents: [definition] });
}

function loadRuntime(config: EpiphanyOperatorRequestConfig): any {
  const root = config.cultlibRoot ?? resolve(config.bifrostRoot, "..", "CultLib");
  const meshPath = resolve(root, "packages", "cultmesh-ts", "package.json");
  const cachePath = resolve(root, "packages", "cultcache-ts", "package.json");
  return {
    CultMesh: createRequire(meshPath)("cultmesh-ts").CultMesh,
    defineDocumentType: createRequire(cachePath)("cultcache-ts").defineDocumentType,
  };
}

function unwrap(value: unknown): unknown {
  const record = value as { value?: unknown } | undefined;
  return Array.isArray(value) ? value[0] : record?.value ?? value;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, current) => current instanceof Uint8Array ? Buffer.from(current).toString("hex") : current);
}
