import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments, type VoidSelfStateOperation, type VoidSelfStateTypedProjection } from "@voidbot/core";
import type { VoidMemoryMaintenanceIntent } from "./void-physiology-domain.js";
import { buildVoidMemoryMaintenancePrompt, parseVoidMemoryMaintenanceOperations, projectVoidMemoryMaintenanceContext } from "./void-memory-maintenance-projector.js";

export type VoidMemoryMaintenanceResult =
  | { status: "skipped"; reason: "no_intent" | "already_completed_this_nap" | "already_attempted_this_nap"; runnerId?: string }
  | { status: "ok"; runnerId: string; proposedOperationCount: number; appliedOperationCount: number; remainingShortTermCount: number };

export async function runVoidMemoryMaintenance(input: {
  statePath: string;
  intent?: VoidMemoryMaintenanceIntent;
  observedAt?: Date;
}, dependencies: {
  loadState?: typeof loadVoidSelfStateTypedDocuments;
  applyOperation?: typeof applyVoidSelfStateOperation;
  projectText: (prompt: string) => Promise<string>;
}): Promise<VoidMemoryMaintenanceResult> {
  if (!input.intent) return { status: "skipped", reason: "no_intent" };
  const runnerId = `void-memory-maintenance:${input.intent.napStartedAt}`;
  const attemptRunnerId = `void-memory-maintenance-attempt:${input.intent.napStartedAt}`;
  const loadState = dependencies.loadState ?? loadVoidSelfStateTypedDocuments;
  const applyOperation = dependencies.applyOperation ?? applyVoidSelfStateOperation;
  const state = await loadState({ canonicalPath: input.statePath });
  if (state.scheduledRuntime.lastRuns.some((run) => run.runner === runnerId)) return { status: "skipped", reason: "already_completed_this_nap", runnerId };
  if (state.scheduledRuntime.lastRuns.some((run) => run.runner === attemptRunnerId)) return { status: "skipped", reason: "already_attempted_this_nap", runnerId: attemptRunnerId };
  const observedAt = input.observedAt ?? new Date();
  await applyOperation({ canonicalPath: input.statePath }, {
    operation: "record_scheduled_run",
    run: { runner: attemptRunnerId, ranAt: observedAt.toISOString(), summary: "Started one bounded sleep memory-maintenance attempt for this nap." },
  });
  const context = projectVoidMemoryMaintenanceContext({ state, observedAt, forceDistillation: true });
  const output = await dependencies.projectText(buildVoidMemoryMaintenancePrompt(context));
  const operations = parseVoidMemoryMaintenanceOperations(output);
  if (context.maintenancePressure > 0 && operations.length === 0) throw new Error(`Sleep memory maintenance returned no operations despite maintenance pressure ${context.maintenancePressure}.`);
  for (const operation of operations) await applyOperation({ canonicalPath: input.statePath }, operation);
  const refreshed = await loadState({ canonicalPath: input.statePath });
  const remainingShortTermCount = refreshed.thoughtMemory.shortTerm.filter((memory) => !memory.retiredAt).length;
  if (remainingShortTermCount > 0) throw new Error(`Sleep memory maintenance left ${remainingShortTermCount} short-term memories unpromoted.`);
  const receipt: VoidSelfStateOperation = {
    operation: "record_scheduled_run",
    run: { runner: runnerId, ranAt: observedAt.toISOString(), summary: `Applied ${operations.length} typed memory-maintenance operation${operations.length === 1 ? "" : "s"}; no short-term residue remained.` },
  };
  await applyOperation({ canonicalPath: input.statePath }, receipt);
  return { status: "ok", runnerId, proposedOperationCount: operations.length, appliedOperationCount: operations.length, remainingShortTermCount };
}

export function hasVoidMemoryMaintenanceCompleted(state: VoidSelfStateTypedProjection, intent: VoidMemoryMaintenanceIntent): boolean {
  return state.scheduledRuntime.lastRuns.some((run) => run.runner === `void-memory-maintenance:${intent.napStartedAt}`);
}
