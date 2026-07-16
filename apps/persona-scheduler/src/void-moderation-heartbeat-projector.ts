import { voidSelfStateOperationSchema, type VoidSelfStateOperation, type VoidSelfStateTypedProjection } from "@voidbot/core";
import { z } from "zod";
import { projectRelativeChronology } from "./relative-chronology-projector.js";

const ALLOWED_MODERATION_TAGS = new Set(["moderation:instaban", "moderation:strike", "moderation:case_only"]);

export interface VoidModerationHeartbeatContext {
  mode: "moderation_heartbeat";
  operationTimestamp: string;
  enforcementMode: string;
  rules: string;
  priorCursor: unknown;
  observedCursor: unknown;
  openCases: unknown[];
  urgentModerationWitnesses: unknown[];
  recentHistory: unknown;
}

export interface VoidModerationHeartbeatDecision {
  reviewedMessageIds: string[];
  urgentMessageIds: string[];
  operations: VoidSelfStateOperation[];
}

export function projectVoidModerationHeartbeatContext(input: {
  state: VoidSelfStateTypedProjection;
  observedAt: Date;
  observedCursor: unknown;
  recentHistory: unknown;
  urgentModerationWitnesses: unknown[];
  enforcementMode: string;
  rules: string;
}): VoidModerationHeartbeatContext {
  const relative = <T>(value: T): T => projectRelativeChronology(value, input.observedAt);
  return {
    mode: "moderation_heartbeat",
    operationTimestamp: input.observedAt.toISOString(),
    enforcementMode: input.enforcementMode,
    rules: input.rules,
    priorCursor: relative(input.state.moderationCursor),
    observedCursor: relative(input.observedCursor),
    openCases: relative(input.state.moderationCursor.openCases),
    urgentModerationWitnesses: relative(input.urgentModerationWitnesses),
    recentHistory: relative(input.recentHistory),
  };
}

export function buildVoidModerationHeartbeatPrompt(context: VoidModerationHeartbeatContext): string {
  return [
    "You are Void's rules-only public-community moderation organ. This is not public speech, private rumination, or repo thought.",
    "Return only one JSON object with reviewedMessageIds, urgentMessageIds, and operations. Do not use markdown fences, commentary, tools, or file writes.",
    "reviewedMessageIds must contain every message ID in recentHistory exactly once. urgentMessageIds is the subset requiring urgent safety accounting; use [] when none are urgent.",
    "Allowed operations: upsert_open_case, close_open_case.",
    "Each new case must identify one concrete source message and contain exactly one infringement:<type> tag plus exactly one moderation:instaban, moderation:strike, or moderation:case_only tag.",
    "Choose the strongest supported infringement type; never multiply cases or sanctions for one message.",
    "Do not reopen an already-actioned case. Urgent safety evidence must be accounted for by an existing case or a proposed upsert.",
    "Use operationTimestamp when a fresh exact timestamp is required. Relative chronology in evidence is not schema-ready timestamp text.",
    "Moderation context:",
    JSON.stringify(context, null, 2),
  ].join("\n\n");
}

export function parseVoidModerationHeartbeatOperations(input: {
  outputText: string;
  state: VoidSelfStateTypedProjection;
  observedMessageIds: string[];
}): VoidModerationHeartbeatDecision {
  const trimmed = input.outputText.trim();
  const candidate = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  let raw: unknown;
  try { raw = JSON.parse(candidate); } catch (error) { throw new Error(`Moderation heartbeat output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const envelope = z.object({
    reviewedMessageIds: z.array(z.string().trim().min(1)),
    urgentMessageIds: z.array(z.string().trim().min(1)),
    operations: z.array(z.unknown()),
  }).strict().parse(raw);
  assertExactReviewLedger(input.observedMessageIds, envelope.reviewedMessageIds);
  const observed = new Set(input.observedMessageIds);
  if (envelope.urgentMessageIds.some((id) => !observed.has(id))) throw new Error("Moderation urgent ledger contains a message outside the observed evidence window.");
  const operations = envelope.operations.map((entry, index) => validateOperation(entry, index, input.state));
  const accounted = new Set([
    ...input.state.moderationCursor.openCases.map((entry) => entry.sourceMessageId),
    ...operations.flatMap((operation) => operation.operation === "upsert_open_case" ? [operation.case.sourceMessageId] : []),
  ]);
  const unaccountedUrgent = envelope.urgentMessageIds.filter((id) => !accounted.has(id));
  if (unaccountedUrgent.length > 0) throw new Error(`Urgent moderation evidence is unaccounted for: ${unaccountedUrgent.join(", ")}.`);
  return { reviewedMessageIds: envelope.reviewedMessageIds, urgentMessageIds: envelope.urgentMessageIds, operations };
}

function assertExactReviewLedger(observed: string[], reviewed: string[]): void {
  const expected = [...new Set(observed)].sort();
  const actual = [...new Set(reviewed)].sort();
  if (reviewed.length !== actual.length || expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error("Moderation review ledger must account for every observed message exactly once before cursor advancement.");
  }
}

function validateOperation(entry: unknown, index: number, state: VoidSelfStateTypedProjection): VoidSelfStateOperation {
  const operation = voidSelfStateOperationSchema.parse(entry);
  if (operation.operation !== "upsert_open_case" && operation.operation !== "close_open_case") {
    throw new Error(`Moderation heartbeat operation ${index + 1} is not allowed: ${operation.operation}.`);
  }
  if (operation.operation === "close_open_case") return operation;
  const prior = state.moderationCursor.openCases.find((item) => item.sourceMessageId === operation.case.sourceMessageId);
  if (prior && ["answered", "resolved", "closed", "retired", "dropped"].includes(prior.status)
    && /(?:instaban|three-strike ban|strike \d\/3 recorded|ban applied)/i.test(prior.resolutionSummary ?? "")) {
    throw new Error(`Moderation heartbeat cannot reopen already-actioned case '${operation.case.sourceMessageId}'.`);
  }
  const tags = operation.case.tags.map((tag) => tag.toLowerCase());
  const infringementTags = tags.filter((tag) => tag.startsWith("infringement:"));
  const moderationTags = tags.filter((tag) => ALLOWED_MODERATION_TAGS.has(tag));
  if (infringementTags.length !== 1) throw new Error("Moderation heartbeat open cases must include exactly one infringement:<type> tag.");
  if (moderationTags.length !== 1) throw new Error("Moderation heartbeat open cases must include exactly one moderation classification tag.");
  return operation;
}
