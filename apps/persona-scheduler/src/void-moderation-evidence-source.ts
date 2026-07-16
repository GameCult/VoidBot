import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ModerationHistoryMessage {
  id: string;
  timestamp: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  content?: string;
  [key: string]: unknown;
}

export interface VoidModerationEvidence {
  status: "ok";
  after?: string;
  hours?: number;
  totalMatchingMessages: number;
  returnedMessages: number;
  messages: ModerationHistoryMessage[];
  observedCursor?: { lastReviewedMessageId: string; lastReviewedTimestamp: string };
}

export async function readVoidModerationEvidence(input: {
  priorCursorTimestamp?: string;
  limit?: number;
  fallbackHours?: number;
  scriptPath?: string;
  nodeExecutable?: string;
}, dependencies: {
  run?: (file: string, args: string[], options: { cwd: string; maxBuffer: number }) => Promise<{ stdout: string }>;
} = {}): Promise<VoidModerationEvidence> {
  const scriptPath = resolve(input.scriptPath ?? "scripts/export-recent-discord-history.mjs");
  const args = [scriptPath];
  if (input.priorCursorTimestamp) args.push("--after", input.priorCursorTimestamp);
  else args.push("--hours", String(input.fallbackHours ?? 6));
  args.push("--limit", String(input.limit ?? 120));
  const run = dependencies.run ?? (async (file, commandArgs, options) => execFileAsync(file, commandArgs, options));
  const { stdout } = await run(input.nodeExecutable ?? process.execPath, args, { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch (error) { throw new Error(`Moderation evidence exporter returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const parsed = parseExporterResult(raw);
  const latest = parsed.messages.at(-1);
  return {
    status: "ok",
    after: parsed.after,
    hours: parsed.hours,
    totalMatchingMessages: parsed.totalMatchingMessages,
    returnedMessages: parsed.messages.length,
    messages: parsed.messages,
    observedCursor: latest ? { lastReviewedMessageId: latest.id, lastReviewedTimestamp: latest.timestamp } : undefined,
  };
}

function parseExporterResult(raw: unknown): {
  after?: string;
  hours?: number;
  totalMatchingMessages: number;
  messages: ModerationHistoryMessage[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Moderation evidence exporter result must be an object.");
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.messages)) throw new Error("Moderation evidence exporter result has no messages array.");
  const messages = value.messages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Moderation evidence message ${index + 1} must be an object.`);
    const message = entry as Record<string, unknown>;
    if (typeof message.id !== "string" || !message.id || typeof message.timestamp !== "string" || !Number.isFinite(Date.parse(message.timestamp))) {
      throw new Error(`Moderation evidence message ${index + 1} requires id and valid timestamp.`);
    }
    return message as ModerationHistoryMessage;
  });
  return {
    after: typeof value.after === "string" ? value.after : undefined,
    hours: typeof value.hours === "number" ? value.hours : undefined,
    totalMatchingMessages: typeof value.totalMatchingMessages === "number" ? value.totalMatchingMessages : messages.length,
    messages,
  };
}
