import { resolve } from "node:path";

import { CultCache, SingleFileMessagePackBackingStore } from "cultcache-ts";

import {
  type VoidCandidateInterventions,
  type VoidAgencyPressure,
  type VoidModerationCursor,
  type VoidScheduledRuntime,
  type VoidSelfStateOperation,
  type VoidSpeechReceipts,
  voidCandidateInterventionsDocument,
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
  type VoidSelfStateTypedProjection,
} from "./void-self-state-projection";

export interface VoidSelfStateServiceOptions {
  canonicalPath: string;
}

export interface VoidSelfStateOperationResult {
  operation: VoidSelfStateOperation["operation"];
  canonicalPath: string;
  typedDocumentsWritten: number;
}

export async function loadVoidSelfStateTypedDocuments(
  options: VoidSelfStateServiceOptions,
): Promise<VoidSelfStateTypedProjection> {
  const canonicalPath = resolve(options.canonicalPath);
  const cache = createVoidSelfStateCache(canonicalPath);
  await cache.pullAllBackingStores();
  return readTypedStateOrEmpty(cache);
}

export async function applyVoidSelfStateOperation(
  options: VoidSelfStateServiceOptions,
  rawOperation: unknown,
): Promise<VoidSelfStateOperationResult> {
  const canonicalPath = resolve(options.canonicalPath);
  const operation = voidSelfStateOperationSchema.parse(rawOperation);
  const cache = createVoidSelfStateCache(canonicalPath);
  await cache.pullAllBackingStores();

  const typedState = readTypedStateOrEmpty(cache);
  applyTypedOperation(typedState, operation);
  await writeTypedState(cache, typedState);

  return {
    operation: operation.operation,
    canonicalPath,
    typedDocumentsWritten: 7,
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
): VoidSelfStateTypedProjection {
  const empty = createEmptyVoidSelfState();
  return {
    selfProfile: cache.getGlobal(voidSelfProfileDocument) ?? empty.selfProfile,
    moderationCursor: cache.getGlobal(voidModerationCursorDocument) ?? empty.moderationCursor,
    speechReceipts: cache.getGlobal(voidSpeechReceiptsDocument) ?? empty.speechReceipts,
    thoughtMemory: cache.getGlobal(voidThoughtMemoryDocument) ?? empty.thoughtMemory,
    scheduledRuntime: cache.getGlobal(voidScheduledRuntimeDocument) ?? empty.scheduledRuntime,
    agencyPressure: cache.getGlobal(voidAgencyPressureDocument) ?? empty.agencyPressure,
    candidateInterventions:
      cache.getGlobal(voidCandidateInterventionsDocument) ?? empty.candidateInterventions,
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
  await cache.putGlobal(voidAgencyPressureDocument, stripUndefined(state.agencyPressure));
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
    case "record_short_term_memory":
      upsertBy(state.thoughtMemory.shortTerm, operation.memory, (entry) => entry.memoryId);
      state.thoughtMemory.shortTerm = state.thoughtMemory.shortTerm
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(-48);
      state.thoughtMemory.updatedAt = operation.memory.updatedAt;
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
      upsertBy(state.candidateInterventions.interventions, operation.intervention, (entry) => entry.interventionId);
      state.candidateInterventions.updatedAt = operation.intervention.updatedAt;
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
  state.candidateInterventions.updatedAt = operation.receipt.sentAt;
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
