import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import {
  buildEpiphanyOperatorRequest,
  epiphanyOperatorRequestPayloadSha256,
  processEpiphanyOperatorDelivery,
  consumeEpiphanyOperatorDeliveries,
  registerEpiphanyOperatorInteraction,
  submitEpiphanyOperatorRequest,
  validateDelivery,
  type EpiphanyOperatorDeliveryDocument,
  type EpiphanyOperatorDeliveryCheckpoint,
} from "../packages/core/src/index";

async function main(): Promise<void> {

const request = buildEpiphanyOperatorRequest({
  interactionId: "interaction-1", actorDiscordId: "owner-1", guildId: "guild-1",
  channelId: "channel-1", command: { kind: "sleep", reason: "bank the fire" },
  issuedAt: "2026-07-19T12:00:00.000Z",
}, "voidbot-yggdrasil");
const digest = epiphanyOperatorRequestPayloadSha256(request);
assert.match(digest, /^sha256-[0-9a-f]{64}$/);
assert.notEqual(digest, epiphanyOperatorRequestPayloadSha256({ ...request, discordGuildId: "other" }));
assert.notEqual(digest, epiphanyOperatorRequestPayloadSha256({ ...request, command: { kind: "wake" } }));

const completed: EpiphanyOperatorDeliveryDocument = {
  schemaVersion: "bifrost.discord.epiphany_operator_delivery.v1",
  deliveryId: request.requestId, requestId: request.requestId, requestPayloadSha256: digest,
  commandId: request.commandId, discordGuildId: request.discordGuildId,
  discordChannelId: request.discordChannelId, discordInteractionId: request.sourceEventId,
  targetRuntimeId: "epiphany-yggdrasil", status: "completed", disposition: "observed",
  failureCode: "", detail: "sleep accepted", operatorStatus: "sleeping", stateStatus: "banked",
  coordinatorAction: "none", brakeStatus: "engaged",
  sealedResultPayloadSha256: `sha256-${"a".repeat(64)}`,
  executorSignatureSha256: `sha256-${"b".repeat(64)}`, resultProviderIdentityId: "bifrost-yggdrasil",
  reviews: [], reviewCandidateId: "", reviewDecision: "",
  recordedAt: "2026-07-19T12:00:01.000Z", privateStateExposed: false,
};
assert.equal(validateDelivery(completed).status, "completed");

const refused: EpiphanyOperatorDeliveryDocument = {
  ...completed, status: "refused", disposition: "", failureCode: "brakes_engaged", detail: "refused",
  operatorStatus: "", stateStatus: "", coordinatorAction: "", brakeStatus: "",
  sealedResultPayloadSha256: "", executorSignatureSha256: "", resultProviderIdentityId: "",
  reviews: [], reviewCandidateId: "", reviewDecision: "",
};
assert.equal(validateDelivery(refused).status, "refused");

function rejects(change: Record<string, unknown>, pattern: RegExp): void {
  assert.throws(() => validateDelivery({ ...completed, ...change }), pattern);
}
rejects({ privateStateExposed: true }, /private state/);
rejects({ status: "pending" }, /terminal/);
rejects({ detail: "x".repeat(513) }, /detail/);
rejects({ operatorStatus: "x".repeat(513) }, /operatorStatus/);
rejects({ requestPayloadSha256: "raw-payload" }, /digest/);
rejects({ targetRuntimeId: "epiphany-nightwing" }, /runtime/);
rejects({ deliveryId: "collision" }, /identity/);
rejects({ executorSignatureSha256: "signature-bytes" }, /sealed bindings/);
rejects({ resultProviderIdentityId: "" }, /resultProviderIdentityId|sealed bindings/);
rejects({ surprisePrivatePayload: "secret" }, /field set/);
rejects({ reviews: [{ mindRequestId: "m", candidateId: "c", candidateSha256: "1".repeat(64), modelRevision: 1, modelHash: "2".repeat(64), frontierItemId: "f", requestedAt: "2026-07-19T12:00:00Z", proposalText: "private" }] }, /inexact field set/);
rejects({ reviews: Array.from({ length: 11 }, () => ({ mindRequestId: "m", candidateId: "c", candidateSha256: "1".repeat(64), modelRevision: 1, modelHash: "2".repeat(64), frontierItemId: "f", requestedAt: "2026-07-19T12:00:00Z" })) }, /at most ten/);
assert.throws(() => validateDelivery({ ...refused, brakeStatus: "not empty" }), /completed-result bindings/);
assert.throws(() => validateDelivery({ ...refused, failureCode: "" }), /failureCode|failure code/);

const baseCheckpoint: EpiphanyOperatorDeliveryCheckpoint = {
  schemaVersion: "voidbot.private.epiphany_operator_delivery_checkpoint.v0", requestId: request.requestId,
  applicationId: "app-1", interactionToken: "private-token", discordGuildId: request.discordGuildId,
  discordChannelId: request.discordChannelId, discordInteractionId: request.sourceEventId,
  targetRuntimeId: "epiphany-yggdrasil", state: "pending", observedDeliverySha256: "",
  respondedDeliverySha256: "", attemptCount: 0, lastError: "",
  registeredAt: "2026-07-19T12:00:00.000Z", updatedAt: "2026-07-19T12:00:00.000Z",
};
let current = baseCheckpoint;
let editCount = 0;
let failEdit = true;
const edit = async (_app: string, token: string, content: string): Promise<void> => {
  assert.equal(token, "private-token");
  assert.doesNotMatch(content, /signature|private-token|sha256-/i);
  editCount += 1;
  if (failEdit) throw new Error("temporary Discord failure");
};
const save = async (next: EpiphanyOperatorDeliveryCheckpoint): Promise<void> => { current = next; };
assert.equal(await processEpiphanyOperatorDelivery(completed, request, current, edit, save), "failed");
assert.equal(current.state, "pending");
assert.match(current.lastError, /temporary Discord failure/);
assert.ok(current.observedDeliverySha256);
failEdit = false;
assert.equal(await processEpiphanyOperatorDelivery(completed, request, current, edit, save), "responded");
assert.equal(current.state, "responded");
assert.equal(await processEpiphanyOperatorDelivery(completed, request, current, edit, save), "replayed");
assert.equal(editCount, 2, "a restart replay must not create another response");

for (const [field, value] of [["commandId", "wrong"], ["discordGuildId", "wrong"], ["discordChannelId", "wrong"], ["discordInteractionId", "wrong"], ["targetRuntimeId", "epiphany-nightwing"], ["requestPayloadSha256", `sha256-${"c".repeat(64)}`]] as const) {
  let rejectedCheckpoint = { ...baseCheckpoint };
  assert.equal(await processEpiphanyOperatorDelivery({ ...completed, [field]: value }, request, rejectedCheckpoint, async () => { throw new Error("must not edit"); }, async (next) => { rejectedCheckpoint = next; }), "failed");
  assert.match(rejectedCheckpoint.lastError, /request|runtime|digest/);
}
let collisionCheckpoint = { ...baseCheckpoint, observedDeliverySha256: `sha256-${"d".repeat(64)}` };
assert.equal(await processEpiphanyOperatorDelivery(completed, request, collisionCheckpoint, async () => { throw new Error("must not edit"); }, async (next) => { collisionCheckpoint = next; }), "failed");
assert.match(collisionCheckpoint.lastError, /collision/);

const reviewRequest = buildEpiphanyOperatorRequest({
  interactionId: "interaction-review", actorDiscordId: "owner-1", guildId: "guild-1", channelId: "channel-1",
  command: { kind: "reviews" }, issuedAt: "2026-07-19T12:00:00.000Z",
}, "voidbot-yggdrasil");
const reviewDelivery: EpiphanyOperatorDeliveryDocument = {
  ...completed,
  deliveryId: reviewRequest.requestId, requestId: reviewRequest.requestId, commandId: reviewRequest.commandId,
  discordInteractionId: reviewRequest.sourceEventId, requestPayloadSha256: epiphanyOperatorRequestPayloadSha256(reviewRequest),
  reviews: [{ mindRequestId: "mind-1", candidateId: "candidate-1", candidateSha256: "1".repeat(64), modelRevision: 7,
    modelHash: "2".repeat(64), frontierItemId: "frontier-1", requestedAt: "2026-07-19T11:59:00Z" }],
};
let renderedReview = "";
let reviewCheckpoint = { ...baseCheckpoint, requestId: reviewRequest.requestId, discordInteractionId: reviewRequest.sourceEventId };
assert.equal(await processEpiphanyOperatorDelivery(reviewDelivery, reviewRequest, reviewCheckpoint,
  async (_app, _token, content) => { renderedReview = content; }, async (next) => { reviewCheckpoint = next; }), "responded");
assert.match(renderedReview, /candidate-1.*request mind-1.*revision 7.*frontier frontier-1/);
assert.doesNotMatch(renderedReview, /proposal|private|sha256/i);
let substitutedCheckpoint = { ...baseCheckpoint };
assert.equal(await processEpiphanyOperatorDelivery({ ...completed, reviews: reviewDelivery.reviews }, request, substitutedCheckpoint,
  async () => { throw new Error("must not render substituted review state"); }, async (next) => { substitutedCheckpoint = next; }), "failed");
assert.match(substitutedCheckpoint.lastError, /non-review/);

const decisionRequest = buildEpiphanyOperatorRequest({
  interactionId: "interaction-decision", actorDiscordId: "owner-1", guildId: "guild-1", channelId: "channel-1",
  command: { kind: "review", mindRequestId: "mind-1", candidateId: "candidate-1", candidateSha256: "1".repeat(64),
    expectedModelRevision: 7, expectedModelHash: "2".repeat(64), decision: "hold" }, issuedAt: "2026-07-19T12:00:00.000Z",
}, "voidbot-yggdrasil");
const decisionDelivery: EpiphanyOperatorDeliveryDocument = {
  ...completed, deliveryId: decisionRequest.requestId, requestId: decisionRequest.requestId, commandId: decisionRequest.commandId,
  discordInteractionId: decisionRequest.sourceEventId, requestPayloadSha256: epiphanyOperatorRequestPayloadSha256(decisionRequest),
  reviewCandidateId: "candidate-1", reviewDecision: "hold",
};
let decisionCheckpoint = { ...baseCheckpoint, requestId: decisionRequest.requestId, discordInteractionId: decisionRequest.sourceEventId };
assert.equal(await processEpiphanyOperatorDelivery({ ...decisionDelivery, reviewCandidateId: "candidate-2" }, decisionRequest, decisionCheckpoint,
  async () => { throw new Error("must not render substituted decision"); }, async (next) => { decisionCheckpoint = next; }), "failed");
assert.match(decisionCheckpoint.lastError, /exact candidate and decision/);

const temp = await mkdtemp(join(tmpdir(), "voidbot-epiphany-delivery-"));
try {
  const bifrostRoot = resolve("../Bifrost");
  const cultlibRoot = resolve("../CultLib");
  const stores = { requestStorePath: join(temp, "requests.cc"), deliveryStorePath: join(temp, "deliveries.cc"), checkpointStorePath: join(temp, "checkpoints.cc"), bifrostRoot, cultlibRoot };
  await registerEpiphanyOperatorInteraction({ requestId: request.requestId, applicationId: "app-1", interactionToken: "private-token", guildId: request.discordGuildId, channelId: request.discordChannelId, registeredAt: request.issuedAt }, stores);
  await submitEpiphanyOperatorRequest({ interactionId: request.requestId, actorDiscordId: request.sourceActorDiscordId, guildId: request.discordGuildId, channelId: request.discordChannelId, command: request.command, issuedAt: request.issuedAt }, { storePath: stores.requestStorePath, bifrostRoot, cultlibRoot, producerRuntimeId: request.producerRuntimeId });
  const cachePackage = resolve(cultlibRoot, "packages/cultcache-ts/package.json");
  const meshPackage = resolve(cultlibRoot, "packages/cultmesh-ts/package.json");
  const define = createRequire(cachePackage)("cultcache-ts").defineDocumentType;
  const CultMesh = createRequire(meshPackage)("cultmesh-ts").CultMesh;
  const deliveryDef = define({ type: "bifrost.discord.epiphany_operator_delivery", schemaName: "bifrost.discord.epiphany_operator_delivery", schemaId: completed.schemaVersion, schemaVersion: completed.schemaVersion, contentHash: completed.schemaVersion, global: false, name: "deliveryId", schema: { parse: (value: unknown) => value } });
  const deliveryNode = await CultMesh.createNode(stores.deliveryStorePath, { documents: [deliveryDef] });
  await deliveryNode.put(deliveryDef, completed.deliveryId, completed);
  let integrationEdits = 0;
  assert.deepEqual(await consumeEpiphanyOperatorDeliveries(stores, async () => { integrationEdits += 1; }), { observed: 1, responded: 1, failed: 0 });
  assert.deepEqual(await consumeEpiphanyOperatorDeliveries(stores, async () => { integrationEdits += 1; }), { observed: 1, responded: 0, failed: 0 });
  assert.equal(integrationEdits, 1);
} finally { await rm(temp, { recursive: true, force: true }); }

console.log("Epiphany operator delivery smoke passed.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
