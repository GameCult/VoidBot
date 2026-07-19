import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  EPIPHANY_OPERATOR_REQUEST_SCHEMA,
  EPIPHANY_OPERATOR_REQUEST_TYPE,
  buildEpiphanyOperatorRequest,
  submitEpiphanyOperatorRequest,
} from "../packages/core/src/epiphany-operator-request";
import { commandDefinitions, isExactDiscordOwner } from "../apps/bot/src/discord-bot-handlers";

async function main(): Promise<void> {
const owner = "owner-1";
assert.equal(isExactDiscordOwner(owner, owner), true);
assert.equal(isExactDiscordOwner("administrator-1", owner), false);
assert.equal(isExactDiscordOwner("tier-one-1", owner), false);

const epiphany = commandDefinitions.map((command) => command.toJSON()).find((command) => command.name === "epiphany");
assert.ok(epiphany, "slash command is registered");
assert.deepEqual(epiphany.options?.map((option) => option.name), ["status", "sleep", "wake", "direct", "reviews", "review"]);

const protocolPath = process.env.EPIPHANY_OPERATOR_PROTOCOL_FIXTURE
  ?? resolve("..", "EpiphanyAgent", ".epiphany-smoke", "operator-command-interop-rust", "protocol.json");
const protocol = JSON.parse(await readFile(protocolPath, "utf8"));
assert.equal(protocol.schemaVersion, "epiphany.operator_command.protocol_fixture.v1");
assert.equal(protocol.admissionSchemaVersion, "bifrost.operator_command.delivery.v1");
assert.equal(protocol.resultSchemaVersion, "epiphany.operator_command.result.v1");
assert.deepEqual(protocol.commands.map((command: { kind: string }) => command.kind), ["status", "sleep", "wake", "directive", "reviews", "review"]);
assert.deepEqual(protocol.reviewDecisions, ["adopt", "refuse", "hold"]);

const issuedAt = "2026-07-19T12:00:00.000Z";
const commands = [
  { kind: "status" } as const,
  { kind: "sleep", reason: "Operator is packing the workstation." } as const,
  { kind: "wake" } as const,
  { kind: "directive", objective: "Inspect the current domain map and propose the next bounded improvement." } as const,
  { kind: "reviews" } as const,
  protocol.commands[5],
];
for (const [index, command] of commands.entries()) {
  const id = `interaction-${index}`;
  const request = buildEpiphanyOperatorRequest({
    interactionId: id,
    actorDiscordId: owner,
    guildId: "guild-1",
    channelId: "channel-1",
    command,
    issuedAt,
  }, "voidbot-yggdrasil");
  assert.equal(request.schemaName, EPIPHANY_OPERATOR_REQUEST_TYPE);
  assert.equal(request.schemaVersion, EPIPHANY_OPERATOR_REQUEST_SCHEMA);
  assert.equal(request.requestId, id);
  assert.equal(request.commandId, id);
  assert.equal(request.nonce, id);
  assert.equal(request.sourceEventId, id);
  assert.equal(request.discordMessageId, id);
  assert.equal(request.targetRuntimeId, "epiphany-yggdrasil");
  assert.equal(request.authorityClass, "operator_request_only");
  assert.equal(Date.parse(request.expiresAt) - Date.parse(request.issuedAt), 60_000);
  assert.deepEqual(Object.keys(request).sort(), [
    "authorityClass", "command", "commandId", "discordChannelId", "discordGuildId",
    "discordMessageId", "expiresAt", "issuedAt", "nonce", "producerId", "producerRuntimeId",
    "requestId", "schemaName", "schemaVersion", "sourceActorDiscordId", "sourceEventId", "status",
    "targetRuntimeId",
  ].sort());
}

const stored = new Map<string, unknown>();
const definition = {};
const openNode = async () => ({
  get: (_definition: unknown, key: string) => stored.get(key),
  put: async (_definition: unknown, key: string, value: unknown) => { stored.set(key, value); },
  flush: async () => undefined,
  cache: { pullAllBackingStores: async () => undefined },
});
const input = {
  interactionId: "interaction-replay",
  actorDiscordId: owner,
  guildId: "guild-1",
  channelId: "channel-1",
  command: { kind: "wake" } as const,
  issuedAt,
};
const config = { storePath: "unused.cc", bifrostRoot: "unused", producerRuntimeId: "voidbot-yggdrasil" };
await submitEpiphanyOperatorRequest(input, config, { definition, openNode });
await submitEpiphanyOperatorRequest(input, config, { definition, openNode });
await assert.rejects(
  submitEpiphanyOperatorRequest({ ...input, command: { kind: "status" } }, config, { definition, openNode }),
  /different immutable content/,
);
assert.throws(() => buildEpiphanyOperatorRequest({ ...input, command: { kind: "sleep", reason: "x".repeat(501) } }, "voidbot-yggdrasil"), /500/);
assert.throws(() => buildEpiphanyOperatorRequest({ ...input, command: { kind: "directive", objective: "x".repeat(2001) } }, "voidbot-yggdrasil"), /2000/);
const review = commands[5] as Extract<(typeof commands)[number], { kind: "review" }>;
assert.deepEqual(Object.keys(protocol.commands[5]).sort(), ["candidateId", "candidateSha256", "decision", "expectedModelHash", "expectedModelRevision", "kind", "mindRequestId"].sort());
assert.throws(() => buildEpiphanyOperatorRequest({ ...input, command: { ...review, candidateSha256: "0".repeat(63) } }, "voidbot-yggdrasil"), /64 lowercase/);
assert.throws(() => buildEpiphanyOperatorRequest({ ...input, command: { ...review, expectedModelRevision: -1 } }, "voidbot-yggdrasil"), /non-negative/);
assert.throws(() => buildEpiphanyOperatorRequest({ ...input, command: { ...review, decision: "approve" as "adopt" } }, "voidbot-yggdrasil"), /decision/);

const botSource = await readFile(resolve("apps/bot/src/discord-bot.ts"), "utf8");
const messageCreate = botSource.slice(botSource.indexOf("client.on(Events.MessageCreate"), botSource.indexOf("client.on(Events.MessageUpdate"));
assert.ok(messageCreate.includes("exportPersonaFeedbackWithRetry"), "ordinary addressed messages retain feedback export");
assert.ok(!messageCreate.includes("submitEpiphanyOperatorRequest"), "ordinary messages cannot submit operator requests");

console.log(JSON.stringify({
  schemaVersion: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
  commands: ["status", "sleep", "wake", "direct", "reviews", "review"],
  rustProtocolFixtureConsumed: true,
  exactOwnerOnly: true,
  ordinaryMessagesRemainFeedbackOnly: true,
  localExecutionAuthorized: false,
  mindAuthorityGranted: false,
  handsAuthorityGranted: false,
  releaseAuthorityGranted: false,
  deploymentAuthorityGranted: false,
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
