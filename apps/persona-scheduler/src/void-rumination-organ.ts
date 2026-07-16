import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments } from "@voidbot/core";
import { buildVoidRuminationPrompt, parseVoidRuminationOperations, projectVoidRuminationContext } from "./void-rumination-projector.js";

export type VoidRuminationResult =
  | { status: "skipped"; reason: "already_attempted_this_pressure" | "napping_without_pressure"; runnerId?: string }
  | { status: "ok"; runnerId: string; appliedOperationCount: number; queuedCandidateIds: string[] };

export async function runVoidRumination(input: {
  statePath: string;
  observedAt?: Date;
  pendingMentions?: unknown[];
  recentHistory?: unknown;
  repoActivity?: unknown;
  recentRoomLinks?: unknown;
  recentConversationTarget?: unknown;
  publicSpeechTarget?: unknown;
  doctrine: string;
  rules: string;
  voice: string;
}, dependencies: {
  loadState?: typeof loadVoidSelfStateTypedDocuments;
  applyOperation?: typeof applyVoidSelfStateOperation;
  projectText: (prompt: string) => Promise<string>;
}): Promise<VoidRuminationResult> {
  const loadState = dependencies.loadState ?? loadVoidSelfStateTypedDocuments;
  const applyOperation = dependencies.applyOperation ?? applyVoidSelfStateOperation;
  const state = await loadState({ canonicalPath: input.statePath });
  const observedAt = input.observedAt ?? new Date();
  const context = projectVoidRuminationContext({ ...input, state, observedAt });
  const hasExternalPressure = (input.pendingMentions?.length ?? 0) > 0 || hasObservedItems(input.recentHistory) || hasObservedItems(input.repoActivity) || hasObservedItems(input.recentRoomLinks);
  const hasInternalPressure = context.speechPressureObligationIds.length > 0 || state.moderationCursor.openCases.some((entry) => ["pending", "watching"].includes(entry.status)) || state.candidateInterventions.interventions.some((entry) => entry.status === "queued");
  if (state.scheduledRuntime.sleepCycle.isNapping && !hasExternalPressure && !hasInternalPressure) return { status: "skipped", reason: "napping_without_pressure" };
  const runnerId = `void-rumination-attempt:${context.pressureFingerprint}`;
  if (state.scheduledRuntime.lastRuns.some((run) => run.runner === runnerId)) return { status: "skipped", reason: "already_attempted_this_pressure", runnerId };
  await applyOperation({ canonicalPath: input.statePath }, {
    operation: "record_scheduled_run",
    run: { runner: runnerId, ranAt: observedAt.toISOString(), summary: "Started one bounded person-shaped rumination attempt for this pressure fingerprint." },
  });
  const operations = parseVoidRuminationOperations({ outputText: await dependencies.projectText(buildVoidRuminationPrompt(context)), state });
  for (const operation of operations) await applyOperation({ canonicalPath: input.statePath }, operation);
  return {
    status: "ok", runnerId, appliedOperationCount: operations.length,
    queuedCandidateIds: operations.flatMap((operation) => operation.operation === "queue_candidate_intervention" ? [operation.intervention.interventionId] : []),
  };
}

function hasObservedItems(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["messages", "items", "commits", "repos"]) if (Array.isArray(record[key]) && record[key].length > 0) return true;
  return false;
}
