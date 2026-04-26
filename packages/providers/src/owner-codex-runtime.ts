import { spawn } from "node:child_process";

import type {
  CodexMcpServerConfig,
  ContextBundle,
  ProviderNotificationIntent,
  ProviderNotificationReason,
  RetrievalFilters,
} from "@voidbot/shared";

import {
  DEFAULT_RETRIEVAL_RESULT_LIMIT,
  MAX_RETRIEVAL_RESULT_LIMIT,
} from "@voidbot/shared";

import {
  extractLatestUsage,
  clamp,
  type CodexRunResult,
  type CodexTraceEvent,
  type CodexUsageSnapshot,
  HANDOFF_SENTINEL,
  type HistoryLookupTool,
  type HistoryToolRequest,
  isRecord,
  MAX_NOTIFICATION_MESSAGE_LENGTH,
  OWNER_NOTIFY_SENTINEL,
  readNumber,
  readRecord,
  readString,
  readUsage,
  summarizeToolResult,
  summarizeUnknown,
  TOOL_REQUEST_SENTINEL,
  type NormalizedDiscordReply,
  type ToolCallRecord,
} from "./owner-codex-shared";

const DEFAULT_HISTORY_LIMIT = DEFAULT_RETRIEVAL_RESULT_LIMIT;
const MAX_HISTORY_LIMIT = MAX_RETRIEVAL_RESULT_LIMIT;

export async function runCodexExec(input: {
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
        const traceEvent = tryParseTraceEvent(
          line,
          traceEvents.length + 1,
          startedAtMs,
        );

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
        handoffReason:
          "The local Codex executable was not available for automatic Discord replies.",
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      if (stdoutBuffer.trim().length > 0) {
        const traceEvent = tryParseTraceEvent(
          stdoutBuffer.trim(),
          traceEvents.length + 1,
          startedAtMs,
        );

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

export function normalizeDiscordReply(stdout: string): NormalizedDiscordReply {
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
        const message =
          readString(event.item, "text") ?? readString(event.item, "message");

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

export async function executeHistoryLookup(
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

function buildMcpConfigArguments(mcpServers: CodexMcpServerConfig[]): string[] {
  const argumentsList: string[] = [];

  for (const server of mcpServers) {
    argumentsList.push(
      "-c",
      `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
    );
    argumentsList.push(
      "-c",
      `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`,
    );

    if (server.cwd) {
      argumentsList.push(
        "-c",
        `mcp_servers.${server.name}.cwd=${JSON.stringify(server.cwd)}`,
      );
    }

    for (const [key, value] of Object.entries(server.env ?? {})) {
      argumentsList.push(
        "-c",
        `mcp_servers.${server.name}.env.${key}=${JSON.stringify(value)}`,
      );
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
      const message =
        readString(event.item, "text") ?? readString(event.item, "message");

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
      const message =
        readString(item, "text") ?? readString(item, "message");

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

function unwrapCodexEvent(parsed: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(parsed.msg) && typeof parsed.msg.type === "string") {
    return parsed.msg;
  }

  if (isRecord(parsed.payload) && typeof parsed.payload.type === "string") {
    return parsed.payload;
  }

  return parsed;
}

function parseHistoryToolRequest(
  message: string | undefined,
): HistoryToolRequest | undefined {
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

    const rawLimit =
      typeof parsed.limit === "number" ? parsed.limit : DEFAULT_HISTORY_LIMIT;
    const limit = clamp(Math.trunc(rawLimit), 1, MAX_HISTORY_LIMIT);

    return {
      tool: "search_history",
      query: query.slice(0, 240),
      limit,
      channelId:
        typeof parsed.channelId === "string" ? parsed.channelId : undefined,
      authorId: typeof parsed.authorId === "string" ? parsed.authorId : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseOwnerNotificationIntent(
  line: string,
): ProviderNotificationIntent | undefined {
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

function normalizeNotificationReason(
  value: unknown,
): ProviderNotificationReason {
  if (value === "completion" || value === "failure" || value === "handoff") {
    return value;
  }

  return "custom";
}
