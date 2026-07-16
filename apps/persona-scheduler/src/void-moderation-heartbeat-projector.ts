import { voidSelfStateOperationSchema, type VoidSelfStateOperation, type VoidSelfStateTypedProjection } from "@voidbot/core";

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

export function projectVoidModerationHeartbeatContext(input: {
  state: VoidSelfStateTypedProjection;
  observedAt: Date;
  observedCursor: unknown;
  recentHistory: unknown;
  urgentModerationWitnesses: unknown[];
  enforcementMode: string;
  rules: string;
}): VoidModerationHeartbeatContext {
  const relative = <T>(value: T): T => projectRelativeChronology(value, input.observedAt) as T;
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
    "Return only a JSON array of complete typed Void self-state operation objects. Do not use markdown fences, commentary, tools, or file writes.",
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
}): VoidSelfStateOperation[] {
  const trimmed = input.outputText.trim();
  const candidate = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
  let raw: unknown;
  try { raw = JSON.parse(candidate); } catch (error) { throw new Error(`Moderation heartbeat output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(raw)) throw new Error("Moderation heartbeat output must be a JSON array.");
  return raw.map((entry, index) => validateOperation(entry, index, input.state));
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

function projectRelativeChronology(value: unknown, observedAt: Date, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => projectRelativeChronology(entry, observedAt));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, projectRelativeChronology(entry, observedAt, entryKey)]));
  if (typeof value === "string" && /(?:at|timestamp)$/i.test(key) && Number.isFinite(Date.parse(value))) return relativeTime(value, observedAt);
  return value;
}

function relativeTime(value: string, observedAt: Date): string {
  const difference = observedAt.getTime() - Date.parse(value);
  const future = difference < 0;
  const minutes = Math.max(0, Math.round(Math.abs(difference) / 60_000));
  const phrase = (amount: number, unit: string) => future ? `in ${amount} ${unit}${amount === 1 ? "" : "s"}` : `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
  if (minutes < 60) return phrase(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return phrase(hours, "hour");
  const days = Math.round(hours / 24);
  return phrase(days, "day");
}
