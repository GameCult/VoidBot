#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const repoRoot = path.resolve(__dirname, "..");
const defaultStorePath = path.join(repoRoot, ".voidbot", "status", "cultmesh", "voidbot-swarm-state.cc");
const defaultControlStorePath = path.join(repoRoot, ".voidbot", "private", "swarm-controls.cc");
const defaultBind = "127.0.0.1:17873";
const defaultOdinCultMeshUri = "cultmesh://odin/rendezvous/provider-catalog";
const defaultOdinRudpEndpoint = "rudp://127.0.0.1:17871";
const connectionId = 0x43554c54;
const odinConnectionId = 0x0d1d0002;

const args = parseArgs(process.argv.slice(2));
const storePath = path.resolve(args.store || process.env.VOIDBOT_SWARM_CULTMESH_STORE || defaultStorePath);
const controlStorePath = path.resolve(args.controlStore || process.env.VOIDBOT_SWARM_CONTROL_STORE || defaultControlStorePath);
const bind = parseBind(args.bind || process.env.VOIDBOT_SWARM_CULTMESH_BIND || defaultBind);
const odinCultMeshUri = args.odinCultMeshUri || args["odin-cultmesh-uri"] || process.env.VOIDBOT_ODIN_CULTMESH_URI || process.env.ODIN_CULTMESH_URI || defaultOdinCultMeshUri;
const odinRudpEndpoint = args.odinRudpEndpoint || args["odin-rudp-endpoint"] || process.env.VOIDBOT_ODIN_RUDP || process.env.CULTMESH_URI_ODIN_RUDP || defaultOdinRudpEndpoint;
const { CultMesh, CultNetDocumentRegistry, defineCultNetDocumentBinding, defineDocumentType } = loadCultRuntime();
const documents = defineDocuments(defineDocumentType);
const documentDefinitions = Object.values(documents);
const bindings = {
  provider: defineCultNetDocumentBinding({ definition: documents.provider }),
  surface: defineCultNetDocumentBinding({ definition: documents.surface }),
  commandReceipt: defineCultNetDocumentBinding({ definition: documents.commandReceipt }),
};
const documentRegistry = new CultNetDocumentRegistry(
  documentDefinitions.map((definition) => defineCultNetDocumentBinding({ definition })),
);
let server = null;
let announceTimer = null;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  await publishCurrentControlState();
  server = CultMesh.createRudpDocumentServer("voidbot-swarm-cultmesh", connectionId, {
    bindHost: bind.host,
    bindPort: bind.port,
    documents: documentRegistry,
    getCache: async () => {
      if (!fs.existsSync(storePath)) {
        throw new Error(`VoidBot swarm CultMesh store is missing at ${storePath}`);
      }
      const node = await CultMesh.createNode(storePath, {
        documents: documentDefinitions,
      });
      return node.cache;
    },
    onError: (error) => {
      console.error(`VoidBot swarm CultMesh/RUDP server error: ${error instanceof Error ? error.message : String(error)}`);
    },
    onDocumentPutRaw: applySwarmCommand,
  });

  await server.start();
  console.log(`VoidBot swarm CultMesh/RUDP serving ${storePath} at rudp://${bind.host}:${bind.port}`);
  announceToOdin().catch((error) => {
    console.error(`VoidBot swarm Odin announcement failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  announceTimer = setInterval(() => {
    announceToOdin().catch((error) => {
      console.error(`VoidBot swarm Odin announcement failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 30_000);
  announceTimer.unref?.();

  const shutdown = () => {
    try {
      if (announceTimer) clearInterval(announceTimer);
      server?.close?.();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function publishCurrentControlState() {
  if (!fs.existsSync(controlStorePath)) return;
  const controlNode = await CultMesh.createNode(controlStorePath, { documents: [documents.swarmControl] });
  const control = controlNode.get(documents.swarmControl, "voidbot-swarm");
  if (control) await projectAcceptedHeat(control);
}

async function applySwarmCommand(document) {
  if (document.schemaId !== "gamecult.eve.command.v1") return;
  const command = document.payload;
  if (!command || command.providerId !== "voidbot.swarm" || command.command !== "swarm.set_heat") return;
  const value = Number(command.payload?.value);
  if (!Number.isFinite(value) || value < 0.05 || value > 2) {
    throw new Error(`swarm.set_heat value must be between 0.05 and 2, got ${command.payload?.value}`);
  }
  const node = await CultMesh.createNode(controlStorePath, { documents: [documents.swarmControl] });
  const control = {
    schemaVersion: "voidbot.swarm_control_state.v1",
    globalHeat: Math.round(value * 100) / 100,
    commandId: command.commandId,
    updatedAt: new Date().toISOString(),
    updatedBy: command.clientId || command.publishedBy || "unknown",
  };
  await node.put(documents.swarmControl, "voidbot-swarm", control);
  await node.flush?.(true);
  await projectAcceptedHeat(control);
  console.log(`Applied swarm heat ${control.globalHeat} from ${control.commandId}`);
  return {
    binding: bindings.commandReceipt,
    recordKey: control.commandId,
    value: {
      schema: "gamecult.eve.command_receipt.v1",
      receiptId: `voidbot.swarm:${control.commandId}`,
      commandId: control.commandId,
      command: command.command,
      state: "reconciled",
      ownerRepo: "VoidBot",
      authority: "voidbot.swarm_control_state.v1:voidbot-swarm",
      providerId: command.providerId,
      surfaceId: command.surfaceId || "voidbot.swarm.surface",
      sourceVersion: Date.parse(control.updatedAt),
      issuedAtUtc: control.updatedAt,
      message: `Swarm heat applied at ${control.globalHeat}.`,
      diagnostics: [{ code: "state-published", pointerId: "summary.globalHeat" }],
    },
    sourceRuntimeId: "voidbot-swarm-cultmesh",
    sourceRole: "swarm-control-owner",
    tags: ["eve", "command-receipt", "swarm-control"],
  };
}

async function projectAcceptedHeat(control) {
  const node = await CultMesh.createNode(storePath, { documents: documentDefinitions });
  await node.put(documents.swarmControl, "voidbot-swarm", control);
  await node.flush?.(true);
}

async function announceToOdin() {
  const node = await CultMesh.createNode(storePath, {
    documents: documentDefinitions,
  });
  const provider = node.get(documents.provider, "voidbot.swarm");
  const surface = node.get(documents.surface, "voidbot.swarm");
  if (!provider || !surface) {
    throw new Error("VoidBot swarm store must contain provider and surface documents before announcing to Odin.");
  }
  const options = {
    connectTimeoutMs: 2_000,
    flushTimeoutMs: 150,
    sourceRuntimeId: "voidbot-swarm-cultmesh",
    sourceRole: "daemon-provider",
    tags: ["voidbot", "eve", "cultmesh-rudp"],
    resolveCultMeshRudpEndpoint: (uri) => String(uri || "").startsWith("cultmesh://odin/")
      ? odinRudpEndpoint
      : undefined,
  };
  await CultMesh.publishRudpDocumentOnce(
    "voidbot-swarm-cultmesh",
    odinConnectionId,
    odinRudpEndpoint,
    bindings.provider,
    "voidbot.swarm",
    provider,
    options,
  );
  await CultMesh.publishRudpDocumentOnce(
    "voidbot-swarm-cultmesh",
    odinConnectionId,
    odinRudpEndpoint,
    bindings.surface,
    "voidbot.swarm",
    surface,
    options,
  );
  console.log(`VoidBot swarm announced provider and surface documents to ${odinCultMeshUri}`);
}

function defineDocuments(defineDocumentType) {
  const objectSchema = (label) => ({
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
      }
      return value;
    },
  });
  return {
    snapshot: defineDocumentType({
      type: "voidbot.swarm_state_snapshot",
      schemaName: "voidbot.swarm_state_snapshot",
      schemaId: "voidbot.swarm_state_snapshot.v1",
      schemaVersion: "voidbot.swarm_state_snapshot.v1",
      global: true,
      schema: objectSchema("VoidBot swarm snapshot"),
    }),
    provider: defineDocumentType({
      type: "gamecult.eve.provider_advertisement",
      schemaName: "gamecult.eve.provider_advertisement",
      schemaId: "gamecult.eve.provider_advertisement.v1",
      schemaVersion: "gamecult.eve.provider_advertisement.v1",
      global: false,
      name: (value) => value?.providerId || value?.provider?.id || "provider",
      schema: objectSchema("Eve provider advertisement"),
    }),
    surface: defineDocumentType({
      type: "gamecult.eve.surface_state",
      schemaName: "gamecult.eve.surface_state",
      schemaId: "gamecult.eve.surface_state.v1",
      schemaVersion: "gamecult.eve.surface_state.v1",
      global: false,
      name: (value) => value?.providerId || value?.provider_id || "surface",
      schema: objectSchema("Eve surface state"),
    }),
    binding: defineDocumentType({
      type: "gamecult.eve.interface_binding",
      schemaName: "gamecult.eve.interface_binding",
      schemaId: "gamecult.eve.interface_binding.v1",
      schemaVersion: "gamecult.eve.interface_binding.v1",
      global: false,
      name: (value) => value?.bindingId || value?.providerId || "interface",
      schema: objectSchema("Eve interface binding"),
    }),
    providerCatalog: defineDocumentType({
      type: "voidbot.provider_advertisement_catalog",
      schemaName: "voidbot.provider_advertisement_catalog",
      schemaId: "voidbot.provider_advertisement_catalog.v0",
      schemaVersion: "voidbot.provider_advertisement_catalog.v0",
      global: true,
      schema: objectSchema("VoidBot provider advertisement catalog"),
    }),
    transportProfile: defineDocumentType({
      type: "idunn.daemon_transport_profile",
      schemaName: "idunn.daemon_transport_profile",
      schemaId: "idunn.daemon_transport_profile.v1",
      schemaVersion: "idunn.daemon_transport_profile.v1",
      global: false,
      name: (value) => value?.profile_id || value?.daemon_id || "voidbot",
      schema: objectSchema("Idunn daemon transport profile"),
    }),
    commandBoundary: defineDocumentType({
      type: "idunn.command_boundary",
      schemaName: "idunn.command_boundary",
      schemaId: "idunn.command_boundary.v1",
      schemaVersion: "idunn.command_boundary.v1",
      global: false,
      name: (value) => value?.boundary_id || value?.daemon_id || "voidbot",
      schema: objectSchema("Idunn command boundary"),
    }),
    eveCommand: defineDocumentType({
      type: "gamecult.eve.command",
      schemaName: "gamecult.eve.command",
      schemaId: "gamecult.eve.command.v1",
      schemaVersion: "gamecult.eve.command.v1",
      global: false,
      name: (value) => value?.commandId || value?.command_id || "swarm-command",
      schema: objectSchema("Eve command"),
    }),
    commandReceipt: defineDocumentType({
      type: "gamecult.eve.command_receipt",
      schemaName: "gamecult.eve.command_receipt",
      schemaId: "gamecult.eve.command_receipt.v1",
      schemaVersion: "gamecult.eve.command_receipt.v1",
      global: false,
      name: (value) => value?.commandId || value?.receiptId || "command-receipt",
      schema: objectSchema("Eve command receipt"),
    }),
    swarmControl: defineDocumentType({
      type: "voidbot.swarm_control_state",
      schemaName: "voidbot.swarm_control_state",
      schemaId: "voidbot.swarm_control_state.v1",
      schemaVersion: "voidbot.swarm_control_state.v1",
      global: false,
      name: () => "voidbot-swarm",
      schema: objectSchema("VoidBot swarm control state"),
    }),
  };
}

function loadCultRuntime() {
  const cultLibRoot = process.env.VOIDBOT_CULTLIB_ROOT
    ? path.resolve(process.env.VOIDBOT_CULTLIB_ROOT)
    : path.resolve(repoRoot, "..", "CultLib-dev-runtime");
  const packageJson = path.resolve(cultLibRoot, "packages", "cultmesh-ts", "package.json");
  const requireCult = createRequire(packageJson);
  const { CultMesh } = requireCult("./dist/index.js");
  const { CultNetDocumentRegistry, defineCultNetDocumentBinding } = createRequire(path.resolve(cultLibRoot, "packages", "cultnet-ts", "package.json"))("./dist/index.js");
  const { defineDocumentType } = createRequire(path.resolve(cultLibRoot, "packages", "cultcache-ts", "package.json"))("./dist/index.js");
  return { CultMesh, CultNetDocumentRegistry, defineCultNetDocumentBinding, defineDocumentType };
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--store") parsed.store = values[++index];
    else if (arg === "--control-store") parsed.controlStore = values[++index];
    else if (arg === "--bind") parsed.bind = values[++index];
    else if (arg === "--odin-cultmesh-uri") parsed.odinCultMeshUri = values[++index];
    else if (arg === "--odin-rudp-endpoint") parsed.odinRudpEndpoint = values[++index];
  }
  return parsed;
}

function parseBind(value) {
  const text = String(value || "").trim();
  const index = text.lastIndexOf(":");
  if (index <= 0) throw new Error(`Bind address must be host:port, got ${value}`);
  const host = text.slice(0, index);
  const port = Number(text.slice(index + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port in bind address ${value}`);
  }
  return { host, port };
}
