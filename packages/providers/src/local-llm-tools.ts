import {
  DEFAULT_RETRIEVAL_RESULT_LIMIT,
  type ContextBundle,
} from "@voidbot/shared";

import {
  MAX_CONTEXT_WINDOW,
  MAX_TOOL_RESULTS,
  type LocalLlmToolbox,
  type OllamaChatMessage,
  type OllamaChatResponse,
  type OllamaToolCall,
  type OllamaToolCallDefinition,
  normalizeModelText,
  type ToolTraceRecord,
} from "./local-llm-shared";

export function buildToolDefinitions(): OllamaToolCallDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "search_history",
        description:
          "Search archived Discord history for prior conversations, real incidents, personal stories, decisions, preferences, relationship history, and discussion fragments from the server.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description: "What to search for in the Discord history archive.",
            },
            limit: {
              type: "integer",
              description: `Maximum number of results to return, between 1 and ${MAX_TOOL_RESULTS}.`,
            },
            channelId: {
              type: "string",
              description: "Optional Discord channel ID filter.",
            },
            authorId: {
              type: "string",
              description: "Optional Discord author ID filter.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_message_context",
        description:
          "Fetch the surrounding conversation window for a specific archived Discord message.",
        parameters: {
          type: "object",
          required: ["messageId"],
          properties: {
            messageId: {
              type: "string",
              description: "The archived Discord message ID.",
            },
            before: {
              type: "integer",
              description: "How many earlier messages to include, between 0 and 20.",
            },
            after: {
              type: "integer",
              description: "How many later messages to include, between 0 and 20.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_sources",
        description:
          "Search indexed source trees and lore repositories for code, documentation, authored worldbuilding, and project material. Use this for repo/lore questions, not as the first stop for real-life incidents or prior Discord conversations. Omit repoName to search across all indexed repos, or call list_indexed_repos first if you need valid repo names.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description: "What to search for in indexed source and lore documents.",
            },
            limit: {
              type: "integer",
              description: `Maximum number of results to return, between 1 and ${MAX_TOOL_RESULTS}.`,
            },
            repoName: {
              type: "string",
              description: "Optional repository name filter.",
            },
            pathPrefix: {
              type: "string",
              description: "Optional path prefix filter within a repository.",
            },
            language: {
              type: "string",
              description: "Optional source language filter.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_indexed_repos",
        description:
          "List the indexed source and lore repositories currently available to search. Use this when you want valid repoName filters for search_sources.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_source_context",
        description:
          "Fetch adjacent chunk context from a specific indexed source document or lore file.",
        parameters: {
          type: "object",
          required: ["sourceId"],
          properties: {
            sourceId: {
              type: "string",
              description: "The source document ID from a search_sources result.",
            },
            chunkIndex: {
              type: "integer",
              description: "Optional anchor chunk index inside the document.",
            },
            before: {
              type: "integer",
              description: "How many earlier chunks to include, between 0 and 20.",
            },
            after: {
              type: "integer",
              description: "How many later chunks to include, between 0 and 20.",
            },
          },
        },
      },
    },
  ];
}

export function normalizeAssistantMessage(payload: OllamaChatResponse): OllamaChatMessage {
  const message =
    typeof payload.message === "object" && payload.message !== null
      ? payload.message
      : {};

  return {
    role: "assistant",
    content: normalizeModelText(message.content) ?? "",
    thinking:
      normalizeModelText(message.thinking) ?? normalizeModelText(payload.thinking),
    tool_calls: normalizeToolCalls(message.tool_calls),
  };
}

export async function executeToolCall(
  toolbox: LocalLlmToolbox,
  context: ContextBundle,
  toolCall: OllamaToolCall,
): Promise<{
  payload: Record<string, unknown>;
  trace: ToolTraceRecord;
}> {
  const toolName = normalizeModelText(toolCall.function?.name) ?? "unknown_tool";
  const args = normalizeToolArguments(toolCall.function?.arguments);
  let payload: Record<string, unknown>;

  switch (toolName) {
    case "list_indexed_repos":
      payload = await toolbox.listIndexedRepos();
      break;
    case "search_history":
      payload = await toolbox.searchHistory({
        query: readRequiredString(args.query, "query"),
        limit: clampInteger(args.limit, 1, MAX_TOOL_RESULTS, DEFAULT_RETRIEVAL_RESULT_LIMIT),
        guildId: context.guildContext.guildId,
        channelId: readOptionalString(args.channelId),
        authorId: readOptionalString(args.authorId),
      });
      break;
    case "get_message_context":
      payload = await toolbox.getMessageContext({
        messageId: readRequiredString(args.messageId, "messageId"),
        before: clampInteger(args.before, 0, MAX_CONTEXT_WINDOW, 4),
        after: clampInteger(args.after, 0, MAX_CONTEXT_WINDOW, 4),
      });
      break;
    case "search_sources":
      payload = await toolbox.searchSources({
        query: readRequiredString(args.query, "query"),
        limit: clampInteger(args.limit, 1, MAX_TOOL_RESULTS, DEFAULT_RETRIEVAL_RESULT_LIMIT),
        repoName: readOptionalString(args.repoName),
        pathPrefix: readOptionalString(args.pathPrefix),
        language: readOptionalString(args.language),
      });
      break;
    case "get_source_context":
      payload = await toolbox.getSourceContext({
        sourceId: readRequiredString(args.sourceId, "sourceId"),
        chunkIndex: clampInteger(args.chunkIndex, 0, 10_000, 0),
        before: clampInteger(args.before, 0, MAX_CONTEXT_WINDOW, 1),
        after: clampInteger(args.after, 0, MAX_CONTEXT_WINDOW, 1),
      });
      break;
    default:
      payload = {
        error: `Unsupported tool: ${toolName}`,
      };
      break;
  }

  return {
    payload,
    trace: {
      tool: toolName,
      arguments: args,
      result: payload,
    },
  };
}

function normalizeToolCalls(value: unknown): OllamaToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((call) => {
    if (typeof call !== "object" || call === null) {
      return false;
    }

    const toolCall = call as OllamaToolCall;
    return (
      typeof toolCall.function === "object" &&
      toolCall.function !== null &&
      typeof toolCall.function.name === "string"
    );
  }) as OllamaToolCall[];
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRequiredString(value: unknown, key: string): string {
  const normalized = readOptionalString(value);

  if (!normalized) {
    throw new Error(`Tool argument "${key}" is required.`);
  }

  return normalized;
}

function clampInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return Math.max(minimum, Math.min(maximum, normalized));
}
