#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const requireCult = createRequire(resolve(repoRoot, "..", "CultLib", "packages", "cultmesh-ts", "package.json"));
const { CultMesh } = requireCult("./dist/index.js");
const { defineDocumentType } = createRequire(resolve(repoRoot, "..", "CultLib", "packages", "cultcache-ts", "package.json"))("./dist/index.js");
const value = Number(process.argv[2] ?? 0.75);
if (!Number.isFinite(value) || value < 0.05 || value > 2) throw new Error("Heat must be between 0.05 and 2.");

const objectSchema = { parse(input) { if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected object."); return input; } };
const commandDefinition = defineDocumentType({
  type: "gamecult.eve.command", schemaName: "gamecult.eve.command", schemaId: "gamecult.eve.command.v1", schemaVersion: "gamecult.eve.command.v1",
  global: false, name: input => input?.commandId || "smoke-command", schema: objectSchema,
});
const controlDefinition = defineDocumentType({
  type: "voidbot.swarm_control_state", schemaName: "voidbot.swarm_control_state", schemaId: "voidbot.swarm_control_state.v1", schemaVersion: "voidbot.swarm_control_state.v1",
  global: false, name: () => "voidbot-swarm", schema: objectSchema,
});
const receiptDefinition = defineDocumentType({
  type: "gamecult.eve.command_receipt", schemaName: "gamecult.eve.command_receipt", schemaId: "gamecult.eve.command_receipt.v1", schemaVersion: "gamecult.eve.command_receipt.v1",
  global: false, name: input => input?.commandId || "smoke-receipt", schema: objectSchema,
});
const commandId = `smoke:swarm-heat:${Date.now()}`;
const receipt = await CultMesh.publishRudpDocumentAndWaitForReceipt("voidbot-swarm-heat-smoke", 0x43554c54, "rudp://127.0.0.1:17873", { definition: commandDefinition }, commandId, {
  schema: "gamecult.eve.command.v1", commandId, providerId: "voidbot.swarm", surfaceId: "voidbot.swarm.surface",
  command: "swarm.set_heat", payload: { value, transport: "cultmesh-binding" }, clientId: "voidbot.smoke", issuedAt: new Date().toISOString(),
}, { definition: receiptDefinition }, { sourceRuntimeId: "voidbot-swarm-heat-smoke", sourceRole: "verification", tags: ["smoke", "command"], receiptTimeoutMs: 5_000 });
if (receipt.commandId !== commandId || receipt.state !== "reconciled") throw new Error(`Receipt did not confirm application: ${JSON.stringify(receipt)}`);

await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
const node = await CultMesh.createNode(resolve(repoRoot, ".voidbot", "private", "swarm-controls.cc"), { documents: [controlDefinition] });
const control = node.get(controlDefinition, "voidbot-swarm");
if (Number(control?.globalHeat) !== value || control?.commandId !== commandId) throw new Error(`Applied control did not match command: ${JSON.stringify(control)}`);
console.log(JSON.stringify({ ok: true, commandId, globalHeat: control.globalHeat, receipt, controlStore: resolve(repoRoot, ".voidbot", "private", "swarm-controls.cc") }));
