import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { encode } from "@msgpack/msgpack";

import { EPIPHANY_OPERATOR_REQUEST_SCHEMA, EPIPHANY_OPERATOR_REQUEST_TYPE, EPIPHANY_OPERATOR_RUNTIME_ID, type EpiphanyOperatorRequestDocument } from "./epiphany-operator-request";

export const EPIPHANY_OPERATOR_DELIVERY_TYPE = "bifrost.discord.epiphany_operator_delivery";
export const EPIPHANY_OPERATOR_DELIVERY_SCHEMA = "bifrost.discord.epiphany_operator_delivery.v1";
export const EPIPHANY_OPERATOR_CHECKPOINT_TYPE = "voidbot.private.epiphany_operator_delivery_checkpoint";
export const EPIPHANY_OPERATOR_CHECKPOINT_SCHEMA = "voidbot.private.epiphany_operator_delivery_checkpoint.v0";

const DELIVERY_KEYS = ["schemaVersion", "deliveryId", "requestId", "requestPayloadSha256", "commandId", "discordGuildId", "discordChannelId", "discordInteractionId", "targetRuntimeId", "status", "disposition", "failureCode", "detail", "sealedResultPayloadSha256", "operatorStatus", "stateStatus", "coordinatorAction", "brakeStatus", "executorSignatureSha256", "resultProviderIdentityId", "reviews", "reviewCandidateId", "reviewDecision", "statusV2", "recordedAt", "privateStateExposed"] as const;
const SHA256 = /^sha256-[0-9a-f]{64}$/;

export interface EpiphanyOperatorDeliveryDocument {
  schemaVersion: typeof EPIPHANY_OPERATOR_DELIVERY_SCHEMA;
  deliveryId: string;
  requestId: string;
  requestPayloadSha256: string;
  commandId: string;
  discordGuildId: string;
  discordChannelId: string;
  discordInteractionId: string;
  targetRuntimeId: typeof EPIPHANY_OPERATOR_RUNTIME_ID;
  status: "completed" | "refused";
  disposition: string;
  failureCode: string;
  detail: string;
  operatorStatus: string;
  stateStatus: string;
  coordinatorAction: string;
  brakeStatus: string;
  sealedResultPayloadSha256: string;
  executorSignatureSha256: string;
  resultProviderIdentityId: string;
  reviews: EpiphanyOperatorReviewSummary[];
  reviewCandidateId: string;
  reviewDecision: string;
  statusV2: EpiphanyOperatorStatusV2 | null;
  recordedAt: string;
  privateStateExposed: false;
}

export interface EpiphanyOperatorStatusProviderV2 {
  daemonId: string;
  healthContract: string;
  availability: "authenticated-current" | "unavailable";
  unavailableReason: string;
  state: string | null;
  reasonCode: string | null;
  providerObservedAtUnixMillis: number | null;
  evaluatedAtUnixMillis: number | null;
  expiresAtUnixMillis: number | null;
  releaseId: string | null;
  releaseWitnessSha256: string | null;
  sourceCommit: string | null;
  deploymentId: string | null;
  projectionSha256: string | null;
}
export interface EpiphanyOperatorStatusV2 {
  schemaVersion: "epiphany.operator.status.v2";
  releaseId: string;
  releaseWitnessSha256: string;
  sourceCommit: string;
  deploymentId: string;
  coordinatorSnapshot: string;
  coordinatorState: string;
  coordinatorAction: string;
  brakeStatus: string;
  residentStatus: string;
  pressureCount: number;
  pendingReviewCount: number;
  providerSetStatus: "complete-authenticated" | "incomplete";
  providers: [EpiphanyOperatorStatusProviderV2, EpiphanyOperatorStatusProviderV2];
  privateStateExposed: false;
}

export interface EpiphanyOperatorReviewSummary {
  mindRequestId: string;
  candidateId: string;
  candidateSha256: string;
  modelRevision: number;
  modelHash: string;
  frontierItemId: string;
  requestedAt: string;
}

export interface EpiphanyOperatorDeliveryCheckpoint {
  schemaVersion: typeof EPIPHANY_OPERATOR_CHECKPOINT_SCHEMA;
  requestId: string;
  applicationId: string;
  interactionToken: string;
  discordGuildId: string;
  discordChannelId: string;
  discordInteractionId: string;
  targetRuntimeId: typeof EPIPHANY_OPERATOR_RUNTIME_ID;
  state: "pending" | "responded";
  observedDeliverySha256: string;
  respondedDeliverySha256: string;
  attemptCount: number;
  lastError: string;
  registeredAt: string;
  updatedAt: string;
}

interface MeshNode {
  put: (definition: unknown, key: string, value: unknown) => Promise<void>;
  get: (definition: unknown, key: string) => unknown;
  flush?: () => Promise<void>;
  cache: {
    pullAllBackingStores?: () => Promise<void>;
    getAll: (definition: unknown) => unknown[];
  };
}

export interface EpiphanyOperatorDeliveryStoresConfig {
  requestStorePath: string;
  deliveryStorePath: string;
  checkpointStorePath: string;
  bifrostRoot: string;
  cultlibRoot?: string;
}

export interface RegisterEpiphanyOperatorInteractionInput {
  requestId: string;
  applicationId: string;
  interactionToken: string;
  guildId: string;
  channelId: string;
  registeredAt?: string;
}

export async function registerEpiphanyOperatorInteraction(input: RegisterEpiphanyOperatorInteractionInput, config: Pick<EpiphanyOperatorDeliveryStoresConfig, "checkpointStorePath" | "bifrostRoot" | "cultlibRoot">): Promise<void> {
  const runtime = loadRuntime(config);
  const definition = checkpointDefinition(runtime.defineDocumentType);
  const node = (await runtime.CultMesh.createNode(config.checkpointStorePath, {
    documents: [definition],
  })) as MeshNode;
  await node.cache?.pullAllBackingStores?.();
  const now = input.registeredAt ?? new Date().toISOString();
  const checkpoint: EpiphanyOperatorDeliveryCheckpoint = {
    schemaVersion: EPIPHANY_OPERATOR_CHECKPOINT_SCHEMA,
    requestId: required(input.requestId, "requestId"),
    applicationId: required(input.applicationId, "applicationId"),
    interactionToken: required(input.interactionToken, "interactionToken"),
    discordGuildId: required(input.guildId, "guildId"),
    discordChannelId: required(input.channelId, "channelId"),
    discordInteractionId: required(input.requestId, "requestId"),
    targetRuntimeId: EPIPHANY_OPERATOR_RUNTIME_ID,
    state: "pending",
    observedDeliverySha256: "",
    respondedDeliverySha256: "",
    attemptCount: 0,
    lastError: "",
    registeredAt: now,
    updatedAt: now,
  };
  const existing = unwrap(node.get(definition, checkpoint.requestId));
  if (existing && stable(existing) !== stable(checkpoint)) {
    throw new Error(`Epiphany interaction checkpoint ${checkpoint.requestId} already has different immutable registration.`);
  }
  if (!existing) await node.put(definition, checkpoint.requestId, checkpoint);
  await node.flush?.();
}

export async function consumeEpiphanyOperatorDeliveries(config: EpiphanyOperatorDeliveryStoresConfig, editOriginal: (applicationId: string, interactionToken: string, content: string) => Promise<void>): Promise<{ observed: number; responded: number; failed: number }> {
  const runtime = loadRuntime(config);
  const requestDef = requestDefinition(runtime.defineDocumentType);
  const deliveryDef = deliveryDefinition(runtime.defineDocumentType);
  const checkpointDef = checkpointDefinition(runtime.defineDocumentType);
  const [requests, deliveries, checkpoints] = (await Promise.all([
    runtime.CultMesh.createNode(config.requestStorePath, {
      documents: [requestDef],
    }),
    runtime.CultMesh.createNode(config.deliveryStorePath, {
      documents: [deliveryDef],
    }),
    runtime.CultMesh.createNode(config.checkpointStorePath, {
      documents: [checkpointDef],
    }),
  ])) as MeshNode[];
  await Promise.all([requests, deliveries, checkpoints].map((node) => node.cache?.pullAllBackingStores?.()));
  let observed = 0;
  let responded = 0;
  let failed = 0;
  for (const raw of deliveries.cache.getAll(deliveryDef)) {
    observed += 1;
    const candidate = unwrap(raw);
    const requestId = isRecord(candidate) && typeof candidate.requestId === "string" ? candidate.requestId : "";
    const checkpoint = unwrap(checkpoints.get(checkpointDef, requestId)) as EpiphanyOperatorDeliveryCheckpoint | undefined;
    if (!checkpoint || checkpoint.state === "responded") continue;
    const request = unwrap(requests.get(requestDef, requestId)) as EpiphanyOperatorRequestDocument | undefined;
    const outcome = await processEpiphanyOperatorDelivery(candidate, request, checkpoint, editOriginal, async (next) => {
      await checkpoints.put(checkpointDef, checkpoint.requestId, next);
      await checkpoints.flush?.();
    });
    if (outcome === "responded") responded += 1;
    else if (outcome === "failed") failed += 1;
  }
  return { observed, responded, failed };
}

export async function processEpiphanyOperatorDelivery(candidate: unknown, request: EpiphanyOperatorRequestDocument | undefined, checkpoint: EpiphanyOperatorDeliveryCheckpoint, editOriginal: (applicationId: string, interactionToken: string, content: string) => Promise<void>, saveCheckpoint: (checkpoint: EpiphanyOperatorDeliveryCheckpoint) => Promise<void>): Promise<"responded" | "failed" | "replayed"> {
  if (checkpoint.state === "responded") return "replayed";
  const deliveryHash = hashStable(candidate);
  try {
    if (checkpoint.observedDeliverySha256 && checkpoint.observedDeliverySha256 !== deliveryHash) throw new Error("immutable delivery collision");
    const delivery = validateDelivery(candidate);
    validateBindings(delivery, request, checkpoint);
    const observed = {
      ...checkpoint,
      observedDeliverySha256: deliveryHash,
      updatedAt: new Date().toISOString(),
    };
    await saveCheckpoint(observed);
    await editOriginal(checkpoint.applicationId, checkpoint.interactionToken, renderDelivery(delivery, request!));
    await saveCheckpoint({
      ...observed,
      state: "responded",
      respondedDeliverySha256: deliveryHash,
      attemptCount: checkpoint.attemptCount + 1,
      lastError: "",
      updatedAt: new Date().toISOString(),
    });
    return "responded";
  } catch (error) {
    await saveCheckpoint({
      ...checkpoint,
      observedDeliverySha256: checkpoint.observedDeliverySha256 || deliveryHash,
      attemptCount: checkpoint.attemptCount + 1,
      lastError: boundedError(error),
      updatedAt: new Date().toISOString(),
    });
    return "failed";
  }
}

export function epiphanyOperatorRequestPayloadSha256(request: EpiphanyOperatorRequestDocument): string {
  const compact = request.command.kind === "status" || request.command.kind === "wake" || request.command.kind === "reviews" ? request.command.kind : request.command.kind === "sleep" ? ["sleep", request.command.reason] : request.command.kind === "directive" ? ["directive", request.command.objective] : ["review", [request.command.mindRequestId, request.command.candidateId, request.command.candidateSha256, request.command.expectedModelRevision, request.command.expectedModelHash, request.command.decision]];
  const tuple = [request.schemaName, request.schemaVersion, request.requestId, request.commandId, request.nonce, request.sourceEventId, request.sourceActorDiscordId, request.discordGuildId, request.discordChannelId, request.discordMessageId, request.targetRuntimeId, request.issuedAt, request.expiresAt, request.producerId, request.producerRuntimeId, request.authorityClass, request.status, compact];
  return `sha256-${createHash("sha256").update(encode(tuple)).digest("hex")}`;
}

export function validateDelivery(value: unknown): EpiphanyOperatorDeliveryDocument {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== [...DELIVERY_KEYS].sort().join("\0")) throw new Error("delivery has an inexact field set");
  for (const key of DELIVERY_KEYS) if (key !== "privateStateExposed" && key !== "reviews" && key !== "statusV2" && typeof value[key] !== "string") throw new Error(`delivery ${key} must be a string`);
  if (value.schemaVersion !== EPIPHANY_OPERATOR_DELIVERY_SCHEMA) throw new Error("delivery schema mismatch");
  if (!required(value.deliveryId as string, "deliveryId") || value.deliveryId !== value.requestId) throw new Error("delivery identity mismatch");
  if (!SHA256.test(value.requestPayloadSha256 as string)) throw new Error("request payload digest malformed");
  if (value.targetRuntimeId !== EPIPHANY_OPERATOR_RUNTIME_ID) throw new Error("delivery runtime mismatch");
  if (value.privateStateExposed !== false) throw new Error("delivery exposes private state");
  if (!Array.isArray(value.reviews) || value.reviews.length > 10) throw new Error("delivery reviews must contain at most ten bounded summaries");
  value.reviews.forEach(validateReviewSummary);
  if (typeof value.reviewCandidateId !== "string" || typeof value.reviewDecision !== "string") throw new Error("delivery review disposition bindings must be strings");
  if (typeof value.detail !== "string" || value.detail.length > 512) throw new Error("delivery detail exceeds 512 characters");
  for (const key of ["operatorStatus", "stateStatus", "coordinatorAction", "brakeStatus"] as const) {
    if (typeof value[key] !== "string" || value[key].length > 512) throw new Error(`delivery ${key} exceeds 512 characters`);
  }
  if (!Number.isFinite(Date.parse(value.recordedAt as string))) throw new Error("delivery recordedAt is invalid");
  if (value.status === "completed") {
    if (!required(value.disposition as string, "disposition") || !SHA256.test(value.sealedResultPayloadSha256 as string) || !SHA256.test(value.executorSignatureSha256 as string) || !required(value.resultProviderIdentityId as string, "resultProviderIdentityId")) throw new Error("completed delivery lacks sealed bindings");
    if (value.failureCode !== "") throw new Error("completed delivery has a failure code");
  } else if (value.status === "refused") {
    if (!required(value.failureCode as string, "failureCode")) throw new Error("refused delivery lacks failure code");
    if (value.disposition !== "" || value.operatorStatus !== "" || value.stateStatus !== "" || value.coordinatorAction !== "" || value.brakeStatus !== "" || value.sealedResultPayloadSha256 !== "" || value.executorSignatureSha256 !== "" || value.resultProviderIdentityId !== "" || value.reviews.length || value.reviewCandidateId !== "" || value.reviewDecision !== "" || value.statusV2 !== null) throw new Error("refused delivery carries completed-result bindings");
  } else throw new Error("delivery status is not terminal");
  if (value.statusV2 !== null) validateStatusV2(value.statusV2);
  return value as unknown as EpiphanyOperatorDeliveryDocument;
}

function validateBindings(delivery: EpiphanyOperatorDeliveryDocument, request: EpiphanyOperatorRequestDocument | undefined, checkpoint: EpiphanyOperatorDeliveryCheckpoint): void {
  if (!request || request.schemaName !== EPIPHANY_OPERATOR_REQUEST_TYPE || request.schemaVersion !== EPIPHANY_OPERATOR_REQUEST_SCHEMA) throw new Error("exact operator request is unavailable");
  if (delivery.requestId !== request.requestId || delivery.commandId !== request.commandId || delivery.discordGuildId !== request.discordGuildId || delivery.discordChannelId !== request.discordChannelId || delivery.discordInteractionId !== request.sourceEventId || delivery.targetRuntimeId !== request.targetRuntimeId) throw new Error("delivery does not bind the exact request");
  if (delivery.requestPayloadSha256 !== epiphanyOperatorRequestPayloadSha256(request)) throw new Error("delivery request digest mismatch");
  if (request.command.kind === "reviews") {
    if (delivery.reviewCandidateId !== "" || delivery.reviewDecision !== "") throw new Error("Reviews delivery carries a decision binding");
  } else if (request.command.kind === "review") {
    if (delivery.reviews.length !== 0 || delivery.reviewCandidateId !== request.command.candidateId || delivery.reviewDecision !== request.command.decision) throw new Error("Review delivery does not bind the exact candidate and decision");
  } else if (delivery.reviews.length !== 0 || delivery.reviewCandidateId !== "" || delivery.reviewDecision !== "") {
    throw new Error("non-review delivery carries review state");
  }
  if (request.command.kind === "status") {
    if (delivery.status === "completed" && delivery.statusV2 === null) throw new Error("Status delivery lacks typed statusV2");
  } else if (delivery.statusV2 !== null) throw new Error("non-Status delivery carries statusV2");
  if (checkpoint.requestId !== request.requestId || checkpoint.discordGuildId !== request.discordGuildId || checkpoint.discordChannelId !== request.discordChannelId || checkpoint.discordInteractionId !== request.sourceEventId || checkpoint.targetRuntimeId !== request.targetRuntimeId) throw new Error("private interaction binding mismatch");
}

function renderDelivery(delivery: EpiphanyOperatorDeliveryDocument, request: EpiphanyOperatorRequestDocument): string {
  const command = request.command.kind === "directive" ? "direct" : request.command.kind;
  const headline = delivery.status === "completed" ? `Completed (${delivery.disposition})` : `Refused (${delivery.failureCode})`;
  const detail = delivery.detail ? `\n${delivery.detail}` : "";
  if (request.command.kind === "status" && delivery.status === "completed" && delivery.statusV2) return renderStatusV2(delivery.statusV2);
  const statuses =
    delivery.status === "completed"
      ? [
          ["Coordinator snapshot", delivery.operatorStatus],
          ["State", delivery.stateStatus],
          ["Coordinator action", delivery.coordinatorAction],
          ["Brakes", delivery.brakeStatus],
        ]
          .filter((entry) => entry[1])
          .map(([label, value]) => `${label}: ${value}`)
          .join("\n")
      : "";
  const reviews = request.command.kind === "reviews" && delivery.reviews.length ? `\n${delivery.reviews.map((review) => `- ${review.candidateId} | request ${review.mindRequestId} | revision ${review.modelRevision} | frontier ${review.frontierItemId}`).join("\n")}` : "";
  const decision = request.command.kind === "review" && delivery.reviewCandidateId ? `\nCandidate ${delivery.reviewCandidateId}: ${delivery.reviewDecision}` : "";
  return `Epiphany ${command}: ${headline}.${detail}${statuses ? `\n${statuses}` : ""}${reviews}${decision}\nBifrost reported this terminal result; VoidBot did not execute or inspect Epiphany state.`;
}

function renderStatusV2(value: EpiphanyOperatorStatusV2): string {
  const provider = (label: string, p: EpiphanyOperatorStatusProviderV2) => (p.availability === "unavailable" ? `${label}: unavailable (${bounded(p.unavailableReason)})` : `${label}: authenticated-current | ${bounded(p.state!)} | ${bounded(p.reasonCode!)}`);
  return [`Epiphany status: Completed (observed).`, `Deployment: ${bounded(value.releaseId)} | commit ${value.sourceCommit} | ${bounded(value.deploymentId)}`, `Resident: ${bounded(value.residentStatus)} | Brake: ${bounded(value.brakeStatus)}`, `Pressure: ${value.pressureCount} | Reviews: ${value.pendingReviewCount}`, `Provider set: ${value.providerSetStatus}`, provider("Epiphany", value.providers[0]), provider("Bifrost", value.providers[1]), `Bifrost reported this terminal result; VoidBot did not execute or inspect Epiphany state.`].join("\n");
}
function bounded(value: string): string {
  return value.length <= 96 ? value : `${value.slice(0, 95)}…`;
}

function validateStatusV2(value: unknown): asserts value is EpiphanyOperatorStatusV2 {
  const keys = ["schemaVersion", "releaseId", "releaseWitnessSha256", "sourceCommit", "deploymentId", "coordinatorSnapshot", "coordinatorState", "coordinatorAction", "brakeStatus", "residentStatus", "pressureCount", "pendingReviewCount", "providerSetStatus", "providers", "privateStateExposed"];
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== keys.sort().join("\0")) throw new Error("statusV2 has an inexact field set");
  if (value.schemaVersion !== "epiphany.operator.status.v2" || value.privateStateExposed !== false) throw new Error("statusV2 schema or privacy invariant is invalid");
  for (const k of ["releaseId", "deploymentId", "coordinatorSnapshot", "coordinatorState", "coordinatorAction", "brakeStatus", "residentStatus"]) {
    if (typeof value[k] !== "string" || !value[k] || value[k].length > 256) throw new Error(`statusV2 ${k} is invalid`);
  }
  if (!SHA256.test(value.releaseWitnessSha256) || typeof value.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceCommit)) throw new Error("statusV2 release lineage is invalid");
  for (const k of ["pressureCount", "pendingReviewCount"]) if (!Number.isSafeInteger(value[k]) || value[k] < 0 || value[k] > 1_000_000) throw new Error(`statusV2 ${k} is invalid`);
  if (value.providerSetStatus !== "complete-authenticated" && value.providerSetStatus !== "incomplete") throw new Error("statusV2 provider set is invalid");
  if (!Array.isArray(value.providers) || value.providers.length !== 2) throw new Error("statusV2 requires exactly two providers");
  validateStatusProvider(value.providers[0], "yggdrasil-epiphany", "epiphany.cultnet-rudp-runtime-health", true);
  validateStatusProvider(value.providers[1], "yggdrasil-bifrost-persona-feedback", "bifrost.cultnet-rudp-persona-feedback-health", false);
  if (value.providers.every((p) => p.availability === "authenticated-current") !== (value.providerSetStatus === "complete-authenticated")) throw new Error("statusV2 provider set completeness is false");
}
function validateStatusProvider(value: unknown, daemon: string, contract: string, lineage: boolean): asserts value is EpiphanyOperatorStatusProviderV2 {
  const keys = ["daemonId", "healthContract", "availability", "unavailableReason", "state", "reasonCode", "providerObservedAtUnixMillis", "evaluatedAtUnixMillis", "expiresAtUnixMillis", "releaseId", "releaseWitnessSha256", "sourceCommit", "deploymentId", "projectionSha256"];
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== keys.sort().join("\0")) throw new Error("statusV2 provider has an inexact field set");
  if (value.daemonId !== daemon || value.healthContract !== contract) throw new Error("statusV2 provider policy mismatch");
  if (value.availability !== "authenticated-current" && value.availability !== "unavailable") throw new Error("statusV2 provider availability is invalid");
  if (typeof value.unavailableReason !== "string" || value.unavailableReason.length > 256) throw new Error("statusV2 unavailable reason is invalid");
  const optional = ["state", "reasonCode", "releaseId", "sourceCommit", "deploymentId"] as const;
  for (const k of optional) if (value[k] !== null && (typeof value[k] !== "string" || !value[k] || value[k].length > 256)) throw new Error(`statusV2 provider ${k} is invalid`);
  for (const k of ["providerObservedAtUnixMillis", "evaluatedAtUnixMillis", "expiresAtUnixMillis"] as const) if (value[k] !== null && (!Number.isSafeInteger(value[k]) || value[k] < 0)) throw new Error(`statusV2 provider ${k} is invalid`);
  for (const k of ["releaseWitnessSha256", "projectionSha256"] as const) if (value[k] !== null && !SHA256.test(value[k])) throw new Error(`statusV2 provider ${k} is invalid`);
  if (value.sourceCommit !== null && !/^[0-9a-f]{40}$/.test(value.sourceCommit)) throw new Error("statusV2 provider commit is invalid");
  const observed = [...optional, "providerObservedAtUnixMillis", "evaluatedAtUnixMillis", "expiresAtUnixMillis", "releaseWitnessSha256", "projectionSha256"] as const;
  if (value.availability === "unavailable") {
    if (!value.unavailableReason || observed.some((k) => value[k] !== null)) throw new Error("unavailable provider carries observed state");
  } else {
    if (value.unavailableReason || ["state", "reasonCode", "providerObservedAtUnixMillis", "evaluatedAtUnixMillis", "expiresAtUnixMillis", "projectionSha256"].some((k) => value[k] === null)) throw new Error("authenticated provider lacks bounded state");
    if (lineage) {
      if (["releaseId", "releaseWitnessSha256", "sourceCommit", "deploymentId"].some((k) => value[k] === null)) throw new Error("Epiphany provider lacks lineage");
    } else if (["releaseId", "releaseWitnessSha256", "sourceCommit", "deploymentId"].some((k) => value[k] !== null)) throw new Error("Bifrost provider claims Epiphany lineage");
  }
}

function validateReviewSummary(value: unknown): void {
  const keys = ["mindRequestId", "candidateId", "candidateSha256", "modelRevision", "modelHash", "frontierItemId", "requestedAt"];
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== keys.sort().join("\0")) throw new Error("review summary has an inexact field set");
  for (const key of ["mindRequestId", "candidateId", "frontierItemId"] as const) if (!required(value[key], key) || value[key].length > 256) throw new Error(`review summary ${key} is invalid`);
  for (const key of ["candidateSha256", "modelHash"] as const) if (!/^[0-9a-f]{64}$/.test(value[key])) throw new Error(`review summary ${key} is invalid`);
  if (!Number.isSafeInteger(value.modelRevision) || value.modelRevision < 0) throw new Error("review summary modelRevision is invalid");
  if (!Number.isFinite(Date.parse(value.requestedAt))) throw new Error("review summary requestedAt is invalid");
}

function requestDefinition(define: any): unknown {
  return define({
    type: EPIPHANY_OPERATOR_REQUEST_TYPE,
    schemaName: EPIPHANY_OPERATOR_REQUEST_TYPE,
    schemaId: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
    schemaVersion: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
    contentHash: EPIPHANY_OPERATOR_REQUEST_SCHEMA,
    global: false,
    name: "requestId",
    schema: { parse: (v: unknown) => v },
  });
}
function deliveryDefinition(define: any): unknown {
  return define({
    type: EPIPHANY_OPERATOR_DELIVERY_TYPE,
    schemaName: EPIPHANY_OPERATOR_DELIVERY_TYPE,
    schemaId: EPIPHANY_OPERATOR_DELIVERY_SCHEMA,
    schemaVersion: EPIPHANY_OPERATOR_DELIVERY_SCHEMA,
    contentHash: EPIPHANY_OPERATOR_DELIVERY_SCHEMA,
    global: false,
    name: "deliveryId",
    schema: { parse: (v: unknown) => v },
  });
}
function checkpointDefinition(define: any): unknown {
  return define({
    type: EPIPHANY_OPERATOR_CHECKPOINT_TYPE,
    schemaName: EPIPHANY_OPERATOR_CHECKPOINT_TYPE,
    schemaId: EPIPHANY_OPERATOR_CHECKPOINT_SCHEMA,
    schemaVersion: EPIPHANY_OPERATOR_CHECKPOINT_SCHEMA,
    contentHash: EPIPHANY_OPERATOR_CHECKPOINT_SCHEMA,
    global: false,
    name: "requestId",
    schema: { parse: (v: unknown) => v },
  });
}
function loadRuntime(config: { bifrostRoot: string; cultlibRoot?: string }): any {
  const root = config.cultlibRoot ?? resolve(config.bifrostRoot, "..", "CultLib");
  const mesh = resolve(root, "packages", "cultmesh-ts", "package.json");
  const cache = resolve(root, "packages", "cultcache-ts", "package.json");
  return {
    CultMesh: createRequire(mesh)("cultmesh-ts").CultMesh,
    defineDocumentType: createRequire(cache)("cultcache-ts").defineDocumentType,
  };
}
function unwrap(value: unknown): any {
  const record = value as { value?: unknown } | undefined;
  return Array.isArray(value) ? value[0] : (record?.value ?? value);
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v));
}
function hashStable(value: unknown): string {
  return `sha256-${createHash("sha256").update(stable(value)).digest("hex")}`;
}
function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function required(value: string, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}
function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
