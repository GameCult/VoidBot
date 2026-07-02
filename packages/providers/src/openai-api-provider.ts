import { readFile } from "node:fs/promises";

import {
  type Actor,
  type ContextBundle,
  type GuildContext,
  type ProviderAdapter,
  type ProviderArtifact,
  type ProviderRequest,
  type ProviderResponse,
} from "@voidbot/shared";

export interface OpenAiApiProviderOptions {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  apiKeyFile?: string;
  model: string;
  timeoutMs: number;
  authHeader: string;
  maxCompletionTokens: number;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  id?: unknown;
  model?: unknown;
}

export class OpenAiApiProvider implements ProviderAdapter {
  public constructor(private readonly options: OpenAiApiProviderOptions) {}

  public getName(): "openai_api" {
    return "openai_api";
  }

  public getCapabilities(): string[] {
    return [
      "openai_compatible_chat_completions",
      "direct_api_generation",
      "persona_runtime",
    ];
  }

  public isEnabled(): boolean {
    return this.options.enabled;
  }

  public isAllowedForActor(_actor: Actor, _guildContext: GuildContext): boolean {
    return this.options.enabled;
  }

  public buildRequest(
    contextBundle: ContextBundle,
    options?: Record<string, unknown>,
  ): ProviderRequest {
    return {
      provider: "openai_api",
      contextBundle,
      options,
    };
  }

  public async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const model = readStringOption(request.options?.model) ?? this.options.model;
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: request.contextBundle.prompt,
      },
    ];
    const requestBody = {
      model,
      messages,
      stream: false,
      max_completion_tokens: readPositiveIntegerOption(request.options?.maxCompletionTokens) ??
        this.options.maxCompletionTokens,
    };
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const apiKey = await this.loadApiKey();
      const response = await fetch(`${normalizeBaseUrl(this.options.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible chat request failed with ${response.status}: ${redactSecret(responseText, apiKey).slice(0, 2000)}`,
        );
      }

      const payload = JSON.parse(responseText) as ChatCompletionResponse;
      const outputText = normalizeModelText(payload.choices?.[0]?.message?.content);

      if (!outputText) {
        const finishReason = normalizeModelText(payload.choices?.[0]?.finish_reason) ?? "unknown";
        throw new Error(
          `OpenAI-compatible chat response did not include assistant content (finish_reason=${finishReason}).`,
        );
      }

      return {
        status: "completed",
        summary: `OpenAI-compatible API response generated with ${model}.`,
        outputText,
        artifacts: buildArtifacts(requestBody, payload),
        metadata: {
          model,
          provider_model: normalizeModelText(payload.model) ?? model,
          finish_reason: normalizeModelText(payload.choices?.[0]?.finish_reason) ?? "unknown",
          prompt_tokens: readNumericMetadata(payload.usage?.prompt_tokens),
          completion_tokens: readNumericMetadata(payload.usage?.completion_tokens),
          total_tokens: readNumericMetadata(payload.usage?.total_tokens),
        },
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          `Timed out waiting for OpenAI-compatible model "${model}" at ${this.options.baseUrl}.`,
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
    return ["api_key", "authorization"];
  }

  private async loadApiKey(): Promise<string> {
    const direct = this.options.apiKey?.trim();
    if (direct) {
      return direct;
    }

    if (this.options.apiKeyFile) {
      const fromFile = (await readFile(this.options.apiKeyFile, "utf8")).trim();
      if (fromFile) {
        return fromFile;
      }
    }

    throw new Error("OpenAI-compatible API provider is enabled but no API key is configured.");
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const authHeader = this.options.authHeader.trim();
    if (authHeader.toLowerCase() === "authorization") {
      headers.Authorization = `Bearer ${apiKey}`;
    } else {
      headers[authHeader] = apiKey;
    }
    return headers;
  }
}

function buildArtifacts(
  requestBody: Record<string, unknown>,
  payload: ChatCompletionResponse,
): ProviderArtifact[] {
  return [
    {
      name: "openai-api-request.json",
      contentType: "json",
      content: `${JSON.stringify(requestBody, null, 2)}\n`,
    },
    {
      name: "openai-api-response.json",
      contentType: "json",
      content: `${JSON.stringify(payload, null, 2)}\n`,
    },
  ];
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeModelText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringOption(value: unknown): string | undefined {
  return normalizeModelText(value);
}

function readPositiveIntegerOption(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function readNumericMetadata(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}
