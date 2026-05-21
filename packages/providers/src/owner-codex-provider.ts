import type {
  Actor,
  ContextBundle,
  GuildContext,
  ProviderAdapter,
  ProviderArtifact,
  ProviderRequest,
  ProviderResponse,
} from "@voidbot/shared";

import {
  buildDefaultHandoffNotice,
  buildRequestPayload,
  type HistoryLookupTool,
  MAX_HISTORY_TOOL_CALLS,
  type OwnerCodexProviderOptions,
  type ToolCallRecord,
} from "./owner-codex-shared";
import {
  buildDiscordReplyPrompt,
  renderAggregateDebugTrace,
  renderCodexDebugTrace,
  renderHandoffBundle,
  renderMarkdownBundle,
  renderToolTranscript,
} from "./owner-codex-render";
import {
  executeHistoryLookup,
  normalizeDiscordReply,
  runCodexExec,
} from "./owner-codex-runtime";

export type { HistoryLookupTool, OwnerCodexProviderOptions };

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
    return (
      this.options.handoffNoticeBuilder?.(jobId) ??
      buildDefaultHandoffNotice(jobId)
    );
  }

  private buildManualPackage(request: ProviderRequest): ProviderResponse {
    const requestPayload = buildRequestPayload(request);

    return {
      status: "ready_for_review",
      summary:
        "Manual Codex package generated. Review the bundle, run it manually, then approve the final post.",
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

  private async executeLocalOwnerFlow(
    request: ProviderRequest,
  ): Promise<ProviderResponse> {
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
        summary:
          "Owner request was routed to a fuller Codex handoff instead of a direct Discord reply.",
        outputText: this.buildHandoffNotice(jobId),
        artifacts: [
          ...baseArtifacts,
          {
            name: "handoff.md",
            contentType: "markdown",
            content: renderHandoffBundle(
              request.contextBundle,
              "Requested via /queue-codex.",
            ),
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
    const turnResults = [];
    let result;

    for (let turn = 0; turn <= MAX_HISTORY_TOOL_CALLS; turn += 1) {
      const codexPrompt = buildDiscordReplyPrompt(
        request.contextBundle,
        toolCalls,
        false,
      );

      result = await runCodexExec({
        executable: this.options.executable,
        executableArgs: this.options.executableArgs,
        model: getStringOption(request.options?.model) ?? this.options.model,
        reasoningEffort: getReasoningEffortOption(request.options?.reasoningEffort) ?? this.options.reasoningEffort,
        timeoutMs: this.options.timeoutMs,
        workingDirectory: this.options.workingDirectory,
        prompt: codexPrompt,
        mcpServers: command === "repo-face-rumination"
          ? restrictMcpServersToRepoFaceExploration(this.options.mcpServers ?? [])
          : this.options.mcpServers ?? [],
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

    artifacts.push(
      {
        name: "rag-tool-transcript.md",
        contentType: "markdown",
        content: renderToolTranscript(toolCalls, turnResults),
      },
      {
        name: "debug-trace.md",
        contentType: "markdown",
        content: renderAggregateDebugTrace(artifacts, turnResults),
      },
    );

    if (!result) {
      return {
        status: "completed",
        summary:
          "Codex local exec did not start, so VoidBot returned a handoff notice instead.",
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
        summary:
          "Codex local exec timed out, so VoidBot returned a handoff notice instead.",
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
        summary:
          "Codex determined that this request should move into a fuller local session.",
        outputText: this.buildHandoffNotice(jobId),
        artifacts: [
          ...artifacts,
          {
            name: "handoff.md",
            contentType: "markdown",
            content: renderHandoffBundle(
              request.contextBundle,
              result.handoffReason,
            ),
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
        summary:
          "Codex did not produce a Discord-safe reply, so VoidBot returned a handoff notice.",
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

function getStringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getReasoningEffortOption(value: unknown): "low" | "medium" | "high" | "xhigh" | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  return undefined;
}

function restrictMcpServersToRepoFaceExploration(
  servers: NonNullable<OwnerCodexProviderOptions["mcpServers"]>,
): NonNullable<OwnerCodexProviderOptions["mcpServers"]> {
  const allowedTools = [
    "search_history",
    "get_message_context",
    "list_indexed_repos",
    "search_sources",
    "get_source_context",
  ].join(",");

  return servers.map((server) => ({
    ...server,
    env: {
      ...(server.env ?? {}),
      VOIDBOT_MCP_TOOL_ALLOWLIST: allowedTools,
    },
  }));
}
