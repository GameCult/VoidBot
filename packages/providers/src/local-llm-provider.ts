import {
  type Actor,
  type ContextBundle,
  type GuildContext,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
} from "@voidbot/shared";

import {
  buildArtifacts,
  buildPrompt,
  buildSystemPrompt,
} from "./local-llm-render";
import {
  executeToolCall,
  buildToolDefinitions,
  normalizeAssistantMessage,
} from "./local-llm-tools";
import {
  MAX_TOOL_TURNS,
  type LocalLlmProviderOptions,
  type OllamaChatMessage,
  type OllamaChatResponse,
  normalizeBaseUrl,
  normalizeModelText,
  readNumericMetadata,
  type ToolTraceRecord,
} from "./local-llm-shared";

export type {
  LocalLlmProviderOptions,
  LocalLlmToolbox,
} from "./local-llm-shared";

const FINAL_OUTPUT_REWRITE_LIMIT = 1;
const METADATA_ONLY_KEYS = new Set([
  "timestamp",
  "editedAt",
  "authorId",
  "authorName",
  "channelId",
  "channelName",
  "threadId",
  "jumpUrl",
  "sourceId",
  "repoName",
  "path",
  "language",
  "title",
  "score",
  "text",
  "chunkIndex",
  "lineStart",
  "lineEnd",
  "query",
  "found",
  "count",
  "resultCount",
  "messages",
  "results",
  "repos",
  "repoCount",
  "chunks",
]);
const STRUCTURED_OUTPUT_REQUEST_PATTERN =
  /\b(json|yaml|yml|xml|csv|tsv|object|array|schema|key-value|key value|machine-readable|machine readable)\b/i;
const RAW_TOOL_OUTPUT_REWRITE_PROMPT = [
  "You just returned raw JSON or a tool payload fragment instead of answering the user.",
  "Do not paste raw tool output.",
  "Answer the user's question directly in concise natural-language Discord prose using the context you already gathered.",
].join(" ");

export class LocalLlmProvider implements ProviderAdapter {
  public constructor(private readonly options: LocalLlmProviderOptions) {}

  public getName(): "local_llm" {
    return "local_llm";
  }

  public getCapabilities(): string[] {
    return [
      "local_generation",
      "retrieval_augmented_prompt",
      "tool_driven_retrieval",
      "no_privileged_tools",
    ];
  }

  public isEnabled(): boolean {
    return this.options.enabled;
  }

  public isAllowedForActor(actor: Actor, _guildContext: GuildContext): boolean {
    if (!this.options.enabled) {
      return false;
    }

    if (this.options.allowPublicResponses) {
      return true;
    }

    return actor.id === this.options.ownerDiscordId || actor.isAdmin;
  }

  public buildRequest(
    contextBundle: ContextBundle,
    options?: Record<string, unknown>,
  ): ProviderRequest {
    return {
      provider: "local_llm",
      contextBundle,
      options,
    };
  }

  public async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const systemPrompt = buildSystemPrompt(request.contextBundle);
    const messages: OllamaChatMessage[] = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: buildPrompt(request.contextBundle),
      },
    ];
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.options.ollamaTimeoutMs);
    const tools = this.options.toolbox ? buildToolDefinitions() : undefined;
    const toolTrace: ToolTraceRecord[] = [];
    const thinkingTrace: string[] = [];

    try {
      let finalPayload: OllamaChatResponse | undefined;
      let finalOutputText: string | undefined;
      let rewriteAttempts = 0;

      for (let turn = 0; turn <= MAX_TOOL_TURNS; ) {
        const requestBody = {
          model: this.options.ollamaModel,
          messages,
          tools,
          stream: false,
          think: this.options.ollamaThink,
          keep_alive: this.options.ollamaKeepAlive,
          options: {
            num_ctx: this.options.ollamaNumCtx,
          },
        };
        const response = await fetch(
          `${normalizeBaseUrl(this.options.ollamaBaseUrl)}/api/chat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(
            `Ollama chat request failed with ${response.status}: ${await response.text()}`,
          );
        }

        const payload = (await response.json()) as OllamaChatResponse;
        finalPayload = payload;
        const assistantMessage = normalizeAssistantMessage(payload);
        const toolCalls = assistantMessage.tool_calls ?? [];

        if (assistantMessage.thinking) {
          thinkingTrace.push(assistantMessage.thinking);
        }

        messages.push(assistantMessage);

        if (toolCalls.length === 0) {
          const candidateOutput = normalizeModelText(assistantMessage.content);

          if (
            candidateOutput &&
            rewriteAttempts < FINAL_OUTPUT_REWRITE_LIMIT &&
            shouldRewriteStructuredOutput(
              candidateOutput,
              request.contextBundle.prompt,
              toolTrace.length,
            )
          ) {
            rewriteAttempts += 1;
            messages.push({
              role: "user",
              content: RAW_TOOL_OUTPUT_REWRITE_PROMPT,
            });
            continue;
          }

          finalOutputText = candidateOutput;
          break;
        }

        if (!this.options.toolbox) {
          finalOutputText =
            "The local model asked for tools, but this lane was not given any. That is a wiring problem.";
          break;
        }

        if (turn >= MAX_TOOL_TURNS) {
          finalOutputText =
            "The local model kept reaching for more archive context than this lane can chase in one pass. Ask more narrowly or use the deeper Codex lane.";
          break;
        }

        for (const toolCall of toolCalls) {
          const execution = await executeToolCall(
            this.options.toolbox,
            request.contextBundle,
            toolCall,
          );
          toolTrace.push(execution.trace);
          messages.push({
            role: "tool",
            tool_name: execution.trace.tool,
            content: JSON.stringify(execution.payload, null, 2),
          });
        }

        turn += 1;
      }

      if (!finalOutputText) {
        throw new Error(
          `Ollama returned no final response content for model "${this.options.ollamaModel}".`,
        );
      }

      const artifacts = buildArtifacts({
        requestBody: {
          model: this.options.ollamaModel,
          messages,
          tools,
          stream: false,
          think: this.options.ollamaThink,
          keep_alive: this.options.ollamaKeepAlive,
          options: {
            num_ctx: this.options.ollamaNumCtx,
          },
        },
        payload: finalPayload ?? {},
        thinkingTrace,
        toolTrace,
      });

      return {
        status: "completed",
        summary: "Local Ollama response generated.",
        outputText: finalOutputText,
        artifacts,
        metadata: {
          model: this.options.ollamaModel,
          retrieval_snippets: String(request.contextBundle.retrieval.length),
          thinking_trace: thinkingTrace.length > 0 ? "present" : "absent",
          tool_calls: String(toolTrace.length),
          prompt_eval_count: readNumericMetadata(finalPayload?.prompt_eval_count),
          eval_count: readNumericMetadata(finalPayload?.eval_count),
          done_reason: normalizeModelText(finalPayload?.done_reason) ?? "unknown",
        },
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          `Timed out waiting for local Ollama model "${this.options.ollamaModel}" at ${this.options.ollamaBaseUrl}.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  public async estimateCost(_request: ProviderRequest): Promise<number> {
    return 0;
  }

  public getAuditRedactions(): string[] {
    return [];
  }
}

function shouldRewriteStructuredOutput(
  candidateOutput: string,
  userPrompt: string,
  toolTraceCount: number,
): boolean {
  if (STRUCTURED_OUTPUT_REQUEST_PATTERN.test(userPrompt)) {
    return false;
  }

  const parsed = parseStructuredOutput(candidateOutput);

  if (parsed === undefined) {
    return false;
  }

  if (toolTraceCount > 0) {
    return true;
  }

  return isMetadataOnlyValue(parsed);
}

function parseStructuredOutput(input: string): unknown {
  const normalized = unwrapStructuredFence(input);

  if (!normalized.startsWith("{") && !normalized.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return undefined;
  }
}

function unwrapStructuredFence(input: string): string {
  const trimmed = input.trim();
  const match = /^```(?:json|yaml|yml)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

function isMetadataOnlyValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => isMetadataOnlyValue(entry));
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const entries = Object.entries(value);

  if (entries.length === 0) {
    return false;
  }

  return entries.every(([key, child]) => {
    if (!METADATA_ONLY_KEYS.has(key)) {
      return false;
    }

    if (Array.isArray(child)) {
      return child.every((entry) =>
        entry && typeof entry === "object" ? isMetadataOnlyValue(entry) : isScalarMetadataValue(entry),
      );
    }

    if (child && typeof child === "object") {
      return isMetadataOnlyValue(child);
    }

    return isScalarMetadataValue(child);
  });
}

function isScalarMetadataValue(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}
