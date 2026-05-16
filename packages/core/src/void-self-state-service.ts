import { resolve } from "node:path";

import { CultCache, SingleFileMessagePackBackingStore } from "cultcache-ts";

import {
  loadModerationState,
  moderationStateDocument,
  saveModerationState,
  type ModerationState,
} from "./moderation-state-store";
import {
  type VoidCandidateInterventions,
  type VoidModerationCursor,
  type VoidScheduledRuntime,
  type VoidSelfStateOperation,
  type VoidSpeechReceipts,
  type VoidThoughtMemory,
  voidCandidateInterventionsDocument,
  voidModerationCursorDocument,
  voidScheduledRuntimeDocument,
  voidSelfProfileDocument,
  voidSelfStateDocumentRegistry,
  voidSelfStateOperationSchema,
  voidSpeechReceiptsDocument,
  voidThoughtMemoryDocument,
} from "./void-self-state-domain";
import {
  projectModerationStateToTypedSelfState,
  type VoidSelfStateTypedProjection,
} from "./void-self-state-projection";

type JsonObject = Record<string, unknown>;

export interface VoidSelfStateServiceOptions {
  canonicalPath: string;
}

export interface VoidSelfStateOperationResult {
  operation: VoidSelfStateOperation["operation"];
  canonicalPath: string;
  typedDocumentsWritten: number;
  legacyCompatibilityUpdated: boolean;
}

export async function applyVoidSelfStateOperation(
  options: VoidSelfStateServiceOptions,
  rawOperation: unknown,
): Promise<VoidSelfStateOperationResult> {
  const canonicalPath = resolve(options.canonicalPath);
  const operation = voidSelfStateOperationSchema.parse(rawOperation);
  const cache = createVoidSelfStateCache(canonicalPath);
  await cache.pullAllBackingStores();

  const legacyState = await loadModerationState(canonicalPath);
  const typedState = readOrProjectTypedState(cache, legacyState);
  applyTypedOperation(typedState, operation);
  await writeTypedState(cache, typedState);

  const legacyCompatibilityUpdated = applyLegacyCompatibilityOperation(legacyState, operation);
  if (legacyCompatibilityUpdated) {
    await saveModerationState(canonicalPath, legacyState);
  }

  return {
    operation: operation.operation,
    canonicalPath,
    typedDocumentsWritten: 6,
    legacyCompatibilityUpdated,
  };
}

function createVoidSelfStateCache(canonicalPath: string): CultCache {
  return CultCache.builder()
    .withDocumentType(moderationStateDocument)
    .withRegistry(voidSelfStateDocumentRegistry)
    .withGenericStore(new SingleFileMessagePackBackingStore(canonicalPath))
    .build();
}

function readOrProjectTypedState(
  cache: CultCache,
  legacyState: ModerationState,
): VoidSelfStateTypedProjection {
  const projected = projectModerationStateToTypedSelfState(legacyState);
  return {
    selfProfile: cache.getGlobal(voidSelfProfileDocument) ?? projected.selfProfile,
    moderationCursor: cache.getGlobal(voidModerationCursorDocument) ?? projected.moderationCursor,
    speechReceipts: cache.getGlobal(voidSpeechReceiptsDocument) ?? projected.speechReceipts,
    thoughtMemory: cache.getGlobal(voidThoughtMemoryDocument) ?? projected.thoughtMemory,
    scheduledRuntime: cache.getGlobal(voidScheduledRuntimeDocument) ?? projected.scheduledRuntime,
    candidateInterventions:
      cache.getGlobal(voidCandidateInterventionsDocument) ?? projected.candidateInterventions,
  };
}

async function writeTypedState(
  cache: CultCache,
  state: VoidSelfStateTypedProjection,
): Promise<void> {
  await cache.putGlobal(voidSelfProfileDocument, stripUndefined(state.selfProfile));
  await cache.putGlobal(voidModerationCursorDocument, stripUndefined(state.moderationCursor));
  await cache.putGlobal(voidSpeechReceiptsDocument, stripUndefined(state.speechReceipts));
  await cache.putGlobal(voidThoughtMemoryDocument, stripUndefined(state.thoughtMemory));
  await cache.putGlobal(voidScheduledRuntimeDocument, stripUndefined(state.scheduledRuntime));
  await cache.putGlobal(voidCandidateInterventionsDocument, stripUndefined(state.candidateInterventions));
}

function applyTypedOperation(
  state: VoidSelfStateTypedProjection,
  operation: VoidSelfStateOperation,
): void {
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
    case "append_distilled_memory":
      upsertBy(state.thoughtMemory.memories, operation.memory, (entry) => entry.memoryId);
      state.thoughtMemory.updatedAt = operation.memory.updatedAt;
      return;
    case "merge_incubation_support":
      upsertBy(state.thoughtMemory.incubation, operation.thread, (entry) => entry.threadId);
      state.thoughtMemory.updatedAt = operation.thread.updatedAt;
      return;
    case "queue_candidate_intervention":
      upsertBy(state.candidateInterventions.interventions, operation.intervention, (entry) => entry.interventionId);
      state.candidateInterventions.updatedAt = operation.intervention.updatedAt;
      return;
    case "retire_candidate_intervention":
      retireCandidateIntervention(state.candidateInterventions, operation);
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
      state.thoughtMemory.memories = state.thoughtMemory.memories.filter(
        (entry) => !operation.sourceMemoryIds.includes(entry.memoryId) || entry.memoryId === operation.memory.memoryId,
      );
      state.thoughtMemory.updatedAt = operation.appliedAt;
      return;
  }
}

function applyLegacyCompatibilityOperation(
  legacyState: ModerationState,
  operation: VoidSelfStateOperation,
): boolean {
  const legacy = legacyState as unknown as JsonObject;
  const runtime = ensureObject(legacy, "moderation_runtime");

  switch (operation.operation) {
    case "record_reviewed_messages":
      runtime.cursor = {
        lastReviewedMessageId: operation.lastReviewedMessageId,
        lastReviewedTimestamp: operation.lastReviewedTimestamp,
      };
      return true;
    case "upsert_open_case":
      upsertLegacyRuntimeArray(runtime, "open_cases", operation.case, "sourceMessageId");
      return true;
    case "close_open_case":
      closeLegacyOpenCase(runtime, operation);
      return true;
    case "update_repo_activity_cursor": {
      const repoCursor = ensureObject(runtime, "repo_activity_cursor");
      repoCursor[operation.cursor.repo] = {
        lastSeenHash: operation.cursor.lastCommitSha ?? null,
        lastSeenCommittedAt: operation.cursor.lastCommitAt ?? null,
        lastInjectedAt: operation.cursor.updatedAt,
      };
      return true;
    }
    case "record_delivery_receipt":
      upsertLegacyRuntimeArray(runtime, "recent_delivery_receipts", operation.receipt, "receiptKey");
      closeLegacyOpenCaseForReceipt(runtime, operation.receipt);
      return true;
    case "queue_candidate_intervention":
      upsertLegacyRuntimeArray(runtime, "candidate_interventions", operation.intervention, "interventionId");
      return true;
    case "retire_candidate_intervention":
      retireLegacyCandidate(runtime, operation);
      return true;
    case "update_sleep_cycle":
      runtime.sleep_cycle = operation.sleepCycle;
      return true;
    case "update_speaking_pressure":
      runtime.speaking_bias = operation.speakingPressure;
      return true;
    case "append_distilled_memory":
    case "apply_memory_distillation":
      upsertLegacyMemory(legacy, operation.memory);
      return true;
    case "merge_incubation_support":
      ensureObject(runtime, "incubation");
      upsertLegacyNestedArray(runtime, ["incubation"], "active_thoughts", operation.thread, "threadId");
      return true;
    case "propose_memory_distillation":
      return false;
  }
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
  }
  cursor.updatedAt = operation.resolvedAt;
}

function closeCasesForReceipt(
  cursor: VoidModerationCursor,
  receipt: VoidSpeechReceipts["recentReceipts"][number],
): void {
  if (!receipt.replyToMessageId) {
    return;
  }

  for (const openCase of cursor.openCases) {
    if (openCase.sourceMessageId !== receipt.replyToMessageId || isTerminalCaseStatus(openCase.status)) {
      continue;
    }
    openCase.status = "answered";
    openCase.resolvedAt = receipt.sentAt;
    openCase.lastTouchedAt = receipt.sentAt;
    openCase.resolutionSummary = receipt.preview
      ? `Answered in-channel: ${receipt.preview}`
      : "Answered in-channel.";
  }
  cursor.updatedAt = receipt.sentAt;
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

function upsertBy<T>(entries: T[], value: T, keyOf: (value: T) => string): void {
  const key = keyOf(value);
  const index = entries.findIndex((entry) => keyOf(entry) === key);
  if (index === -1) {
    entries.push(value);
  } else {
    entries[index] = value;
  }
}

function upsertLegacyRuntimeArray(
  runtime: JsonObject,
  key: string,
  value: unknown,
  idKey: string,
): void {
  const entries = readObjectArray(runtime[key]);
  const id = isObject(value) ? readString(value, idKey) : undefined;
  if (!id) {
    return;
  }
  const index = entries.findIndex((entry) => readString(entry, idKey) === id);
  if (index === -1) {
    entries.push(value as JsonObject);
  } else {
    entries[index] = value as JsonObject;
  }
  runtime[key] = entries;
}

function upsertLegacyNestedArray(
  root: JsonObject,
  objectPath: string[],
  key: string,
  value: unknown,
  idKey: string,
): void {
  let container = root;
  for (const segment of objectPath) {
    container = ensureObject(container, segment);
  }
  upsertLegacyRuntimeArray(container, key, value, idKey);
}

function closeLegacyOpenCase(
  runtime: JsonObject,
  operation: Extract<VoidSelfStateOperation, { operation: "close_open_case" }>,
): void {
  const entries = readObjectArray(runtime.open_cases);
  for (const entry of entries) {
    if (readString(entry, "sourceMessageId") !== operation.sourceMessageId) {
      continue;
    }
    entry.status = operation.status;
    entry.resolvedAt = operation.resolvedAt;
    entry.lastTouchedAt = operation.resolvedAt;
    entry.resolutionSummary = operation.resolutionSummary;
  }
  runtime.open_cases = entries;
}

function closeLegacyOpenCaseForReceipt(
  runtime: JsonObject,
  receipt: VoidSpeechReceipts["recentReceipts"][number],
): void {
  if (!receipt.replyToMessageId) {
    return;
  }
  const entries = readObjectArray(runtime.open_cases);
  for (const entry of entries) {
    if (readString(entry, "sourceMessageId") !== receipt.replyToMessageId) {
      continue;
    }
    const status = readString(entry, "status");
    if (status && ["answered", "resolved", "closed", "retired", "dropped"].includes(status)) {
      continue;
    }
    entry.status = "answered";
    entry.resolvedAt = receipt.sentAt;
    entry.lastTouchedAt = receipt.sentAt;
    entry.resolutionSummary = receipt.preview
      ? `Answered in-channel: ${receipt.preview}`
      : "Answered in-channel.";
  }
  runtime.open_cases = entries;
}

function retireLegacyCandidate(
  runtime: JsonObject,
  operation: Extract<VoidSelfStateOperation, { operation: "retire_candidate_intervention" }>,
): void {
  const entries = readObjectArray(runtime.candidate_interventions);
  for (const entry of entries) {
    if (readString(entry, "interventionId") !== operation.interventionId) {
      continue;
    }
    entry.status = "retired";
    entry.retiredAt = operation.retiredAt;
    entry.updatedAt = operation.retiredAt;
    entry.retirementReason = operation.reason;
  }
  runtime.candidate_interventions = entries;
}

function upsertLegacyMemory(legacy: JsonObject, memory: VoidThoughtMemory["memories"][number]): void {
  const memories = ensureObject(legacy, "memories");
  const semantic = readObjectArray(memories.semantic);
  const projected = {
    memoryId: memory.memoryId,
    kind: memory.kind,
    subjectId: memory.target.id,
    subjectLabel: memory.target.label ?? memory.target.id,
    summary: memory.summary,
    evidenceRefs: memory.evidenceRefs.map((entry) => entry.ref),
    lastObservedAt: memory.updatedAt,
    confidence: 0.8,
  };
  const index = semantic.findIndex((entry) => readString(entry, "memoryId") === memory.memoryId);
  if (index === -1) {
    semantic.push(projected);
  } else {
    semantic[index] = { ...semantic[index], ...projected };
  }
  memories.semantic = semantic;
}

function ensureObject(root: JsonObject, key: string): JsonObject {
  const existing = root[key];
  if (isObject(existing)) {
    return existing;
  }
  const next: JsonObject = {};
  root[key] = next;
  return next;
}

function readObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function readString(value: JsonObject, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalCaseStatus(status: string): boolean {
  return ["answered", "resolved", "closed", "retired", "dropped"].includes(status);
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as T;
  }

  if (!isObject(value)) {
    return value;
  }

  const next: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    next[key] = stripUndefined(child);
  }

  return next as T;
}
