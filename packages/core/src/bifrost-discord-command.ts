import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const COMMAND_TYPE = "bifrost.bridge.discord_post_command";
const COMMAND_SCHEMA = "bifrost.bridge.discord_post_command.v1";
const RECEIPT_TYPE = "bifrost.bridge.discord_post_receipt";
const RECEIPT_SCHEMA = "bifrost.bridge.discord_post_receipt.v1";

export interface BifrostDiscordCommandConfig {
  commandUri: string;
  storePath: string;
  timeoutMs: number;
  pumpEnabled: boolean;
  bifrostRoot: string;
  cultlibRoot?: string;
}

export interface BifrostDiscordPostInput {
  idempotencyKey: string;
  source: { kind: string; id: string; jobId?: string; requestMessageId?: string };
  actor: { id: string; displayName: string; repoName?: string };
  channelId: string;
  content: string;
  replyToMessageId?: string;
  personaAvatarUrl?: string;
}

export interface BifrostDiscordPostReceipt { commandId: string; messageId: string; transport: string; url?: string }

interface CommandNode {
  put: (definition: unknown, key: string, value: unknown) => Promise<void>;
  get: (definition: unknown, key: string) => unknown;
  flush?: () => Promise<void>;
  cache?: { pullAllBackingStores?: () => Promise<void> };
}

export async function postDiscordViaBifrostCultMesh(input: BifrostDiscordPostInput, config: BifrostDiscordCommandConfig, dependencies: {
  openNode?: () => Promise<CommandNode>;
  definitions?: { command: unknown; receipt: unknown; generic: unknown[] };
  pump?: (commandId: string) => void;
  now?: () => Date;
  pause?: (ms: number) => Promise<void>;
} = {}): Promise<BifrostDiscordPostReceipt> {
  if (!/^cultmesh:\/\/[^/]+\/commands\/discord-post(?:$|[/?#])/.test(config.commandUri)) throw new Error(`BIFROST_CULTMESH_COMMAND_URI must be a CultMesh Discord command URI, got "${config.commandUri}".`);
  if (!input.channelId || !input.content.trim()) throw new Error("Bifrost Discord post requires channel and content.");
  const commandId = `voidbot-discord-${createHash("sha1").update(input.idempotencyKey).digest("hex").slice(0, 20)}`;
  const definitions = dependencies.definitions ?? loadDefinitions(config);
  const node = await (dependencies.openNode ?? (() => openNode(config, definitions)))();
  const requestedAt = (dependencies.now?.() ?? new Date()).toISOString();
  await node.put(definitions.command, commandId, {
    schemaName: COMMAND_TYPE, schemaVersion: COMMAND_SCHEMA, commandId, command: "discord-post", status: "pending",
    requestedBy: "voidbot", requestedAt, updatedAt: requestedAt, commandUri: config.commandUri,
    source: input.source, actor: input.actor,
    payload: {
      identityId: input.actor.id, channelId: input.channelId, content: input.content,
      personaName: input.actor.displayName, personaAvatarUrl: input.personaAvatarUrl ?? "", replyToMessageId: input.replyToMessageId ?? "",
    },
  });
  await node.flush?.();
  if (config.pumpEnabled) (dependencies.pump ?? ((id) => pumpCommand(id, config)))(commandId);
  const receipt = await waitForReceipt(node, definitions.receipt, commandId, config.timeoutMs, dependencies.pause ?? delay);
  if (receipt.status !== "completed" || receipt.ok !== true) throw new Error(`Bifrost CultMesh Discord command ${commandId} failed: ${stringValue(receipt.error) || "no error detail"}`);
  const messageId = stringValue(receipt.messageId);
  const transport = stringValue(receipt.transport);
  if (!messageId || !transport) throw new Error(`Bifrost CultMesh Discord command ${commandId} returned an incomplete receipt.`);
  return { commandId, messageId, transport, url: stringValue(receipt.url) };
}

async function waitForReceipt(node: CommandNode, definition: unknown, commandId: string, timeoutMs: number, pause: (ms: number) => Promise<void>): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    await node.cache?.pullAllBackingStores?.();
    const receipt = unwrapRecord(await node.get(definition, commandId));
    if (receipt) return receipt;
    await pause(250);
  }
  throw new Error(`Timed out waiting for Bifrost CultMesh Discord receipt ${commandId}.`);
}

function openNode(config: BifrostDiscordCommandConfig, definitions: { command: unknown; receipt: unknown; generic: unknown[] }): Promise<CommandNode> {
  const { CultMesh } = loadRuntime(config);
  return CultMesh.createNode(config.storePath, { documents: [definitions.command, definitions.receipt, ...definitions.generic] });
}

function loadDefinitions(config: BifrostDiscordCommandConfig): { command: unknown; receipt: unknown; generic: unknown[] } {
  const { defineDocumentType } = loadRuntime(config);
  const define = (type: string, schemaId: string, name: string) => defineDocumentType({ type, schemaName: type, schemaId, schemaVersion: schemaId, contentHash: schemaId, global: false, name, schema: objectParser(type) });
  return {
    command: define(COMMAND_TYPE, COMMAND_SCHEMA, "commandId"), receipt: define(RECEIPT_TYPE, RECEIPT_SCHEMA, "commandId"),
    generic: [define("gamecult.eve.provider_advertisement", "gamecult.eve.provider_advertisement.v1", "providerId"), define("gamecult.eve.surface_state", "gamecult.eve.surface_state.v1", "providerId"), define("gamecult.eve.interface_binding", "gamecult.eve.interface_binding.v1", "bindingId")],
  };
}

function loadRuntime(config: BifrostDiscordCommandConfig): { CultMesh: { createNode: (path: string, options: unknown) => Promise<CommandNode> }; defineDocumentType: (definition: Record<string, unknown>) => unknown } {
  const candidates = config.cultlibRoot ? [
    [resolve(config.cultlibRoot, "packages", "cultmesh-ts", "package.json"), "./dist/index.js", resolve(config.cultlibRoot, "packages", "cultcache-ts", "package.json"), "./dist/index.js"],
  ] : [];
  candidates.push([resolve(config.bifrostRoot, "..", "CultLib", "packages", "cultmesh-ts", "package.json"), "cultmesh-ts", resolve(config.bifrostRoot, "..", "CultLib", "packages", "cultcache-ts", "package.json"), "cultcache-ts"]);
  for (const [meshPackage, meshModule, cachePackage, cacheModule] of candidates) {
    try {
      const { CultMesh } = createRequire(meshPackage)(meshModule) as { CultMesh?: { createNode: (path: string, options: unknown) => Promise<CommandNode> } };
      const { defineDocumentType } = createRequire(cachePackage)(cacheModule) as { defineDocumentType?: (definition: Record<string, unknown>) => unknown };
      if (CultMesh && defineDocumentType) return { CultMesh, defineDocumentType };
    } catch { }
  }
  throw new Error("CultMesh/CultCache packages are unavailable; cannot write Bifrost command documents.");
}

function pumpCommand(commandId: string, config: BifrostDiscordCommandConfig): void {
  const result = spawnSync(process.execPath, [resolve(config.bifrostRoot, "tools", "cultmesh-bridge-commands.mjs"), "process", "--store", config.storePath, "--command-id", commandId], { cwd: config.bifrostRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error(`Bifrost CultMesh command processor failed: ${result.stderr || result.stdout || result.error?.message || "unknown failure"}`);
}

function objectParser(label: string): { parse: (value: unknown) => unknown } { return { parse(value) { if (!value || typeof value !== "object") throw new Error(`${label} must be an object.`); return value; } }; }
function unwrapRecord(record: unknown): Record<string, unknown> | undefined { const candidate = Array.isArray(record) && record.length === 1 ? record[0] : record; const value = isRecord(candidate) && isRecord(candidate.value) ? candidate.value : candidate; return isRecord(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
