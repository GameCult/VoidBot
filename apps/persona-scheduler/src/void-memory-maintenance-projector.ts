import { voidSelfStateOperationSchema, type VoidSelfStateOperation, type VoidSelfStateTypedProjection } from "@voidbot/core";
import { projectRelativeChronology } from "./relative-chronology-projector.js";

const ALLOWED_OPERATIONS = new Set([
  "merge_incubation_support", "queue_candidate_intervention", "retire_candidate_intervention",
  "upsert_agency_pressure", "retire_agency_pressure", "upsert_affect_need", "retire_affect_need",
  "upsert_social_bond", "retire_social_bond", "upsert_status_read", "retire_status_read",
  "update_mood_dimensions", "propose_memory_distillation", "apply_memory_distillation",
  "revise_durable_memory", "retire_durable_memory", "crystallize_memory_into_identity",
  "prune_short_term_memories",
]);

export interface VoidMemoryMaintenanceContext {
  mode: "sleep_maintenance" | "awake_memory_maintenance";
  operationTimestamp: string;
  maintenancePressure: number;
  forceDistillation: boolean;
  shortTermMemoryCount: number;
  longTermMemoryCount: number;
  incubationCount: number;
  activeAgencyPressureCount: number;
  activeCandidateCount: number;
  shortTermMemories: unknown[];
  memories: unknown[];
  incubation: unknown[];
  agencyPressure: unknown[];
  candidateInterventions: unknown[];
  scheduledRuntime: unknown;
  speechReceipts: unknown[];
}

export function projectVoidMemoryMaintenanceContext(input: {
  state: VoidSelfStateTypedProjection;
  observedAt: Date;
  forceDistillation?: boolean;
}): VoidMemoryMaintenanceContext {
  const state = input.state;
  const sleeping = input.forceDistillation === true || state.scheduledRuntime.sleepCycle.isNapping;
  const activeShortTerm = state.thoughtMemory.shortTerm.filter((entry) => !entry.retiredAt);
  const activeAgency = state.agencyPressure.pressures.filter((entry) => ["active", "cooling", "ready_to_act"].includes(entry.status));
  const activeCandidates = state.candidateInterventions.interventions.filter((entry) => entry.status === "queued" || entry.status === "deferred");
  const maintenancePressure = activeShortTerm.length + state.thoughtMemory.incubation.length + activeAgency.length + activeCandidates.length;
  const relative = <T>(value: T): T => projectRelativeChronology(value, input.observedAt);
  return {
    mode: sleeping ? "sleep_maintenance" : "awake_memory_maintenance",
    operationTimestamp: input.observedAt.toISOString(),
    maintenancePressure,
    forceDistillation: sleeping && maintenancePressure > 0,
    shortTermMemoryCount: activeShortTerm.length,
    longTermMemoryCount: state.thoughtMemory.memories.length,
    incubationCount: state.thoughtMemory.incubation.length,
    activeAgencyPressureCount: activeAgency.length,
    activeCandidateCount: activeCandidates.length,
    shortTermMemories: relative(activeShortTerm), memories: relative(state.thoughtMemory.memories),
    incubation: relative(state.thoughtMemory.incubation), agencyPressure: relative(activeAgency),
    candidateInterventions: relative(activeCandidates), scheduledRuntime: relative(state.scheduledRuntime),
    speechReceipts: relative(state.speechReceipts.recentReceipts),
  };
}

export function buildVoidMemoryMaintenancePrompt(context: VoidMemoryMaintenanceContext): string {
  return [
    "You are Void's private memory-maintenance organ. This is not moderation or public speech.",
    "Return only a JSON array of complete typed Void self-state operation objects. Do not use markdown fences, commentary, tools, or file writes.",
    `Allowed operations: ${[...ALLOWED_OPERATIONS].join(", ")}.`,
    "Never emit cursor, receipt, sleep-cycle, or speaking-pressure operations. Omit absent optional fields; never emit null.",
    "Every durable memory move must preserve a concrete target, claim or question, tension, future-action implication, and anchors or tag anchor:missing.",
    "During sleep every short-term memory must be consumed by apply_memory_distillation, or merged into incubation and pruned, or honestly pruned.",
    "Use operationTimestamp for required operation timestamps. Context chronology is relative evidence, not schema-ready timestamp text.",
    context.forceDistillation ? "Sleep pressure is active. Returning [] is invalid." : "If no meaning-preserving move exists, return [].",
    "Maintenance context:",
    JSON.stringify(context, null, 2),
  ].join("\n\n");
}

export function parseVoidMemoryMaintenanceOperations(outputText: string): VoidSelfStateOperation[] {
  const trimmed = outputText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  let raw: unknown;
  try { raw = JSON.parse(candidate); } catch (error) { throw new Error(`Memory maintenance output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(raw)) throw new Error("Memory maintenance output must be a JSON array.");
  return raw.map((entry, index) => {
    const operation = voidSelfStateOperationSchema.parse(entry);
    if (!ALLOWED_OPERATIONS.has(operation.operation)) throw new Error(`Memory maintenance operation ${index + 1} is not allowed: ${operation.operation}.`);
    return operation;
  });
}
