import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments, type VoidSelfStateOperation } from "@voidbot/core";
import { readVoidModerationEvidence, type VoidModerationEvidence } from "./void-moderation-evidence-source.js";
import { buildVoidModerationHeartbeatPrompt, parseVoidModerationHeartbeatOperations, projectVoidModerationHeartbeatContext } from "./void-moderation-heartbeat-projector.js";

export type VoidModerationHeartbeatResult =
  | { status: "skipped"; reason: "no_new_messages" | "already_attempted_this_window"; runnerId?: string }
  | { status: "ok"; runnerId: string; reviewedMessageCount: number; urgentMessageCount: number; appliedOperationCount: number; enforcementOperations: VoidSelfStateOperation[] };

export async function runVoidModerationHeartbeat(input: {
  statePath: string;
  rules: string;
  enforcementMode: string;
  observedAt?: Date;
}, dependencies: {
  loadState?: typeof loadVoidSelfStateTypedDocuments;
  applyOperation?: typeof applyVoidSelfStateOperation;
  readEvidence?: (input: { priorCursorTimestamp?: string }) => Promise<VoidModerationEvidence>;
  projectText: (prompt: string) => Promise<string>;
}): Promise<VoidModerationHeartbeatResult> {
  const loadState = dependencies.loadState ?? loadVoidSelfStateTypedDocuments;
  const applyOperation = dependencies.applyOperation ?? applyVoidSelfStateOperation;
  const state = await loadState({ canonicalPath: input.statePath });
  const evidence = await (dependencies.readEvidence ?? ((request) => readVoidModerationEvidence(request)))({
    priorCursorTimestamp: state.moderationCursor.lastReviewedTimestamp,
  });
  if (evidence.messages.length === 0 || !evidence.observedCursor) return { status: "skipped", reason: "no_new_messages" };
  const runnerId = `void-moderation-heartbeat-attempt:${evidence.observedCursor.lastReviewedMessageId}`;
  if (state.scheduledRuntime.lastRuns.some((run) => run.runner === runnerId)) return { status: "skipped", reason: "already_attempted_this_window", runnerId };
  const observedAt = input.observedAt ?? new Date();
  await applyOperation({ canonicalPath: input.statePath }, {
    operation: "record_scheduled_run",
    run: { runner: runnerId, ranAt: observedAt.toISOString(), summary: `Started one bounded moderation review through message ${evidence.observedCursor.lastReviewedMessageId}.` },
  });
  const context = projectVoidModerationHeartbeatContext({
    state,
    observedAt,
    observedCursor: evidence.observedCursor,
    recentHistory: evidence,
    urgentModerationWitnesses: [],
    enforcementMode: input.enforcementMode,
    rules: input.rules,
  });
  const decision = parseVoidModerationHeartbeatOperations({
    outputText: await dependencies.projectText(buildVoidModerationHeartbeatPrompt(context)),
    state,
    observedMessageIds: evidence.messages.map((message) => message.id),
  });
  for (const operation of decision.operations) await applyOperation({ canonicalPath: input.statePath }, operation);
  await applyOperation({ canonicalPath: input.statePath }, {
    operation: "record_reviewed_messages",
    lastReviewedMessageId: evidence.observedCursor.lastReviewedMessageId,
    lastReviewedTimestamp: evidence.observedCursor.lastReviewedTimestamp,
  });
  return {
    status: "ok",
    runnerId,
    reviewedMessageCount: decision.reviewedMessageIds.length,
    urgentMessageCount: decision.urgentMessageIds.length,
    appliedOperationCount: decision.operations.length + 1,
    enforcementOperations: decision.operations.filter((operation) => operation.operation === "upsert_open_case"),
  };
}
