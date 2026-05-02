import {
  MAX_RETRIEVAL_RESULT_LIMIT,
  type ProviderArtifact,
} from "@voidbot/shared";

export type OllamaThinkMode = boolean | "low" | "medium" | "high";
export const MAX_TOOL_TURNS = 4;
export const MAX_TOOL_RESULTS = MAX_RETRIEVAL_RESULT_LIMIT;
export const MAX_CONTEXT_WINDOW = 20;

export interface OllamaToolCallDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  thinking?: string;
}

export interface OllamaToolCall {
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

export interface OllamaChatResponse {
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: unknown;
  };
  thinking?: unknown;
  done_reason?: unknown;
  eval_count?: unknown;
  prompt_eval_count?: unknown;
}

type IndexedRepoToolResult = Record<string, unknown> & {
  repoCount: number;
  repos: Array<{
    repoName: string;
    documentCount: number;
  }>;
};

export interface LocalLlmToolbox {
  listIndexedRepos(): Promise<IndexedRepoToolResult>;
  searchHistory(input: {
    query: string;
    limit: number;
    guildId?: string;
    channelId?: string;
    authorId?: string;
  }): Promise<{
    query: string;
    resultCount: number;
    results: Array<Record<string, unknown>>;
  }>;
  getMessageContext(input: {
    messageId: string;
    before: number;
    after: number;
  }): Promise<{
    found: boolean;
    messageId: string;
    count: number;
    messages: Array<Record<string, unknown>>;
  }>;
  searchSources(input: {
    query: string;
    limit: number;
    repoName?: string;
    pathPrefix?: string;
    language?: string;
  }): Promise<{
    query: string;
    resultCount: number;
    results: Array<Record<string, unknown>>;
  }>;
  getSourceContext(input: {
    sourceId: string;
    chunkIndex: number;
    before: number;
    after: number;
  }): Promise<{
    found: boolean;
    sourceId: string;
    count: number;
    repoName?: string;
    path?: string;
    language?: string;
    chunks: Array<Record<string, unknown>>;
  }>;
}

export interface LocalLlmProviderOptions {
  enabled: boolean;
  ownerDiscordId: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  ollamaKeepAlive: string;
  ollamaThink: OllamaThinkMode;
  ollamaNumCtx: number;
  allowPublicResponses: boolean;
  toolbox?: LocalLlmToolbox;
}

export interface ToolTraceRecord {
  tool: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface LocalLlmArtifactsInput {
  requestBody: Record<string, unknown>;
  payload: OllamaChatResponse;
  thinkingTrace: string[];
  toolTrace: ToolTraceRecord[];
}

export function buildBaseArtifacts(input: LocalLlmArtifactsInput): ProviderArtifact[] {
  const artifacts: ProviderArtifact[] = [
    {
      name: "local-llm-request.json",
      contentType: "json",
      content: `${JSON.stringify(input.requestBody, null, 2)}\n`,
    },
    {
      name: "local-llm-response.json",
      contentType: "json",
      content: `${JSON.stringify(input.payload, null, 2)}\n`,
    },
    {
      name: "local-llm-tool-trace.json",
      contentType: "json",
      content: `${JSON.stringify(input.toolTrace, null, 2)}\n`,
    },
  ];

  if (input.thinkingTrace.length > 0) {
    artifacts.push({
      name: "local-llm-thinking.txt",
      contentType: "text",
      content: `${input.thinkingTrace.join("\n\n---\n\n")}\n`,
    });
  }

  return artifacts;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeModelText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readNumericMetadata(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}
