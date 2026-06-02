import { resolve } from "node:path";

import { CultCache, SingleFileMessagePackBackingStore } from "cultcache-ts";

import {
  type VoidCandidateInterventions,
  type VoidFaceAffect,
  type VoidAgencyPressure,
  type VoidModerationCursor,
  type VoidScheduledRuntime,
  type VoidSelfStateOperation,
  type VoidSpeechReceipts,
  type VoidThoughtMemory,
  voidCandidateInterventionsDocument,
  voidFaceAffectDocument,
  voidAgencyPressureDocument,
  voidModerationCursorDocument,
  voidScheduledRuntimeDocument,
  voidSelfProfileDocument,
  voidSelfStateDocumentRegistry,
  voidSelfStateOperationSchema,
  voidSpeechReceiptsDocument,
  voidThoughtMemoryDocument,
} from "./void-self-state-domain";
import {
  createEmptyVoidSelfState,
  normalizeVoidSelfStateIdentityDefaults,
  type VoidSelfStateIdentityDefaults,
  type VoidSelfStateTypedProjection,
} from "./void-self-state-projection";

export interface VoidSelfStateServiceOptions {
  canonicalPath: string;
  identity?: VoidSelfStateIdentityDefaults;
}

export interface VoidSelfStateOperationResult {
  operation: VoidSelfStateOperation["operation"] | "ensure_identity_profile" | "repair_typed_state";
  canonicalPath: string;
  typedDocumentsWritten: number;
}

export async function loadVoidSelfStateTypedDocuments(
  options: VoidSelfStateServiceOptions,
): Promise<VoidSelfStateTypedProjection> {
  const canonicalPath = resolve(options.canonicalPath);
  const cache = createVoidSelfStateCache(canonicalPath);
  await cache.pullAllBackingStores();
  return readTypedStateOrEmpty(cache, options.identity);
}

export async function applyVoidSelfStateOperation(
  options: VoidSelfStateServiceOptions,
  rawOperation: unknown,
): Promise<VoidSelfStateOperationResult> {
  const canonicalPath = resolve(options.canonicalPath);
  const operation = voidSelfStateOperationSchema.parse(rawOperation);
  const cache = createVoidSelfStateCache(canonicalPath);
  await cache.pullAllBackingStores();

  const typedState = readTypedStateOrEmpty(cache, options.identity);
  applyTypedOperation(typedState, operation);
  await writeTypedState(cache, typedState);

  return {
    operation: operation.operation,
    canonicalPath,
    typedDocumentsWritten: 8,
  };
}

export async function ensureVoidSelfStateIdentityProfile(
  options: VoidSelfStateServiceOptions & { identity: VoidSelfStateIdentityDefaults },
): Promise<VoidSelfStateOperationResult> {
  const canonicalPath = resolve(options.canonicalPath);
  const cache = createVoidSelfStateCache(canonicalPath);
  await cache.pullAllBackingStores();

  const typedState = readTypedStateOrEmpty(cache, options.identity);
  repairSelfProfileIdentity(typedState, options.identity);
  await writeTypedState(cache, typedState);

  return {
    operation: "ensure_identity_profile",
    canonicalPath,
    typedDocumentsWritten: 8,
  };
}

export async function repairVoidSelfStateTypedDocuments(
  options: VoidSelfStateServiceOptions,
): Promise<VoidSelfStateOperationResult> {
  const canonicalPath = resolve(options.canonicalPath);
  const cache = createVoidSelfStateCache(canonicalPath);
  await cache.pullAllBackingStores();

  const typedState = readTypedStateOrEmpty(cache, options.identity);
  await writeTypedState(cache, typedState);

  return {
    operation: "repair_typed_state",
    canonicalPath,
    typedDocumentsWritten: 8,
  };
}

function createVoidSelfStateCache(canonicalPath: string): CultCache {
  return CultCache.builder()
    .withRegistry(voidSelfStateDocumentRegistry)
    .withGenericStore(new SingleFileMessagePackBackingStore(canonicalPath))
    .build();
}

function readTypedStateOrEmpty(
  cache: CultCache,
  identity?: VoidSelfStateIdentityDefaults,
): VoidSelfStateTypedProjection {
  const empty = createEmptyVoidSelfState({ identity });
  const state = {
    selfProfile: cache.getGlobal(voidSelfProfileDocument) ?? empty.selfProfile,
    moderationCursor: cache.getGlobal(voidModerationCursorDocument) ?? empty.moderationCursor,
    speechReceipts: cache.getGlobal(voidSpeechReceiptsDocument) ?? empty.speechReceipts,
    thoughtMemory: cache.getGlobal(voidThoughtMemoryDocument) ?? empty.thoughtMemory,
    scheduledRuntime: cache.getGlobal(voidScheduledRuntimeDocument) ?? empty.scheduledRuntime,
    agencyPressure: cache.getGlobal(voidAgencyPressureDocument) ?? empty.agencyPressure,
    candidateInterventions:
      cache.getGlobal(voidCandidateInterventionsDocument) ?? empty.candidateInterventions,
    faceAffect: cache.getGlobal(voidFaceAffectDocument) ?? empty.faceAffect,
  };
  if (identity) {
    repairSelfProfileIdentity(state, identity);
  }
  normalizeDeliveryReceipts(state);
  return state;
}

async function writeTypedState(
  cache: CultCache,
  state: VoidSelfStateTypedProjection,
): Promise<void> {
  normalizeTypedStateForWrite(state);
  normalizeDeliveryReceipts(state);
  await cache.putGlobal(voidSelfProfileDocument, stripUndefined(state.selfProfile));
  await cache.putGlobal(voidModerationCursorDocument, stripUndefined(state.moderationCursor));
  await cache.putGlobal(voidSpeechReceiptsDocument, stripUndefined(state.speechReceipts));
  await cache.putGlobal(voidThoughtMemoryDocument, stripUndefined(state.thoughtMemory));
  await cache.putGlobal(voidScheduledRuntimeDocument, stripUndefined(state.scheduledRuntime));
  await cache.putGlobal(voidAgencyPressureDocument, stripUndefined(state.agencyPressure));
  await cache.putGlobal(voidCandidateInterventionsDocument, stripUndefined(state.candidateInterventions));
  await cache.putGlobal(voidFaceAffectDocument, stripUndefined(state.faceAffect));
}

function repairSelfProfileIdentity(
  state: VoidSelfStateTypedProjection,
  identity: VoidSelfStateIdentityDefaults,
): void {
  identity = normalizeVoidSelfStateIdentityDefaults(identity);
  let changed = false;

  if (state.selfProfile.agentId !== identity.agentId) {
    state.selfProfile.agentId = identity.agentId;
    changed = true;
  }
  if (state.selfProfile.publicName !== identity.publicName) {
    state.selfProfile.publicName = identity.publicName;
    changed = true;
  }
  if (
    identity.publicDescription &&
    state.selfProfile.publicDescription !== identity.publicDescription
  ) {
    state.selfProfile.publicDescription = identity.publicDescription;
    changed = true;
  }

  if (changed) {
    state.selfProfile.updatedAt = new Date().toISOString();
  }
}

function normalizeDeliveryReceipts(state: VoidSelfStateTypedProjection): void {
  const byTarget = new Map<string, VoidSpeechReceipts["recentReceipts"][number]>();
  const noTarget: VoidSpeechReceipts["recentReceipts"] = [];

  for (const receipt of state.speechReceipts.recentReceipts) {
    const targetKey = receipt.channelId && receipt.replyToMessageId
      ? `${receipt.channelId}\u0000${receipt.replyToMessageId}`
      : undefined;
    if (!targetKey) {
      noTarget.push(receipt);
      continue;
    }

    const existing = byTarget.get(targetKey);
    if (!existing || receipt.sentAt.localeCompare(existing.sentAt) < 0) {
      byTarget.set(targetKey, receipt);
    }
  }

  state.speechReceipts.recentReceipts = [...noTarget, ...byTarget.values()]
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .slice(-24);
}

function normalizeTypedStateForWrite(
  state: VoidSelfStateTypedProjection,
  observedAt = new Date().toISOString(),
): void {
  pruneRetiredTypedState(state);

  let thoughtMemoryChanged = false;
  for (const memory of state.thoughtMemory.shortTerm) {
    thoughtMemoryChanged = clampFutureTimestampFields(memory, observedAt, [
      "createdAt",
      "updatedAt",
      "retiredAt",
    ]) || thoughtMemoryChanged;
  }
  if (isFutureTimestamp(state.thoughtMemory.updatedAt, observedAt)) {
    state.thoughtMemory.updatedAt = observedAt;
    thoughtMemoryChanged = true;
  }
  if (thoughtMemoryChanged && isFutureTimestamp(state.thoughtMemory.updatedAt, observedAt)) {
    state.thoughtMemory.updatedAt = observedAt;
  }

  let candidateInterventionsChanged = false;
  for (const intervention of state.candidateInterventions.interventions) {
    candidateInterventionsChanged = normalizeQueuedCandidateIntervention(intervention, observedAt)
      || candidateInterventionsChanged;
    candidateInterventionsChanged = clampFutureTimestampFields(intervention, observedAt, [
      "createdAt",
      "updatedAt",
      "spokenAt",
      "retiredAt",
    ]) || candidateInterventionsChanged;
  }
  if (isFutureTimestamp(state.candidateInterventions.updatedAt, observedAt)) {
    state.candidateInterventions.updatedAt = observedAt;
    candidateInterventionsChanged = true;
  }
  if (candidateInterventionsChanged) {
    state.candidateInterventions.updatedAt = observedAt;
  }
}

function pruneRetiredTypedState(state: VoidSelfStateTypedProjection): void {
  state.moderationCursor.openCases = state.moderationCursor.openCases.filter((entry) =>
    !isTerminalCaseStatus(entry.status)
  );
  state.thoughtMemory.shortTerm = state.thoughtMemory.shortTerm.filter(isNotRetiredEntry);
  state.thoughtMemory.memories = state.thoughtMemory.memories.filter(isNotRetiredEntry);
  state.thoughtMemory.incubation = state.thoughtMemory.incubation.filter(isNotRetiredEntry);
  state.agencyPressure.pressures = state.agencyPressure.pressures.filter(isNotRetiredEntry);
  state.candidateInterventions.interventions = state.candidateInterventions.interventions.filter(isLiveCandidateIntervention);
  state.faceAffect.needs = state.faceAffect.needs.filter(isNotRetiredEntry);
  state.faceAffect.socialBonds = state.faceAffect.socialBonds.filter(isNotRetiredEntry);
  state.faceAffect.statusReads = state.faceAffect.statusReads.filter(isNotRetiredEntry);
  state.faceAffect.doctrineStances = state.faceAffect.doctrineStances.filter(isNotRetiredEntry);
}

function isNotRetiredEntry(entry: { status?: string; retiredAt?: string }): boolean {
  return entry.status !== "retired" && !entry.retiredAt;
}

function isLiveCandidateIntervention(entry: { status?: string; retiredAt?: string }): boolean {
  return (entry.status === "queued" || entry.status === "deferred") && !entry.retiredAt;
}

function clampFutureTimestampFields<T extends Record<string, unknown>>(
  value: T,
  observedAt: string,
  fields: string[],
): boolean {
  let changed = false;
  for (const field of fields) {
    const timestamp = value[field];
    if (typeof timestamp === "string" && isFutureTimestamp(timestamp, observedAt)) {
      value[field as keyof T] = observedAt as T[keyof T];
      changed = true;
    }
  }
  return changed;
}

function isFutureTimestamp(timestamp: string, observedAt: string): boolean {
  const timestampMs = Date.parse(timestamp);
  const observedAtMs = Date.parse(observedAt);
  return Number.isFinite(timestampMs) &&
    Number.isFinite(observedAtMs) &&
    timestampMs > observedAtMs;
}

function applyTypedOperation(
  state: VoidSelfStateTypedProjection,
  operation: VoidSelfStateOperation,
): void {
  const appliedAt = new Date().toISOString();
  switch (operation.operation) {
    case "record_reviewed_messages":
      state.moderationCursor.lastReviewedMessageId = operation.lastReviewedMessageId;
      state.moderationCursor.lastReviewedTimestamp = operation.lastReviewedTimestamp;
      state.moderationCursor.updatedAt = operation.lastReviewedTimestamp;
      return;
    case "upsert_open_case":
      upsertBy(
        state.moderationCursor.openCases,
        operation.case,
        (entry) => entry.sourceMessageId,
      );
      state.moderationCursor.updatedAt = operation.case.lastTouchedAt;
      return;
    case "close_open_case":
      closeTypedOpenCase(state.moderationCursor, operation);
      return;
    case "update_repo_activity_cursor":
      upsertBy(state.moderationCursor.repoActivityCursor, operation.cursor, (entry) => entry.repo.toLowerCase());
      state.moderationCursor.updatedAt = operation.cursor.updatedAt;
      return;
    case "record_delivery_receipt":
      upsertBy(state.speechReceipts.recentReceipts, operation.receipt, (entry) => entry.receiptKey);
      state.speechReceipts.recentReceipts = state.speechReceipts.recentReceipts
        .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
        .slice(-24);
      state.speechReceipts.updatedAt = operation.receipt.sentAt;
      closeCasesForReceipt(state.moderationCursor, operation.receipt);
      return;
    case "retire_delivery_receipts":
      retireDeliveryReceipts(state.speechReceipts, operation);
      return;
    case "record_short_term_memory":
      recordShortTermMemory(
        state.thoughtMemory,
        normalizeShortTermMemoryOperation(state.thoughtMemory, operation.memory, appliedAt),
      );
      state.thoughtMemory.shortTerm = state.thoughtMemory.shortTerm
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(-48);
      state.thoughtMemory.updatedAt = appliedAt;
      return;
    case "prune_short_term_memories":
      state.thoughtMemory.shortTerm = state.thoughtMemory.shortTerm.filter(
        (entry) => !operation.sourceMemoryIds.includes(entry.memoryId),
      );
      state.thoughtMemory.updatedAt = operation.prunedAt;
      return;
    case "revise_durable_memory":
      upsertBy(state.thoughtMemory.memories, operation.memory, (entry) => entry.memoryId);
      retireSourceMemories(state, operation.sourceMemoryIds, operation.memory.memoryId, operation.revisedAt, operation.reason);
      state.thoughtMemory.updatedAt = operation.revisedAt;
      return;
    case "retire_durable_memory":
      retireDurableMemory(state, operation.memoryId, operation.retiredAt, operation.reason);
      state.thoughtMemory.updatedAt = operation.retiredAt;
      return;
    case "crystallize_memory_into_identity":
      upsertBy(state.thoughtMemory.memories, operation.memory, (entry) => entry.memoryId);
      retireSourceMemories(state, operation.sourceMemoryIds, operation.memory.memoryId, operation.crystallizedAt, operation.reason);
      if (operation.value) {
        upsertBy(state.selfProfile.values, operation.value, (entry) => entry.id);
        state.selfProfile.values = state.selfProfile.values
          .sort((left, right) => right.priority - left.priority)
          .slice(0, 24);
      }
      if (operation.privateNote) {
        state.selfProfile.privateNotes = [...state.selfProfile.privateNotes, operation.privateNote].slice(-24);
      }
      state.selfProfile.updatedAt = operation.crystallizedAt;
      state.thoughtMemory.updatedAt = operation.crystallizedAt;
      return;
    case "merge_incubation_support":
      upsertBy(state.thoughtMemory.incubation, operation.thread, (entry) => entry.threadId);
      state.thoughtMemory.updatedAt = operation.thread.updatedAt;
      return;
    case "queue_candidate_intervention":
      upsertBy(
        state.candidateInterventions.interventions,
        normalizeCandidateInterventionOperation(state.candidateInterventions, operation.intervention, appliedAt),
        (entry) => entry.interventionId,
      );
      state.candidateInterventions.updatedAt = appliedAt;
      return;
    case "retire_candidate_intervention":
      retireCandidateIntervention(state.candidateInterventions, operation);
      return;
    case "mark_candidate_intervention_spoken":
      markCandidateInterventionSpoken(state, operation);
      return;
    case "upsert_agency_pressure":
      upsertBy(state.agencyPressure.pressures, operation.pressure, (entry) => entry.pressureId);
      state.agencyPressure.pressures = state.agencyPressure.pressures
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(-64);
      state.agencyPressure.updatedAt = operation.pressure.updatedAt;
      return;
    case "retire_agency_pressure":
      retireAgencyPressure(state.agencyPressure, operation);
      return;
    case "upsert_affect_need":
      upsertBy(state.faceAffect.needs, operation.need, (entry) => entry.needId);
      state.faceAffect.needs = state.faceAffect.needs
        .sort((left, right) => right.intensity - left.intensity)
        .slice(0, 24);
      state.faceAffect.updatedAt = operation.need.updatedAt;
      return;
    case "retire_affect_need":
      retireAffectNeed(state.faceAffect, operation);
      return;
    case "upsert_social_bond":
      upsertBy(state.faceAffect.socialBonds, operation.bond, (entry) => entry.bondId);
      state.faceAffect.socialBonds = state.faceAffect.socialBonds
        .sort((left, right) => right.intensity - left.intensity)
        .slice(0, 24);
      state.faceAffect.updatedAt = operation.bond.updatedAt;
      return;
    case "retire_social_bond":
      retireSocialBond(state.faceAffect, operation);
      return;
    case "upsert_status_read":
      upsertBy(state.faceAffect.statusReads, operation.read, (entry) => entry.readId);
      state.faceAffect.statusReads = state.faceAffect.statusReads
        .sort((left, right) => right.intensity - left.intensity)
        .slice(0, 24);
      state.faceAffect.updatedAt = operation.read.updatedAt;
      return;
    case "retire_status_read":
      retireStatusRead(state.faceAffect, operation);
      return;
    case "update_mood_dimensions":
      for (const dimension of operation.dimensions) {
        upsertBy(state.faceAffect.moodDimensions, dimension, (entry) => entry.name);
      }
      state.faceAffect.moodDimensions = state.faceAffect.moodDimensions
        .sort((left, right) => right.value - left.value)
        .slice(0, 32);
      state.faceAffect.updatedAt = operation.updatedAt;
      return;
    case "update_social_biases":
      for (const bias of operation.biases) {
        upsertBy(state.faceAffect.socialBiases, bias, (entry) => entry.name);
      }
      state.faceAffect.socialBiases = state.faceAffect.socialBiases
        .sort((left, right) => right.value - left.value)
        .slice(0, 24);
      state.faceAffect.updatedAt = operation.updatedAt;
      return;
    case "upsert_doctrine_stance":
      upsertBy(state.faceAffect.doctrineStances, operation.stance, (entry) => entry.stanceId);
      state.faceAffect.doctrineStances = state.faceAffect.doctrineStances
        .sort((left, right) => right.intensity - left.intensity)
        .slice(0, 48);
      state.faceAffect.updatedAt = operation.stance.updatedAt;
      return;
    case "retire_doctrine_stance":
      retireDoctrineStance(state.faceAffect, operation);
      return;
    case "update_sleep_cycle":
      state.scheduledRuntime.sleepCycle = operation.sleepCycle;
      state.scheduledRuntime.updatedAt = new Date().toISOString();
      return;
    case "update_speaking_pressure":
      state.scheduledRuntime.speakingPressure = operation.speakingPressure;
      state.scheduledRuntime.updatedAt = new Date().toISOString();
      return;
    case "propose_memory_distillation":
      return;
    case "apply_memory_distillation":
      upsertBy(state.thoughtMemory.memories, operation.memory, (entry) => entry.memoryId);
      retireSourceMemories(state, operation.sourceMemoryIds, operation.memory.memoryId, operation.appliedAt, "distilled into replacement memory");
      state.thoughtMemory.shortTerm = state.thoughtMemory.shortTerm.filter(
        (entry) => !operation.sourceMemoryIds.includes(entry.memoryId),
      );
      state.thoughtMemory.updatedAt = operation.appliedAt;
      return;
  }
}

function normalizeShortTermMemoryOperation(
  thoughtMemory: VoidThoughtMemory,
  memory: VoidThoughtMemory["shortTerm"][number],
  appliedAt: string,
): VoidThoughtMemory["shortTerm"][number] {
  const existing = thoughtMemory.shortTerm.find((entry) => entry.memoryId === memory.memoryId);
  return {
    ...memory,
    createdAt: existing?.createdAt ?? appliedAt,
    updatedAt: appliedAt,
  };
}

function normalizeCandidateInterventionOperation(
  candidates: VoidCandidateInterventions,
  intervention: VoidCandidateInterventions["interventions"][number],
  appliedAt: string,
): VoidCandidateInterventions["interventions"][number] {
  const existing = candidates.interventions.find((entry) => entry.interventionId === intervention.interventionId);
  const normalized = {
    ...intervention,
    createdAt: existing?.createdAt ?? appliedAt,
    updatedAt: appliedAt,
  };
  normalizeQueuedCandidateIntervention(normalized, appliedAt);
  return normalized;
}

function normalizeQueuedCandidateIntervention(
  intervention: VoidCandidateInterventions["interventions"][number],
  observedAt: string,
): boolean {
  if (intervention.status !== "queued" || intervention.deliveryTarget) {
    return false;
  }
  intervention.status = "deferred";
  intervention.updatedAt = observedAt;
  intervention.tags = Array.from(new Set([
    ...intervention.tags,
    "normalized:targetless-queued-to-deferred",
  ]));
  return true;
}

function recordShortTermMemory(
  thoughtMemory: VoidThoughtMemory,
  memory: VoidThoughtMemory["shortTerm"][number],
): void {
  const exactIndex = thoughtMemory.shortTerm.findIndex((entry) => entry.memoryId === memory.memoryId);
  if (exactIndex !== -1) {
    thoughtMemory.shortTerm[exactIndex] = memory;
    return;
  }

  const clusterIndex = thoughtMemory.shortTerm.findIndex((entry) => shouldClusterShortTermMemory(entry, memory));
  if (clusterIndex === -1) {
    thoughtMemory.shortTerm.push(memory);
    return;
  }

  thoughtMemory.shortTerm[clusterIndex] = mergeShortTermMemoryCluster(
    thoughtMemory.shortTerm[clusterIndex],
    memory,
  );
}

function shouldClusterShortTermMemory(
  existing: VoidThoughtMemory["shortTerm"][number],
  incoming: VoidThoughtMemory["shortTerm"][number],
): boolean {
  const sharedTags = getSharedNormalizedTags(existing.tags, incoming.tags);
  const sharedTopicCount = sharedTags.filter((tag) => tag.startsWith("topic:")).length;
  const sharedRepoCount = sharedTags.filter((tag) => tag.startsWith("repo:")).length;
  const sameTarget =
    existing.target.kind === incoming.target.kind &&
    existing.target.id.toLowerCase() === incoming.target.id.toLowerCase();

  if (sameTarget && (sharedTopicCount > 0 || sharedTags.length >= 2)) {
    return true;
  }

  if (sharedTopicCount > 0 && sharedRepoCount > 0) {
    return true;
  }

  return sharedTopicCount >= 2;
}

function mergeShortTermMemoryCluster(
  existing: VoidThoughtMemory["shortTerm"][number],
  incoming: VoidThoughtMemory["shortTerm"][number],
): VoidThoughtMemory["shortTerm"][number] {
  return {
    ...incoming,
    memoryId: existing.memoryId,
    createdAt: earlierTimestamp(existing.createdAt, incoming.createdAt),
    anchorRefs: mergeRefs(existing.anchorRefs, incoming.anchorRefs),
    evidenceRefs: mergeRefs(existing.evidenceRefs, incoming.evidenceRefs),
    tags: mergeTags(existing.tags, incoming.tags, "cluster:short-term"),
  };
}

function getSharedNormalizedTags(left: string[], right: string[]): string[] {
  const leftTags = new Set(left.map(normalizeTag));
  return Array.from(new Set(right.map(normalizeTag).filter((tag) => leftTags.has(tag))));
}

function mergeRefs<T extends { ref: string }>(left: T[], right: T[]): T[] {
  const refs = new Map<string, T>();
  for (const entry of [...left, ...right]) {
    refs.set(entry.ref, entry);
  }
  return Array.from(refs.values());
}

function mergeTags(left: string[], right: string[], extraTag: string): string[] {
  const tags = new Map<string, string>();
  for (const tag of [...left, ...right, extraTag]) {
    tags.set(normalizeTag(tag), tag);
  }
  return Array.from(tags.values());
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function earlierTimestamp(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? left : right;
}

function retireSourceMemories(
  state: VoidSelfStateTypedProjection,
  sourceMemoryIds: string[],
  replacementMemoryId: string,
  retiredAt: string,
  reason: string,
): void {
  for (const sourceMemoryId of sourceMemoryIds) {
    if (sourceMemoryId === replacementMemoryId) {
      continue;
    }
    retireDurableMemory(state, sourceMemoryId, retiredAt, reason);
  }
}

function retireDurableMemory(
  state: VoidSelfStateTypedProjection,
  memoryId: string,
  retiredAt: string,
  reason: string,
): void {
  const memory = state.thoughtMemory.memories.find((entry) => entry.memoryId === memoryId);
  if (!memory) {
    return;
  }
  memory.retiredAt = retiredAt;
  memory.updatedAt = retiredAt;
  memory.tags = Array.from(new Set([...memory.tags, `retired:${reason}`]));
}

function closeTypedOpenCase(
  cursor: VoidModerationCursor,
  operation: Extract<VoidSelfStateOperation, { operation: "close_open_case" }>,
): void {
  for (const openCase of cursor.openCases) {
    if (openCase.sourceMessageId !== operation.sourceMessageId) {
      continue;
    }
    openCase.status = operation.status;
    openCase.resolvedAt = operation.resolvedAt;
    openCase.lastTouchedAt = operation.resolvedAt;
    openCase.resolutionSummary = operation.resolutionSummary;
    normalizeAnsweredOpenCaseSummary(openCase);
  }
  cursor.updatedAt = operation.resolvedAt;
}

function retireAgencyPressure(
  agencyPressure: VoidAgencyPressure,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_agency_pressure" }>,
): void {
  const pressure = agencyPressure.pressures.find((entry) => entry.pressureId === operation.pressureId);
  if (pressure) {
    pressure.status = "retired";
    pressure.retiredAt = operation.retiredAt;
    pressure.updatedAt = operation.retiredAt;
    pressure.tags = Array.from(new Set([...pressure.tags, `retired:${operation.reason}`]));
  }
  agencyPressure.updatedAt = operation.retiredAt;
}

function retireAffectNeed(
  faceAffect: VoidFaceAffect,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_affect_need" }>,
): void {
  const need = faceAffect.needs.find((entry) => entry.needId === operation.needId);
  if (need) {
    need.status = "retired";
    need.retiredAt = operation.retiredAt;
    need.updatedAt = operation.retiredAt;
    need.tags = Array.from(new Set([...need.tags, `retired:${operation.reason}`]));
  }
  faceAffect.updatedAt = operation.retiredAt;
}

function retireSocialBond(
  faceAffect: VoidFaceAffect,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_social_bond" }>,
): void {
  const bond = faceAffect.socialBonds.find((entry) => entry.bondId === operation.bondId);
  if (bond) {
    bond.status = "retired";
    bond.retiredAt = operation.retiredAt;
    bond.updatedAt = operation.retiredAt;
    bond.tags = Array.from(new Set([...bond.tags, `retired:${operation.reason}`]));
  }
  faceAffect.updatedAt = operation.retiredAt;
}

function retireStatusRead(
  faceAffect: VoidFaceAffect,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_status_read" }>,
): void {
  const read = faceAffect.statusReads.find((entry) => entry.readId === operation.readId);
  if (read) {
    read.retiredAt = operation.retiredAt;
    read.updatedAt = operation.retiredAt;
    read.tags = Array.from(new Set([...read.tags, `retired:${operation.reason}`]));
  }
  faceAffect.updatedAt = operation.retiredAt;
}

function retireDoctrineStance(
  faceAffect: VoidFaceAffect,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_doctrine_stance" }>,
): void {
  const stance = faceAffect.doctrineStances.find((entry) => entry.stanceId === operation.stanceId);
  if (stance) {
    stance.status = "retired";
    stance.retiredAt = operation.retiredAt;
    stance.updatedAt = operation.retiredAt;
    stance.tags = Array.from(new Set([...stance.tags, `retired:${operation.reason}`]));
  }
  faceAffect.updatedAt = operation.retiredAt;
}

function closeCasesForReceipt(
  cursor: VoidModerationCursor,
  receipt: VoidSpeechReceipts["recentReceipts"][number],
): void {
  if (!receipt.replyToMessageId) {
    return;
  }

  for (const openCase of cursor.openCases) {
    if (openCase.sourceMessageId !== receipt.replyToMessageId) {
      continue;
    }
    if (isTerminalCaseStatus(openCase.status)) {
      normalizeAnsweredOpenCaseSummary(openCase);
      continue;
    }
    openCase.status = "answered";
    openCase.resolvedAt = receipt.sentAt;
    openCase.lastTouchedAt = receipt.sentAt;
    openCase.resolutionSummary = receipt.preview
      ? `Answered in-channel: ${receipt.preview}`
      : "Answered in-channel.";
    normalizeAnsweredOpenCaseSummary(openCase);
  }
  cursor.updatedAt = receipt.sentAt;
}

function normalizeAnsweredOpenCaseSummary(
  openCase: VoidModerationCursor["openCases"][number],
): void {
  if (openCase.status !== "answered") {
    return;
  }

  openCase.summary = openCase.summary
    .replace(/\bVoid has not answered yet\b\.?/i, "Void answered in-channel.")
    .replace(/\band Void answered in-channel\./i, "and Void answered in-channel.");
}

function retireCandidateIntervention(
  candidates: VoidCandidateInterventions,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_candidate_intervention" }>,
): void {
  for (const intervention of candidates.interventions) {
    if (intervention.interventionId !== operation.interventionId) {
      continue;
    }
    intervention.status = "retired";
    intervention.retiredAt = operation.retiredAt;
    intervention.updatedAt = operation.retiredAt;
    intervention.tags = [...new Set([...intervention.tags, `retired:${operation.reason}`])];
  }
  candidates.updatedAt = operation.retiredAt;
}

function markCandidateInterventionSpoken(
  state: VoidSelfStateTypedProjection,
  operation: Extract<VoidSelfStateOperation, { operation: "mark_candidate_intervention_spoken" }>,
): void {
  upsertBy(state.speechReceipts.recentReceipts, operation.receipt, (entry) => entry.receiptKey);
  state.speechReceipts.recentReceipts = state.speechReceipts.recentReceipts
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .slice(-24);
  state.speechReceipts.updatedAt = operation.receipt.sentAt;
  closeCasesForReceipt(state.moderationCursor, operation.receipt);

  for (const intervention of state.candidateInterventions.interventions) {
    if (intervention.interventionId !== operation.interventionId) {
      continue;
    }
    intervention.status = "spoken";
    intervention.spokenAt = operation.receipt.sentAt;
    intervention.updatedAt = operation.receipt.sentAt;
  }
  retireSiblingCandidatesForReceipt(state.candidateInterventions, operation);
  state.candidateInterventions.updatedAt = operation.receipt.sentAt;
}

function retireDeliveryReceipts(
  speechReceipts: VoidSpeechReceipts,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_delivery_receipts" }>,
): void {
  const receiptKeys = new Set(operation.receiptKeys);
  speechReceipts.recentReceipts = speechReceipts.recentReceipts.filter(
    (receipt) => !receiptKeys.has(receipt.receiptKey),
  );
  speechReceipts.updatedAt = operation.retiredAt;
}

function retireSiblingCandidatesForReceipt(
  candidates: VoidCandidateInterventions,
  operation: Extract<VoidSelfStateOperation, { operation: "mark_candidate_intervention_spoken" }>,
): void {
  const { receipt } = operation;
  if (!receipt.replyToMessageId) {
    return;
  }

  for (const intervention of candidates.interventions) {
    if (
      intervention.interventionId === operation.interventionId ||
      intervention.status !== "queued" ||
      intervention.spokenAt ||
      !candidateDeliveryTargetMatchesReceipt(intervention.deliveryTarget, receipt)
    ) {
      continue;
    }

    intervention.status = "retired";
    intervention.retiredAt = receipt.sentAt;
    intervention.updatedAt = receipt.sentAt;
    intervention.tags = Array.from(new Set([...intervention.tags, "retired:duplicate reply target already answered"]));
  }
}

function candidateDeliveryTargetMatchesReceipt(
  deliveryTarget: VoidCandidateInterventions["interventions"][number]["deliveryTarget"],
  receipt: VoidSpeechReceipts["recentReceipts"][number],
): boolean {
  return (
    deliveryTarget?.mode === "channel" &&
    deliveryTarget.channelId === receipt.channelId &&
    deliveryTarget.replyToMessageId === receipt.replyToMessageId
  );
}

function upsertBy<T>(entries: T[], value: T, keyOf: (value: T) => string): void {
  const key = keyOf(value);
  const index = entries.findIndex((entry) => keyOf(entry) === key);
  if (index === -1) {
    entries.push(value);
  } else {
    entries[index] = value;
  }
}

function isTerminalCaseStatus(status: string): boolean {
  return ["answered", "resolved", "closed", "retired", "dropped"].includes(status);
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as T;
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    next[key] = stripUndefined(child);
  }

  return next as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
