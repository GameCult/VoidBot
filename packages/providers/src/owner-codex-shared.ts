import type {
  CodexMcpServerConfig,
  ContextBundle,
  OwnerCodexMode,
  ProviderNotificationIntent,
  ProviderRequest,
  RetrievalFilters,
  RetrievalResult,
} from "@voidbot/shared";

export const HANDOFF_SENTINEL = "VOIDBOT_HANDOFF_REQUIRED:";
export const OWNER_NOTIFY_SENTINEL = "VOIDBOT_OWNER_NOTIFY:";
export const TOOL_REQUEST_SENTINEL = "VOIDBOT_TOOL_REQUEST:";
export const MAX_HISTORY_TOOL_CALLS = 4;
export const MAX_SOURCE_GROUNDING_RETRIES = 1;
export const MAX_NOTIFICATION_MESSAGE_LENGTH = 400;

export interface CodexUsageSnapshot {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

export interface HistoryLookupTool {
  search(
    query: string,
    limit?: number,
    filters?: RetrievalFilters,
  ): Promise<RetrievalResult[]>;
}

export interface OwnerCodexProviderOptions {
  ownerDiscordId: string;
  enabled: boolean;
  mode: OwnerCodexMode;
  executable: string;
  executableArgs: string[];
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  timeoutMs: number;
  workingDirectory: string;
  historyLookup?: HistoryLookupTool;
  handoffNoticeBuilder?: (jobId: string) => string;
  mcpServers?: CodexMcpServerConfig[];
}

export interface CodexRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  handoffReason?: string;
  toolRequest?: HistoryToolRequest;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  traceEvents: CodexTraceEvent[];
  usage?: CodexUsageSnapshot;
}

export interface HistoryToolRequest {
  tool: "search_history";
  query: string;
  limit: number;
  channelId?: string;
  authorId?: string;
}

export interface ToolCallRecord {
  request: HistoryToolRequest;
  results: RetrievalResult[];
}

export interface CodexTraceEvent {
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  kind:
    | "thread_started"
    | "turn_started"
    | "turn_completed"
    | "agent_message"
    | "command_started"
    | "command_completed"
    | "mcp_tool_started"
    | "mcp_tool_completed";
  itemId?: string;
  message?: string;
  command?: string;
  server?: string;
  tool?: string;
  status?: string;
  exitCode?: number | null;
  output?: string;
  arguments?: Record<string, unknown>;
  error?: string;
  resultPreview?: string;
  usage?: CodexUsageSnapshot;
}

export interface NormalizedDiscordReply {
  reply?: string;
  notifications: ProviderNotificationIntent[];
}

export interface TimedTraceOperation {
  itemId: string;
  startedEvent?: CodexTraceEvent;
  completedEvent?: CodexTraceEvent;
  command?: string;
  server?: string;
  tool?: string;
}

export function buildRequestPayload(
  request: ProviderRequest,
): Record<string, unknown> {
  return {
    provider: request.provider,
    createdAt: new Date().toISOString(),
    prompt: request.contextBundle.prompt,
    actor: request.contextBundle.actor,
    guildContext: request.contextBundle.guildContext,
    interactionMemory: request.contextBundle.interactionMemory,
    sourceGrounding: request.contextBundle.sourceGrounding,
    stylePack: request.contextBundle.stylePack,
    recentMessages: request.contextBundle.recentMessages,
    retrieval: request.contextBundle.retrieval,
    options: request.options ?? {},
  };
}

export function buildDefaultHandoffNotice(jobId: string): string {
  return `This request needs the fuller local Codex flow. Check \`.voidbot/artifacts/${jobId}/handoff.md\` and \`.voidbot/artifacts/${jobId}/debug-trace.md\` in the local workspace.`;
}

export function didUseSourceGrounding(events: CodexTraceEvent[]): boolean {
  return events.some(
    (event) =>
      event.kind === "mcp_tool_completed" &&
      (event.tool === "list_indexed_repos" ||
        event.tool === "search_sources" ||
        event.tool === "get_source_context"),
  );
}

export function extractLatestUsage(
  events: CodexTraceEvent[],
): CodexUsageSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = events[index]?.usage;

    if (usage) {
      return usage;
    }
  }

  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (value < minimum) {
    return minimum;
  }

  if (value > maximum) {
    return maximum;
  }

  return value;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readUsage(value: unknown): CodexUsageSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    inputTokens: readNumber(value.input_tokens),
    cachedInputTokens: readNumber(value.cached_input_tokens),
    outputTokens: readNumber(value.output_tokens),
  };
}

export function readRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function renderUsageSummary(
  usage: CodexUsageSnapshot | undefined,
): string {
  if (!usage) {
    return "(not reported)";
  }

  return [
    `input=${usage.inputTokens ?? 0}`,
    `cached=${usage.cachedInputTokens ?? 0}`,
    `output=${usage.outputTokens ?? 0}`,
  ].join(" ");
}

export function formatElapsedMs(elapsedMs: number): string {
  return `+${formatDurationMs(elapsedMs)}`;
}

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs)) {
    return "(unknown)";
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
}

export function summarizeStderrDiagnostics(stderr: string): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    if (!/(WARN|ERROR|failed|timed out|forbidden|rejected)/i.test(line)) {
      continue;
    }

    const normalized = sanitizeTraceText(line, 220);

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    diagnostics.push(`- ${normalized}`);

    if (diagnostics.length >= 20) {
      break;
    }
  }

  return diagnostics;
}

export function sanitizeTraceText(input: string, limit: number): string {
  const collapsed = input.replace(/\s+/g, " ").trim();

  if (collapsed.length <= limit) {
    return collapsed;
  }

  return `${collapsed.slice(0, limit - 3)}...`;
}

export function summarizeUnknown(
  value: unknown,
  limit: number,
): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return sanitizeTraceText(value, limit);
  }

  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    return sanitizeTraceText(JSON.stringify(value), limit);
  } catch {
    return undefined;
  }
}

export function summarizeToolResult(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return summarizeUnknown(value, 320);
  }

  const structured = readRecord(value.structured_content);

  if (structured) {
    const summaryBits: string[] = [];
    const query = readString(structured, "query");
    const sourceId = readString(structured, "sourceId");
    const messageId = readString(structured, "messageId");
    const resultCount = readNumber(structured.resultCount);
    const count = readNumber(structured.count);

    if (query) {
      summaryBits.push(`query=${sanitizeTraceText(query, 120)}`);
    }

    if (sourceId) {
      summaryBits.push(`sourceId=${sanitizeTraceText(sourceId, 120)}`);
    }

    if (messageId) {
      summaryBits.push(`messageId=${messageId}`);
    }

    if (typeof structured.found === "boolean") {
      summaryBits.push(`found=${structured.found ? "yes" : "no"}`);
    }

    if (resultCount !== null) {
      summaryBits.push(`resultCount=${resultCount}`);
    }

    if (count !== null) {
      summaryBits.push(`count=${count}`);
    }

    if (summaryBits.length > 0) {
      return summaryBits.join(" ");
    }
  }

  const content = Array.isArray(value.content) ? value.content : [];

  if (content.length > 0) {
    const fragments = content
      .slice(0, 3)
      .map((entry) => {
        if (!isRecord(entry)) {
          return summarizeUnknown(entry, 100) ?? "(unknown)";
        }

        if (typeof entry.text === "string") {
          return entry.text;
        }

        if (isRecord(entry.resource) && typeof entry.resource.text === "string") {
          return entry.resource.text;
        }

        return summarizeUnknown(entry, 100) ?? "(unknown)";
      })
      .filter((entry): entry is string => entry.length > 0);

    if (fragments.length > 0) {
      return sanitizeTraceText(fragments.join(" | "), 320);
    }
  }

  return summarizeUnknown(value, 320);
}

export function collectMcpToolCalls(
  events: CodexTraceEvent[],
): TimedTraceOperation[] {
  const calls = new Map<string, TimedTraceOperation>();
  const order: string[] = [];

  for (const event of events) {
    if (event.kind !== "mcp_tool_started" && event.kind !== "mcp_tool_completed") {
      continue;
    }

    const itemId = event.itemId ?? `mcp-${event.sequence}`;

    if (!calls.has(itemId)) {
      calls.set(itemId, {
        itemId,
        server: event.server,
        tool: event.tool,
      });
      order.push(itemId);
    }

    const call = calls.get(itemId)!;
    call.server ??= event.server;
    call.tool ??= event.tool;

    if (event.kind === "mcp_tool_started") {
      call.startedEvent = event;
    } else {
      call.completedEvent = event;
    }
  }

  return order.map((itemId) => calls.get(itemId)!);
}

export function collectCommandExecutions(
  events: CodexTraceEvent[],
): TimedTraceOperation[] {
  const commands = new Map<string, TimedTraceOperation>();
  const order: string[] = [];

  for (const event of events) {
    if (event.kind !== "command_started" && event.kind !== "command_completed") {
      continue;
    }

    const itemId = event.itemId ?? `command-${event.sequence}`;

    if (!commands.has(itemId)) {
      commands.set(itemId, {
        itemId,
        command: event.command,
      });
      order.push(itemId);
    }

    const command = commands.get(itemId)!;
    command.command ??= event.command;

    if (event.kind === "command_started") {
      command.startedEvent = event;
    } else {
      command.completedEvent = event;
    }
  }

  return order.map((itemId) => commands.get(itemId)!);
}

export function renderInteractionMemory(context: ContextBundle): string {
  if (!context.interactionMemory) {
    return "- No explicit interaction memory for this speaker was attached.";
  }

  const recentEvents = context.interactionMemory.recentEvents.length
    ? context.interactionMemory.recentEvents
        .slice()
        .reverse()
        .slice(0, 6)
        .map(
          (event) =>
            `- [${event.timestamp}] ${event.sourceKind === "ambient_mention" ? "ambient" : "direct"} ${event.sentiment} score=${event.score}: ${event.summary} Quote: "${event.excerpt}"`,
        )
        .join("\n")
    : "- No recent interaction events were retained.";
  const dimensions = context.interactionMemory.interactionDimensions.length
    ? context.interactionMemory.interactionDimensions
        .map(
          (dimension) =>
            `- ${dimension.label}: ${dimension.score}/3. ${dimension.summary}`,
        )
        .join("\n")
    : "- No strong interaction dimensions were inferred yet.";

  return [
    `- Summary: ${context.interactionMemory.summary}`,
    `- Disposition: ${context.interactionMemory.disposition}`,
    `- Affinity score: ${context.interactionMemory.affinityScore}`,
    `- Psychological profile: ${context.interactionMemory.psychologicalProfile}`,
    `- Inferred traits: ${context.interactionMemory.inferredTraits.length > 0 ? context.interactionMemory.inferredTraits.join(", ") : "(none yet)"}`,
    "- Interaction dimensions:",
    dimensions,
    `- Response guidance: ${context.interactionMemory.responseGuidance}`,
    `- Direct remembered interactions: ${context.interactionMemory.directInteractionCount}`,
    `- Ambient remembered mentions: ${context.interactionMemory.ambientMentionCount}`,
    "- Specific remembered incidents:",
    recentEvents,
  ].join("\n");
}
