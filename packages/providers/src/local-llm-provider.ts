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

      for (let turn = 0; turn <= MAX_TOOL_TURNS; turn += 1) {
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
