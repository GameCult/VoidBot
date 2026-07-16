import { createHash } from "node:crypto";
import { voidSelfStateOperationSchema, type VoidSelfStateOperation, type VoidSelfStateTypedProjection } from "@voidbot/core";
import { projectRelativeChronology } from "./relative-chronology-projector.js";

const ALLOWED_OPERATIONS = new Set([
  "upsert_open_case", "close_open_case", "record_short_term_memory", "merge_incubation_support",
  "upsert_agency_pressure", "retire_agency_pressure", "upsert_affect_need", "retire_affect_need",
  "upsert_social_bond", "retire_social_bond", "upsert_status_read", "retire_status_read",
  "update_mood_dimensions", "queue_candidate_intervention", "retire_candidate_intervention",
]);

export interface VoidRuminationContext {
  mode: "person_shaped_rumination";
  operationTimestamp: string;
  pressureFingerprint: string;
  selfProfile: unknown;
  affect: unknown;
  memories: unknown[];
  shortTermMemories: unknown[];
  incubation: unknown[];
  agencyPressure: unknown[];
  speechPressureObligationIds: string[];
  candidateInterventions: unknown[];
  speechReceipts: unknown[];
  openCases: unknown[];
  scheduledRuntime: unknown;
  pendingMentions: unknown[];
  recentHistory: unknown;
  repoActivity: unknown;
  recentRoomLinks: unknown;
  recentConversationTarget: unknown;
  publicSpeechTarget: unknown;
  doctrine: string;
  rules: string;
  voice: string;
}

export function projectVoidRuminationContext(input: {
  state: VoidSelfStateTypedProjection;
  observedAt: Date;
  pendingMentions?: unknown[];
  recentHistory?: unknown;
  repoActivity?: unknown;
  recentRoomLinks?: unknown;
  recentConversationTarget?: unknown;
  publicSpeechTarget?: unknown;
  doctrine: string;
  rules: string;
  voice: string;
}): VoidRuminationContext {
  const obligationIds = speechPressureObligationIds(input.state);
  const fingerprint = fingerprintVoidRuminationPressure({
    state: input.state,
    pendingMentions: input.pendingMentions ?? [], recentHistory: input.recentHistory ?? null,
    repoActivity: input.repoActivity ?? null, recentRoomLinks: input.recentRoomLinks ?? null,
  });
  const relative = <T>(value: T): T => projectRelativeChronology(value, input.observedAt);
  return {
    mode: "person_shaped_rumination", operationTimestamp: input.observedAt.toISOString(), pressureFingerprint: fingerprint,
    selfProfile: relative(input.state.selfProfile), affect: relative(input.state.faceAffect),
    memories: relative(input.state.thoughtMemory.memories), shortTermMemories: relative(input.state.thoughtMemory.shortTerm),
    incubation: relative(input.state.thoughtMemory.incubation), agencyPressure: relative(input.state.agencyPressure.pressures),
    speechPressureObligationIds: obligationIds, candidateInterventions: relative(input.state.candidateInterventions.interventions),
    speechReceipts: relative(input.state.speechReceipts.recentReceipts), openCases: relative(input.state.moderationCursor.openCases),
    scheduledRuntime: relative(input.state.scheduledRuntime), pendingMentions: relative(input.pendingMentions ?? []),
    recentHistory: relative(input.recentHistory ?? null), repoActivity: relative(input.repoActivity ?? null),
    recentRoomLinks: relative(input.recentRoomLinks ?? null), recentConversationTarget: input.recentConversationTarget ?? null,
    publicSpeechTarget: input.publicSpeechTarget ?? null, doctrine: input.doctrine, rules: input.rules, voice: input.voice,
  };
}

export function buildVoidRuminationPrompt(context: VoidRuminationContext): string {
  return [
    "You are Void's private person-shaped rumination organ. Think as a participant with values and relationships, not as a maintenance report.",
    "Return only a JSON array of complete typed Void self-state operation objects. No markdown, commentary, tools, file writes, or direct transport calls.",
    `Allowed operations: ${[...ALLOWED_OPERATIONS].join(", ")}.`,
    "New memories must be short-term and meaning-preserving. Queue speech only as candidate interventions; the parent delivery organ owns transport and receipts.",
    "A reply candidate must retain the source channel and message in deliveryTarget. publicSpeechTarget is only for unanchored public artifacts or herald speech.",
    "For every speechPressureObligationId, queue a live candidate tagged source_pressure:<id>, retire the pressure, or upsert it with cooling/resolved status. Silent [] is invalid while obligations exist.",
    "Use operationTimestamp for fresh exact timestamps. Relative chronology is evidence only.",
    "If no anchored state change or sayable pressure exists, return [].",
    "Rumination context:", JSON.stringify(context, null, 2),
  ].join("\n\n");
}

export function parseVoidRuminationOperations(input: { outputText: string; state: VoidSelfStateTypedProjection }): VoidSelfStateOperation[] {
  const trimmed = input.outputText.trim();
  const candidate = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  let raw: unknown;
  try { raw = JSON.parse(candidate); } catch (error) { throw new Error(`Void rumination output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(raw)) throw new Error("Void rumination output must be a JSON array.");
  const operations = raw.map((entry, index) => {
    const operation = voidSelfStateOperationSchema.parse(entry);
    if (!ALLOWED_OPERATIONS.has(operation.operation)) throw new Error(`Void rumination operation ${index + 1} is not allowed: ${operation.operation}.`);
    return operation;
  });
  assertSpeechPressureResolved(input.state, operations);
  return operations;
}

export function fingerprintVoidRuminationPressure(input: { state: VoidSelfStateTypedProjection; pendingMentions: unknown[]; recentHistory: unknown; repoActivity: unknown; recentRoomLinks: unknown }): string {
  const state = input.state;
  const pressure = {
    affect: state.faceAffect, shortTerm: state.thoughtMemory.shortTerm, incubation: state.thoughtMemory.incubation,
    agency: state.agencyPressure.pressures, candidates: state.candidateInterventions.interventions,
    openCases: state.moderationCursor.openCases, receipts: state.speechReceipts.recentReceipts.slice(-16),
    pendingMentions: input.pendingMentions, recentHistory: input.recentHistory, repoActivity: input.repoActivity, recentRoomLinks: input.recentRoomLinks,
  };
  return createHash("sha256").update(JSON.stringify(pressure)).digest("hex").slice(0, 24);
}

function speechPressureObligationIds(state: VoidSelfStateTypedProjection): string[] {
  return state.agencyPressure.pressures
    .filter((pressure) => ["active", "ready_to_act"].includes(pressure.status) && pressure.intensity >= 0.55)
    .filter((pressure) => !state.candidateInterventions.interventions.some((candidate) => ["queued", "spoken"].includes(candidate.status) && candidate.tags.includes(`source_pressure:${pressure.pressureId}`)))
    .map((pressure) => pressure.pressureId);
}

function assertSpeechPressureResolved(state: VoidSelfStateTypedProjection, operations: VoidSelfStateOperation[]): void {
  for (const pressureId of speechPressureObligationIds(state)) {
    const resolved = operations.some((operation) =>
      (operation.operation === "queue_candidate_intervention" && operation.intervention.status === "queued" && operation.intervention.tags.includes(`source_pressure:${pressureId}`))
      || (operation.operation === "retire_agency_pressure" && operation.pressureId === pressureId)
      || (operation.operation === "upsert_agency_pressure" && operation.pressure.pressureId === pressureId && ["cooling", "resolved", "retired"].includes(operation.pressure.status)));
    if (!resolved) throw new Error(`Active advocacy pressure '${pressureId}' requires a candidate intervention or explicit cooling/retirement.`);
  }
}
