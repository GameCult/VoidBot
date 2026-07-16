import { createHash } from "node:crypto";
import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments } from "@voidbot/core";

export type VoidCandidateDeliveryResult =
  | { status: "skipped"; reason: "no_targeted_candidate" | "already_answered"; candidateId?: string }
  | { status: "ok"; candidateId: string; messageId: string; transport: string };

export async function runVoidCandidateDelivery(input: {
  statePath: string;
  personaName: string;
  personaAvatarUrl?: string;
  observedAt?: Date;
}, dependencies: {
  loadState?: typeof loadVoidSelfStateTypedDocuments;
  applyOperation?: typeof applyVoidSelfStateOperation;
  deliver: (input: { candidateId: string; channelId: string; replyToMessageId?: string; content: string; personaName: string; personaAvatarUrl?: string }) => Promise<{ messageId: string; transport: string; sentAt?: string }>;
}): Promise<VoidCandidateDeliveryResult> {
  const loadState = dependencies.loadState ?? loadVoidSelfStateTypedDocuments;
  const state = await loadState({ canonicalPath: input.statePath });
  const candidate = state.candidateInterventions.interventions
    .filter((entry) => entry.status === "queued" && entry.deliveryTarget?.channelId)
    .sort((left, right) => right.priority - left.priority || Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
  if (!candidate?.deliveryTarget?.channelId) return { status: "skipped", reason: "no_targeted_candidate" };
  const alreadyAnswered = state.speechReceipts.recentReceipts.some((receipt) =>
    receipt.candidateInterventionId === candidate.interventionId
    || (candidate.deliveryTarget?.replyToMessageId && receipt.channelId === candidate.deliveryTarget.channelId && receipt.replyToMessageId === candidate.deliveryTarget.replyToMessageId));
  if (alreadyAnswered) return { status: "skipped", reason: "already_answered", candidateId: candidate.interventionId };
  const delivered = await dependencies.deliver({
    candidateId: candidate.interventionId, channelId: candidate.deliveryTarget.channelId,
    replyToMessageId: candidate.deliveryTarget.replyToMessageId, content: candidate.draft,
    personaName: input.personaName, personaAvatarUrl: input.personaAvatarUrl,
  });
  if (!delivered.messageId || !delivered.transport) throw new Error("Candidate delivery returned an incomplete receipt.");
  const sentAt = delivered.sentAt ?? (input.observedAt ?? new Date()).toISOString();
  const receiptKey = `void-speech-${createHash("sha1").update(JSON.stringify({ candidateId: candidate.interventionId, messageId: delivered.messageId, channelId: candidate.deliveryTarget.channelId })).digest("hex").slice(0, 24)}`;
  await (dependencies.applyOperation ?? applyVoidSelfStateOperation)({ canonicalPath: input.statePath }, {
    operation: "mark_candidate_intervention_spoken",
    interventionId: candidate.interventionId,
    receipt: {
      receiptKey, candidateInterventionId: candidate.interventionId, sentAt,
      mode: "channel", transport: delivered.transport, channelId: candidate.deliveryTarget.channelId,
      replyToMessageId: candidate.deliveryTarget.replyToMessageId, personaName: input.personaName,
      personaAvatarUrl: input.personaAvatarUrl, contentLength: candidate.draft.length,
      chunkCount: 1, preview: candidate.draft.slice(0, 1000),
    },
  });
  return { status: "ok", candidateId: candidate.interventionId, messageId: delivered.messageId, transport: delivered.transport };
}
