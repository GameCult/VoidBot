import { spawn } from "node:child_process";

import {
  type Actor,
  type ContextBundle,
  type CodexMcpServerConfig,
  DEFAULT_RETRIEVAL_RESULT_LIMIT,
  type GuildContext,
  MAX_RETRIEVAL_RESULT_LIMIT,
  type OwnerCodexMode,
  type ProviderAdapter,
  type ProviderArtifact,
  type ProviderNotificationIntent,
  type ProviderNotificationReason,
  type RetrievalFilters,
  type RetrievalResult,
  type ProviderRequest,
  type ProviderResponse,
} from "@voidbot/shared";

const HANDOFF_SENTINEL = "VOIDBOT_HANDOFF_REQUIRED:";
const OWNER_NOTIFY_SENTINEL = "VOIDBOT_OWNER_NOTIFY:";
const TOOL_REQUEST_SENTINEL = "VOIDBOT_TOOL_REQUEST:";
const MAX_HISTORY_TOOL_CALLS = 4;
const DEFAULT_HISTORY_LIMIT = DEFAULT_RETRIEVAL_RESULT_LIMIT;
const MAX_HISTORY_LIMIT = MAX_RETRIEVAL_RESULT_LIMIT;
const MAX_NOTIFICATION_MESSAGE_LENGTH = 400;

interface CodexUsageSnapshot {
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

interface CodexRunResult {
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

interface HistoryToolRequest {
  tool: "search_history";
  query: string;
  limit: number;
  channelId?: string;
  authorId?: string;
}

interface ToolCallRecord {
  request: HistoryToolRequest;
  results: RetrievalResult[];
}

interface CodexTraceEvent {
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

interface NormalizedDiscordReply {
  reply?: string;
  notifications: ProviderNotificationIntent[];
}

export class OwnerCodexProvider implements ProviderAdapter {
  public constructor(private readonly options: OwnerCodexProviderOptions) {}

  public getName(): "owner_codex" {
    return "owner_codex";
  }

  public getCapabilities(): string[] {
    if (this.options.mode === "local_exec_owner_only") {
      return [
        "owner_only",
        "local_exec_owner_only",
        "read_only_discord_reply",
        "automatic_handoff_notice",
        "rag_history_tool",
        "rag_source_tool",
        "tool_driven_retrieval",
      ];
    }

    return [
      "owner_only",
      "manual_package",
      "run_approval_required",
      "post_approval_required",
    ];
  }

  public isEnabled(): boolean {
    return this.options.enabled;
  }

  public isAllowedForActor(actor: Actor, _guildContext: GuildContext): boolean {
    return this.isEnabled() && actor.id === this.options.ownerDiscordId;
  }

  public buildRequest(
    contextBundle: ContextBundle,
    options?: Record<string, unknown>,
  ): ProviderRequest {
    return {
      provider: "owner_codex",
      contextBundle,
      options,
    };
  }

  public async execute(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.options.mode === "manual_package") {
      return this.buildManualPackage(request);
    }

    return this.executeLocalOwnerFlow(request);
  }

  public async estimateCost(_request: ProviderRequest): Promise<number> {
    return 0;
  }

  public getAuditRedactions(): string[] {
    return [];
  }

  private buildHandoffNotice(jobId: string): string {
    return this.options.handoffNoticeBuilder?.(jobId) ?? buildDefaultHandoffNotice(jobId);
  }

  private buildManualPackage(request: ProviderRequest): ProviderResponse {
    const requestPayload = buildRequestPayload(request);

    return {
      status: "ready_for_review",
      summary: "Manual Codex package generated. Review the bundle, run it manually, then approve the final post.",
      artifacts: [
        {
          name: "request.md",
          contentType: "markdown",
          content: renderMarkdownBundle(request.contextBundle),
        },
        {
          name: "request.json",
          contentType: "json",
          content: `${JSON.stringify(requestPayload, null, 2)}\n`,
        },
      ],
      metadata: {
        response_mode: "manual_package",
      },
    };
  }

  private async executeLocalOwnerFlow(request: ProviderRequest): Promise<ProviderResponse> {
    const command = String(request.options?.command ?? "ask");
    const jobId = String(request.options?.jobId ?? "unknown-job");
    const requestPayload = buildRequestPayload(request);
    const baseArtifacts: ProviderArtifact[] = [
      {
        name: "request.md",
        contentType: "markdown" as const,
        content: renderMarkdownBundle(request.contextBundle),
      },
      {
        name: "request.json",
        contentType: "json" as const,
        content: `${JSON.stringify(requestPayload, null, 2)}\n`,
      },
    ];

    if (command === "queue-codex") {
      return {
        status: "completed",
        summary: "Owner request was routed to a fuller Codex handoff instead of a direct Discord reply.",
        outputText: this.buildHandoffNotice(jobId),
        artifacts: [
          ...baseArtifacts,
          {
            name: "handoff.md",
            contentType: "markdown",
            content: renderHandoffBundle(request.contextBundle, "Requested via /queue-codex."),
          },
        ],
        metadata: {
          response_mode: "handoff",
          reason: "Requested via queue-codex.",
        },
      };
    }

    const toolCalls: ToolCallRecord[] = [];
    const artifacts: ProviderArtifact[] = [...baseArtifacts];
    const turnResults: CodexRunResult[] = [];
    let result: CodexRunResult | undefined;

    for (let turn = 0; turn <= MAX_HISTORY_TOOL_CALLS; turn += 1) {
      const codexPrompt = buildDiscordReplyPrompt(request.contextBundle, toolCalls);

      result = await runCodexExec({
        executable: this.options.executable,
        executableArgs: this.options.executableArgs,
        reasoningEffort: this.options.reasoningEffort,
        timeoutMs: this.options.timeoutMs,
        workingDirectory: this.options.workingDirectory,
        prompt: codexPrompt,
        mcpServers: this.options.mcpServers ?? [],
      });
      turnResults.push(result);

      artifacts.push(
        {
          name: `codex-turn-${turn + 1}-prompt.md`,
          contentType: "markdown" as const,
          content: codexPrompt,
        },
        {
          name: `codex-turn-${turn + 1}-stdout.txt`,
          contentType: "text" as const,
          content: result.stdout,
        },
        {
          name: `codex-turn-${turn + 1}-stderr.txt`,
          contentType: "text" as const,
          content: result.stderr,
        },
        {
          name: `codex-turn-${turn + 1}-trace.json`,
          contentType: "json" as const,
          content: `${JSON.stringify(
            {
              startedAt: result.startedAt,
              finishedAt: result.finishedAt,
              durationMs: result.durationMs,
              usage: result.usage ?? null,
              events: result.traceEvents,
            },
            null,
            2,
          )}\n`,
        },
        {
          name: `codex-turn-${turn + 1}-debug.md`,
          contentType: "markdown" as const,
          content: renderCodexDebugTrace(turn + 1, result),
        },
      );

      if (result.timedOut) {
        break;
      }

      if (!result.toolRequest) {
        break;
      }

      if (!this.options.historyLookup) {
        result.handoffReason =
          "This request needs additional history lookup, but the owner RAG tool is not configured in the worker.";
        break;
      }

      if (toolCalls.length >= MAX_HISTORY_TOOL_CALLS) {
        result.handoffReason =
          "This request needed too many history lookups for the bounded Discord-safe tool loop.";
        result.toolRequest = undefined;
        break;
      }

      const executedToolCall = await executeHistoryLookup(
        this.options.historyLookup,
        request.contextBundle,
        result.toolRequest,
      );

      toolCalls.push(executedToolCall);
    }

    artifacts.push({
      name: "rag-tool-transcript.md",
      contentType: "markdown",
      content: renderToolTranscript(toolCalls, turnResults),
    });
    artifacts.push({
      name: "debug-trace.md",
      contentType: "markdown",
      content: renderAggregateDebugTrace(artifacts, turnResults),
    });

    if (!result) {
      return {
        status: "completed",
        summary: "Codex local exec did not start, so VoidBot returned a handoff notice instead.",
        outputText: this.buildHandoffNotice(jobId),
        artifacts: [
          ...artifacts,
          {
            name: "handoff.md",
            contentType: "markdown",
            content: renderHandoffBundle(
              request.contextBundle,
              "Local Codex execution did not start correctly.",
            ),
          },
        ],
        metadata: {
          response_mode: "handoff",
          reason: "Local Codex execution did not start correctly.",
        },
      };
    }

    if (result.timedOut) {
      return {
        status: "completed",
        summary: "Codex local exec timed out, so VoidBot returned a handoff notice instead.",
        outputText: this.buildHandoffNotice(jobId),
        artifacts: [
          ...artifacts,
          {
            name: "handoff.md",
            contentType: "markdown",
            content: renderHandoffBundle(
              request.contextBundle,
              "Local Codex execution timed out before a Discord-safe reply was ready.",
            ),
          },
        ],
        metadata: {
          response_mode: "handoff",
          reason: "Local Codex execution timed out.",
        },
      };
    }

    if (result.handoffReason) {
      return {
        status: "completed",
        summary: "Codex determined that this request should move into a fuller local session.",
        outputText: this.buildHandoffNotice(jobId),
        artifacts: [
          ...artifacts,
          {
            name: "handoff.md",
            contentType: "markdown",
            content: renderHandoffBundle(request.contextBundle, result.handoffReason),
          },
        ],
        metadata: {
          response_mode: "handoff",
          reason: result.handoffReason,
          history_tool_calls: String(toolCalls.length),
        },
      };
    }

    const normalizedReply = normalizeDiscordReply(result.stdout);

    if (!normalizedReply.reply) {
      return {
        status: "completed",
        summary: "Codex did not produce a Discord-safe reply, so VoidBot returned a handoff notice.",
        outputText: this.buildHandoffNotice(jobId),
        artifacts: [
          ...artifacts,
          {
            name: "handoff.md",
            contentType: "markdown",
            content: renderHandoffBundle(
              request.contextBundle,
              "Local Codex execution did not produce a direct Discord reply.",
            ),
          },
        ],
        metadata: {
          response_mode: "handoff",
          reason: "No direct reply was produced.",
        },
      };
    }

    return {
      status: "completed",
      summary: "Codex returned a Discord-safe owner reply.",
      outputText: normalizedReply.reply,
      artifacts,
      metadata: {
        response_mode: "discord_reply",
        history_tool_calls: String(toolCalls.length),
      },
      notifications: normalizedReply.notifications,
    };
  }
}

async function runCodexExec(input: {
  executable: string;
  executableArgs: string[];
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  timeoutMs: number;
  workingDirectory: string;
  prompt: string;
  mcpServers: CodexMcpServerConfig[];
}): Promise<CodexRunResult> {
  return new Promise<CodexRunResult>((resolve) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const args = [
      ...input.executableArgs,
      "exec",
      "-c",
      'approval_policy="never"',
      "-c",
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
      ...buildMcpConfigArguments(input.mcpServers),
      "--json",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      input.prompt,
    ];

    let stdout = "";
    let stderr = "";
    let resolved = false;
    let handoffReason: string | undefined;
    let stdoutBuffer = "";
    const traceEvents: CodexTraceEvent[] = [];

    const child = spawn(input.executable, args, {
      cwd: input.workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (
      result: Omit<
        CodexRunResult,
        "startedAt" | "finishedAt" | "durationMs" | "traceEvents" | "usage"
      >,
    ) => {
      if (resolved) {
        return;
      }

      resolved = true;
      clearTimeout(timeoutHandle);
      const finishedAtMs = Date.now();
      resolve({
        ...result,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        traceEvents: [...traceEvents],
        usage: extractLatestUsage(traceEvents),
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const traceEvent = tryParseTraceEvent(line, traceEvents.length + 1, startedAtMs);

        if (traceEvent) {
          traceEvents.push(traceEvent);
        }

        const event = tryParseCodexLine(line);

        if (!event) {
          continue;
        }

        if (event.approvalRequested) {
          handoffReason =
            event.handoffReason ??
            "The request needs tools or permissions outside the Discord-safe owner allowlist.";
          child.kill();
          return;
        }

        if (event.toolRequest) {
          child.kill();
          finish({
            stdout,
            stderr,
            exitCode: null,
            toolRequest: event.toolRequest,
            timedOut: false,
          });
          return;
        }

        if (event.handoffReason && !handoffReason) {
          handoffReason = event.handoffReason;
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        stdout,
        stderr: `${stderr}${error.message}\n`,
        exitCode: null,
        handoffReason: "The local Codex executable was not available for automatic Discord replies.",
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim().length > 0) {
        const traceEvent = tryParseTraceEvent(stdoutBuffer.trim(), traceEvents.length + 1, startedAtMs);

        if (traceEvent) {
          traceEvents.push(traceEvent);
        }

        const event = tryParseCodexLine(stdoutBuffer.trim());

        if (event?.approvalRequested && !handoffReason) {
          handoffReason =
            event.handoffReason ??
            "The request needs tools or permissions outside the Discord-safe owner allowlist.";
        }
      }

      finish({
        stdout,
        stderr,
        exitCode: code,
        handoffReason,
        timedOut: false,
      });
    });

    const timeoutHandle = setTimeout(() => {
      handoffReason = "The local Codex run exceeded the Discord reply timeout.";
      child.kill();
      finish({
        stdout,
        stderr,
        exitCode: null,
        handoffReason,
        timedOut: true,
      });
    }, input.timeoutMs);
  });
}

function buildMcpConfigArguments(mcpServers: CodexMcpServerConfig[]): string[] {
  const argumentsList: string[] = [];

  for (const server of mcpServers) {
    argumentsList.push("-c", `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`);
    argumentsList.push("-c", `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`);

    if (server.cwd) {
      argumentsList.push("-c", `mcp_servers.${server.name}.cwd=${JSON.stringify(server.cwd)}`);
    }

    for (const [key, value] of Object.entries(server.env ?? {})) {
      argumentsList.push("-c", `mcp_servers.${server.name}.env.${key}=${JSON.stringify(value)}`);
    }
  }

  return argumentsList;
}

function tryParseCodexLine(line: string):
  | {
      approvalRequested: boolean;
      handoffReason?: string;
      toolRequest?: HistoryToolRequest;
    }
  | undefined {
  const trimmed = line.trim();

  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const event = unwrapCodexEvent(parsed);
    const type = typeof event?.type === "string" ? event.type : "";

    if (type.includes("approval_request")) {
      return {
        approvalRequested: true,
        handoffReason:
          "The request needs tools or permissions outside the Discord-safe owner allowlist.",
      };
    }

    if (type === "agent_message") {
      const message = readString(event, "message") ?? readString(event, "text");

      if (message?.trim().startsWith(HANDOFF_SENTINEL)) {
        return {
          approvalRequested: false,
          handoffReason: message.trim().slice(HANDOFF_SENTINEL.length).trim(),
        };
      }

      const toolRequest = parseHistoryToolRequest(message);

      if (toolRequest) {
        return {
          approvalRequested: false,
          toolRequest,
        };
      }
    }

    if (
      type === "item.completed" &&
      isRecord(event.item) &&
      event.item.type === "agent_message"
    ) {
      const message = readString(event.item, "text") ?? readString(event.item, "message");

      if (message?.trim().startsWith(HANDOFF_SENTINEL)) {
        return {
          approvalRequested: false,
          handoffReason: message.trim().slice(HANDOFF_SENTINEL.length).trim(),
        };
      }

      const toolRequest = parseHistoryToolRequest(message);

      if (toolRequest) {
        return {
          approvalRequested: false,
          toolRequest,
        };
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function tryParseTraceEvent(
  line: string,
  sequence: number,
  startedAtMs: number,
): CodexTraceEvent | undefined {
  const trimmed = line.trim();

  if (!trimmed.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const event = unwrapCodexEvent(parsed);
    const type = typeof event.type === "string" ? event.type : "";
    const timestampMs = Date.now();
    const baseEvent = {
      sequence,
      timestamp: new Date(timestampMs).toISOString(),
      elapsedMs: timestampMs - startedAtMs,
    };

    if (type === "thread.started") {
      return {
        ...baseEvent,
        kind: "thread_started",
      };
    }

    if (type === "turn.started") {
      return {
        ...baseEvent,
        kind: "turn_started",
      };
    }

    if (type === "turn.completed") {
      return {
        ...baseEvent,
        kind: "turn_completed",
        usage: readUsage(event.usage),
      };
    }

    if (type === "agent_message") {
      const message = readString(event, "message") ?? readString(event, "text");

      if (message) {
        return {
          ...baseEvent,
          kind: "agent_message",
          message,
        };
      }
    }

    if (!isRecord(event.item)) {
      return undefined;
    }

    const item = event.item;
    const itemId = readString(item, "id");

    if (type === "item.started" && item.type === "command_execution") {
      return {
        ...baseEvent,
        kind: "command_started",
        itemId,
        command: readString(item, "command") ?? "(unknown command)",
        status: readString(item, "status") ?? "in_progress",
      };
    }

    if (type === "item.completed" && item.type === "command_execution") {
      return {
        ...baseEvent,
        kind: "command_completed",
        itemId,
        command: readString(item, "command") ?? "(unknown command)",
        status: readString(item, "status") ?? "(unknown)",
        exitCode: readNumber(item.exit_code),
        output: readString(item, "aggregated_output") ?? "",
      };
    }

    if (type === "item.started" && item.type === "mcp_tool_call") {
      return {
        ...baseEvent,
        kind: "mcp_tool_started",
        itemId,
        server: readString(item, "server"),
        tool: readString(item, "tool"),
        status: readString(item, "status") ?? "in_progress",
        arguments: readRecord(item.arguments),
      };
    }

    if (type === "item.completed" && item.type === "mcp_tool_call") {
      return {
        ...baseEvent,
        kind: "mcp_tool_completed",
        itemId,
        server: readString(item, "server"),
        tool: readString(item, "tool"),
        status: readString(item, "status") ?? "(unknown)",
        arguments: readRecord(item.arguments),
        error: summarizeUnknown(item.error, 220),
        resultPreview: summarizeToolResult(item.result),
      };
    }

    if (type === "item.completed" && item.type === "agent_message") {
      const message = readString(item, "text") ?? readString(item, "message");

      if (message) {
        return {
          ...baseEvent,
          kind: "agent_message",
          itemId,
          message,
        };
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function extractLatestUsage(events: CodexTraceEvent[]): CodexUsageSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = events[index]?.usage;

    if (usage) {
      return usage;
    }
  }

  return undefined;
}

function unwrapCodexEvent(parsed: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(parsed.msg) && typeof parsed.msg.type === "string") {
    return parsed.msg;
  }

  if (isRecord(parsed.payload) && typeof parsed.payload.type === "string") {
    return parsed.payload;
  }

  return parsed;
}

function normalizeDiscordReply(stdout: string): NormalizedDiscordReply {
  const messages: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0 || !trimmed.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const event = unwrapCodexEvent(parsed);
      const type = typeof event.type === "string" ? event.type : "";

      if (type.endsWith("_delta")) {
        continue;
      }

      if (type === "agent_message") {
        const message = readString(event, "message") ?? readString(event, "text");

        if (message) {
          messages.push(message.trim());
        }
      }

      if (
        type === "item.completed" &&
        isRecord(event.item) &&
        event.item.type === "agent_message"
      ) {
        const message = readString(event.item, "text") ?? readString(event.item, "message");

        if (message) {
          messages.push(message.trim());
        }
      }
    } catch {
      continue;
    }
  }

  const reply = [...messages].reverse().find((message) => message.length > 0);

  if (!reply) {
    return { notifications: [] };
  }

  if (reply.startsWith(HANDOFF_SENTINEL)) {
    return { notifications: [] };
  }

  if (reply.startsWith(TOOL_REQUEST_SENTINEL)) {
    return { notifications: [] };
  }

  const notifications: ProviderNotificationIntent[] = [];
  const replyLines: string[] = [];

  for (const line of reply.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.startsWith(OWNER_NOTIFY_SENTINEL)) {
      const notification = parseOwnerNotificationIntent(trimmed);

      if (notification) {
        notifications.push(notification);
      }

      continue;
    }

    replyLines.push(line);
  }

  const cleanedReply = replyLines.join("\n").trim();

  return {
    reply: cleanedReply.length > 0 ? cleanedReply : undefined,
    notifications,
  };
}

function buildDiscordReplyPrompt(
  context: ContextBundle,
  toolCalls: ToolCallRecord[],
): string {
  const recentMessages = context.recentMessages.length
    ? context.recentMessages
        .map(
          (message) =>
            `- [${message.timestamp}] ${message.authorName}: ${message.content}`,
        )
        .join("\n")
    : "- No recent messages captured.";

  const retrieval = context.retrieval.length
    ? context.retrieval
        .map((result) => `- (${result.score.toFixed(2)}) ${result.text}`)
        .join("\n")
    : "- No retrieval results attached.";
  const stylePackInstructions =
    context.stylePack && context.stylePack.enabled
      ? context.stylePack.instructions
      : "No style pack is active.";

  return [
    "# VoidBot Owner Discord Reply",
    "",
    "You are preparing a direct Discord reply for the owner-only VoidBot workflow.",
    "",
    "Rules:",
    "- Stay in read-only mode.",
    "- Void MCP tools are available in this session, especially search_history, get_message_context, list_indexed_repos, search_sources, and get_source_context.",
    `- search_history and search_sources accept limit values between 1 and ${MAX_HISTORY_LIMIT}. Do not ask for more than ${MAX_HISTORY_LIMIT} results in one call.`,
    "- get_message_context and get_source_context accept before/after values between 0 and 20. Do not ask for larger context windows in one call.",
    "- You may inspect the workspace and use safe read-only commands if needed.",
    "- For questions about Discord history, prior discussion, or user preferences, use search_history and get_message_context instead of filesystem inspection.",
    "- For questions about GameCult repos, source trees, repo-local docs, or AetheriaLore, use search_sources and get_source_context before broad workspace scans.",
    "- If you want to narrow source search to a specific repo but do not know the valid repo names yet, call list_indexed_repos first.",
    "- Do not inspect .voidbot/rag/messages.json, .voidbot/rag/source-documents.json, .voidbot/history-vector-store.json, or .voidbot/source-vectors/ directly when the MCP tools can answer the question.",
    "- Avoid broad workspace scans for archived Discord history or indexed source repos unless the MCP tools are clearly insufficient.",
    "- Do not modify files, install packages, or require network access.",
    `- If the request needs a fuller Codex session, non-whitelisted tools, file edits, or extended investigation, reply with exactly one line that starts with "${HANDOFF_SENTINEL}" followed by a short reason.`,
    "- Do not use notify_owner in this Discord reply lane.",
    `- If you want Void's worker to send the owner a DM after this job, append one extra line that starts with "${OWNER_NOTIFY_SENTINEL}" followed by compact JSON like {"reason":"completion","message":"..."} .`,
    "- Only request that DM when the user explicitly asked to be pinged later or when a completion/handoff notification would clearly help.",
    `- Keep that notification message in Void's voice and under ${MAX_NOTIFICATION_MESSAGE_LENGTH} characters.`,
    "- Put the normal Discord reply first. Put the notification line last.",
    "- If you can answer directly, output only the final Discord reply text with no preamble, no plan, and no headings.",
    "- Keep the answer concise and readable in a Discord channel.",
    "",
    "Style instructions:",
    stylePackInstructions,
    "",
    "Prompt:",
    context.prompt,
    "",
    "Recent channel context:",
    recentMessages,
    "",
    "Initial attached retrieval:",
    retrieval,
  ].join("\n");
}

function buildDefaultHandoffNotice(jobId: string): string {
  return `Void: This one wants a fuller rite than I am willing to perform in-channel. Check \`.voidbot/artifacts/${jobId}/handoff.md\` and \`.voidbot/artifacts/${jobId}/debug-trace.md\` in the local Codex workspace.`;
}

function buildRequestPayload(request: ProviderRequest): Record<string, unknown> {
  return {
    provider: request.provider,
    createdAt: new Date().toISOString(),
    prompt: request.contextBundle.prompt,
    actor: request.contextBundle.actor,
    guildContext: request.contextBundle.guildContext,
    stylePack: request.contextBundle.stylePack,
    recentMessages: request.contextBundle.recentMessages,
    retrieval: request.contextBundle.retrieval,
    options: request.options ?? {},
  };
}

function renderMarkdownBundle(context: ContextBundle): string {
  const recentMessages = context.recentMessages.length
    ? context.recentMessages
        .map(
          (message) =>
            `- [${message.timestamp}] ${message.authorName} (${message.authorId}): ${message.content}`,
        )
        .join("\n")
    : "- No recent messages captured.";

  const retrieval = context.retrieval.length
      ? context.retrieval
        .map(
          (result) =>
            `- score=${result.score.toFixed(2)} source=${result.sourceId} text=${result.text}`,
        )
        .join("\n")
    : "- No retrieval results attached.";

  return [
    "# VoidBot Owner Codex Package",
    "",
    "## Request",
    "",
    `Prompt: ${context.prompt}`,
    `Actor: ${context.actor.displayName} (${context.actor.id})`,
    `Channel: ${context.guildContext.channelId}`,
    `Created At: ${context.createdAt}`,
    "",
    "## Style Pack",
    "",
    context.stylePack
      ? `Loaded style pack \`${context.stylePack.name}\` with these instructions:\n\n${context.stylePack.instructions}`
      : "No style pack loaded.",
    "",
    "## Recent Messages",
    "",
    recentMessages,
    "",
    "## Retrieval",
    "",
    retrieval,
    "",
    "## Execution Notes",
    "",
    "- This provider is owner-only.",
    "- Discord replies should stay read-only and concise.",
    "- If the request needs edits, broader tools, or longer work, hand it off to a fuller Codex session.",
    "",
  ].join("\n");
}

function renderHandoffBundle(context: ContextBundle, reason: string): string {
  return [
    renderMarkdownBundle(context),
    "## Handoff Reason",
    "",
    reason,
    "",
    "## Next Step",
    "",
    "Open this workspace in Codex and continue the task there instead of trying to finish it through Discord.",
    "",
  ].join("\n");
}

function renderToolTranscript(toolCalls: ToolCallRecord[], turnResults: CodexRunResult[]): string {
  const legacyTranscript =
    toolCalls.length > 0
      ? toolCalls
          .map((call, index) => {
            const results = call.results.length
              ? call.results
                  .map(
                    (result) =>
                      `  - (${result.score.toFixed(2)}) source=${result.sourceId} channel=${result.metadata.channelId ?? ""} text=${result.text}`,
                  )
                  .join("\n")
              : "  - No matches found.";

            return [
              `Search ${index + 1}:`,
              `- Query: ${call.request.query}`,
              `- Limit: ${call.request.limit}`,
              `- Channel filter: ${call.request.channelId ?? "(none)"}`,
              `- Author filter: ${call.request.authorId ?? "(none)"}`,
              "- Results:",
              results,
            ].join("\n");
          })
          .join("\n\n")
      : "- No additional legacy history-loop calls were used.";

  const mcpTranscript = renderAggregateMcpToolTranscript(turnResults);

  return [
    "# Tool Transcript",
    "",
    "## Legacy Owner History Loop",
    "",
    legacyTranscript,
    "",
    "## Codex MCP Tool Activity",
    "",
    mcpTranscript,
    "",
  ].join("\n");
}

async function executeHistoryLookup(
  historyLookup: HistoryLookupTool,
  context: ContextBundle,
  request: HistoryToolRequest,
): Promise<ToolCallRecord> {
  const filters: RetrievalFilters = {
    corpusKind: "discord_history",
    guildId: context.guildContext.guildId,
    channelId: request.channelId,
    authorId: request.authorId,
  };

  const results = await historyLookup.search(request.query, request.limit, filters);

  return {
    request,
    results,
  };
}

function parseHistoryToolRequest(message: string | undefined): HistoryToolRequest | undefined {
  const trimmed = message?.trim();

  if (!trimmed?.startsWith(TOOL_REQUEST_SENTINEL)) {
    return undefined;
  }

  const payload = trimmed.slice(TOOL_REQUEST_SENTINEL.length).trim();

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    if (parsed.tool !== "search_history") {
      return undefined;
    }

    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";

    if (query.length === 0) {
      return undefined;
    }

    const rawLimit = typeof parsed.limit === "number" ? parsed.limit : DEFAULT_HISTORY_LIMIT;
    const limit = clamp(Math.trunc(rawLimit), 1, MAX_HISTORY_LIMIT);

    return {
      tool: "search_history",
      query: query.slice(0, 240),
      limit,
      channelId: typeof parsed.channelId === "string" ? parsed.channelId : undefined,
      authorId: typeof parsed.authorId === "string" ? parsed.authorId : undefined,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (value < minimum) {
    return minimum;
  }

  if (value > maximum) {
    return maximum;
  }

  return value;
}

function parseOwnerNotificationIntent(line: string): ProviderNotificationIntent | undefined {
  const payload = line.slice(OWNER_NOTIFY_SENTINEL.length).trim();

  if (payload.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const message =
      typeof parsed.message === "string"
        ? parsed.message.trim().replace(/\s+/g, " ")
        : "";

    if (message.length === 0) {
      return undefined;
    }

    return {
      channel: "owner_dm",
      reason: normalizeNotificationReason(parsed.reason),
      message: message.slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH),
    };
  } catch {
    return undefined;
  }
}

function normalizeNotificationReason(value: unknown): ProviderNotificationReason {
  if (value === "completion" || value === "failure" || value === "handoff") {
    return value;
  }

  return "custom";
}

function renderCodexDebugTrace(turnNumber: number, result: CodexRunResult): string {
  const events = result.traceEvents;
  const stderrDiagnostics = summarizeStderrDiagnostics(result.stderr);
  const usage = renderUsageSummary(result.usage);

  return [
    `# Codex Debug Trace: Turn ${turnNumber}`,
    "",
    "## Runtime",
    "",
    `- Started at: ${result.startedAt}`,
    `- Finished at: ${result.finishedAt}`,
    `- Duration: ${formatDurationMs(result.durationMs)}`,
    `- Timed out: ${result.timedOut ? "yes" : "no"}`,
    `- Exit code: ${result.exitCode ?? "(terminated before normal exit)"}`,
    `- Handoff reason: ${result.handoffReason ?? "(none)"}`,
    `- Tool request: ${result.toolRequest ? JSON.stringify(result.toolRequest) : "(none)"}`,
    `- Usage: ${usage}`,
    `- Stdout size: ${result.stdout.length} characters`,
    `- Stderr size: ${result.stderr.length} characters`,
    "",
    "## Visible Agent Messages",
    "",
    renderAgentMessageTrace(events),
    "",
    "## MCP Tool Timeline",
    "",
    renderMcpToolTrace(events),
    "",
    "## Command Timeline",
    "",
    renderCommandTrace(events),
    "",
    "## Stderr Diagnostics",
    "",
    stderrDiagnostics.length > 0 ? stderrDiagnostics.join("\n") : "- No stderr diagnostics captured.",
    "",
  ].join("\n");
}

function renderAggregateDebugTrace(
  artifacts: ProviderArtifact[],
  turnResults: CodexRunResult[],
): string {
  const turnArtifacts = artifacts
    .filter((artifact) => artifact.name.endsWith("-debug.md"))
    .sort((left, right) => left.name.localeCompare(right.name));

  return [
    "# VoidBot Debug Trace",
    "",
    "This artifact summarizes visible model progress messages, MCP tool calls, command attempts, timing, usage, and handoff causes.",
    "It is intended for debugging the Discord-safe owner lane without exposing private chain-of-thought verbatim.",
    "",
    "## Turn Summary",
    "",
    turnResults.length > 0
      ? turnResults
          .map((result, index) => {
            const mcpCalls = collectMcpToolCalls(result.traceEvents);
            const completedCalls = mcpCalls.filter((call) => call.completedEvent).length;
            const failedCalls = mcpCalls.filter(
              (call) => call.completedEvent?.status === "failed",
            ).length;
            const commands = collectCommandExecutions(result.traceEvents);

            return [
              `- Turn ${index + 1}: duration=${formatDurationMs(result.durationMs)}`,
              `  usage=${renderUsageSummary(result.usage)}`,
              `  mcp_calls=${mcpCalls.length} completed=${completedCalls} failed=${failedCalls}`,
              `  commands=${commands.length} handoff=${result.handoffReason ?? "(none)"}`,
            ].join("\n");
          })
          .join("\n")
      : "- No turn results were recorded.",
    "",
    "## Turn Artifacts",
    "",
    turnArtifacts.length > 0
      ? turnArtifacts.map((artifact) => `- ${artifact.name}`).join("\n")
      : "- No per-turn debug artifacts were generated.",
    "",
  ].join("\n");
}

function renderAgentMessageTrace(events: CodexTraceEvent[]): string {
  const messages = events
    .filter((event) => event.kind === "agent_message" && event.message)
    .map(
      (event) =>
        `- ${formatElapsedMs(event.elapsedMs)} ${sanitizeTraceText(event.message ?? "", 280)}`,
    );

  return messages.length > 0 ? messages.join("\n") : "- No visible agent progress messages were captured.";
}

function renderMcpToolTrace(events: CodexTraceEvent[]): string {
  const calls = collectMcpToolCalls(events);

  if (calls.length === 0) {
    return "- No MCP tool activity was captured.";
  }

  return calls
    .map((call, index) => {
      const completed = call.completedEvent;
      const started = call.startedEvent;
      const anchor = completed ?? started;
      const summary = [
        `- Call ${index + 1}: ${call.server ?? "(unknown server)"}/${call.tool ?? "(unknown tool)"}`,
        `  started=${started ? formatElapsedMs(started.elapsedMs) : "(unknown)"}`,
        `  completed=${completed ? formatElapsedMs(completed.elapsedMs) : "(not completed)"}`,
        `  duration=${
          started && completed
            ? formatDurationMs(completed.elapsedMs - started.elapsedMs)
            : "(unknown)"
        }`,
        `  status=${completed?.status ?? started?.status ?? "(unknown)"}`,
      ];

      if (anchor?.arguments) {
        summary.push(`  args=${sanitizeTraceText(JSON.stringify(anchor.arguments), 260)}`);
      }

      if (completed?.resultPreview) {
        summary.push(`  result=${sanitizeTraceText(completed.resultPreview, 320)}`);
      }

      if (completed?.error) {
        summary.push(`  error=${sanitizeTraceText(completed.error, 220)}`);
      }

      return summary.join("\n");
    })
    .join("\n");
}

function renderCommandTrace(events: CodexTraceEvent[]): string {
  const commands = collectCommandExecutions(events);

  if (commands.length === 0) {
    return "- No command activity was captured.";
  }

  return commands
    .map((command, index) => {
      const completed = command.completedEvent;
      const started = command.startedEvent;
      const anchor = completed ?? started;
      const summary = [
        `- Command ${index + 1}: ${sanitizeTraceText(anchor?.command ?? "(unknown command)", 220)}`,
        `  started=${started ? formatElapsedMs(started.elapsedMs) : "(unknown)"}`,
        `  completed=${completed ? formatElapsedMs(completed.elapsedMs) : "(not completed)"}`,
        `  duration=${
          started && completed
            ? formatDurationMs(completed.elapsedMs - started.elapsedMs)
            : "(unknown)"
        }`,
        `  status=${completed?.status ?? started?.status ?? "(unknown)"} exit=${completed?.exitCode ?? "(none)"}`,
      ];

      const output = completed?.output?.trim();

      if (output) {
        summary.push(`  output=${sanitizeTraceText(output, 320)}`);
      }

      return summary.join("\n");
    })
    .join("\n");
}

interface TimedTraceOperation {
  itemId: string;
  startedEvent?: CodexTraceEvent;
  completedEvent?: CodexTraceEvent;
  command?: string;
  server?: string;
  tool?: string;
}

function renderAggregateMcpToolTranscript(turnResults: CodexRunResult[]): string {
  const sections = turnResults
    .map((result, index) => {
      const rendered = renderMcpToolTrace(result.traceEvents);

      return [
        `Turn ${index + 1}: duration=${formatDurationMs(result.durationMs)} usage=${renderUsageSummary(result.usage)}`,
        rendered,
      ].join("\n");
    })
    .filter((section) => section.trim().length > 0);

  return sections.length > 0 ? sections.join("\n\n") : "- No Codex MCP tool calls were recorded.";
}

function collectMcpToolCalls(events: CodexTraceEvent[]): TimedTraceOperation[] {
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

function collectCommandExecutions(events: CodexTraceEvent[]): TimedTraceOperation[] {
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

function renderUsageSummary(usage: CodexUsageSnapshot | undefined): string {
  if (!usage) {
    return "(not reported)";
  }

  return [
    `input=${usage.inputTokens ?? 0}`,
    `cached=${usage.cachedInputTokens ?? 0}`,
    `output=${usage.outputTokens ?? 0}`,
  ].join(" ");
}

function formatElapsedMs(elapsedMs: number): string {
  return `+${formatDurationMs(elapsedMs)}`;
}

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs)) {
    return "(unknown)";
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
}

function summarizeStderrDiagnostics(stderr: string): string[] {
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

function sanitizeTraceText(input: string, limit: number): string {
  const collapsed = input.replace(/\s+/g, " ").trim();

  if (collapsed.length <= limit) {
    return collapsed;
  }

  return `${collapsed.slice(0, limit - 3)}...`;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsage(value: unknown): CodexUsageSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    inputTokens: readNumber(value.input_tokens),
    cachedInputTokens: readNumber(value.cached_input_tokens),
    outputTokens: readNumber(value.output_tokens),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function summarizeUnknown(value: unknown, limit: number): string | undefined {
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

function summarizeToolResult(value: unknown): string | undefined {
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

  if (Array.isArray(value.content)) {
    for (const entry of value.content) {
      if (!isRecord(entry)) {
        continue;
      }

      const text = readString(entry, "text");

      if (text) {
        return sanitizeTraceText(text, 320);
      }
    }
  }

  return summarizeUnknown(value, 320);
}
