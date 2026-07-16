import { readFile } from "node:fs/promises";
import type { loadConfig } from "@voidbot/config";

export async function requestBoundedTextCompletion(input: {
  prompt: string;
  config: ReturnType<typeof loadConfig>;
  purpose: string;
  model?: string;
  maxCompletionTokens: number;
}, dependencies: { fetch?: typeof fetch; readText?: (path: string) => Promise<string> } = {}): Promise<string> {
  const api = input.config.openAiApi;
  const apiKey = api.apiKey ?? (api.apiKeyFile ? (await (dependencies.readText ?? ((path) => readFile(path, "utf8")))(api.apiKeyFile)).trim() : undefined);
  if (!apiKey) throw new Error(`${input.purpose} requires the configured OpenAI-compatible API key.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), api.timeoutMs);
  try {
    const response = await (dependencies.fetch ?? fetch)(`${api.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [api.authHeader]: api.authHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey },
      body: JSON.stringify({
        model: input.model ?? api.model,
        messages: [{ role: "user", content: input.prompt }],
        stream: false,
        max_completion_tokens: Math.min(api.maxCompletionTokens, Math.max(256, input.maxCompletionTokens)),
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`${input.purpose} request failed with ${response.status}: ${redact(responseText, apiKey).slice(0, 1000)}`);
    const payload = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error(`${input.purpose} response contained no assistant text.`);
    return content.trim();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`${input.purpose} request timed out after ${api.timeoutMs}ms.`);
    throw error;
  } finally { clearTimeout(timeout); }
}

function redact(value: string, secret: string): string { return secret ? value.split(secret).join("[redacted]") : value; }
