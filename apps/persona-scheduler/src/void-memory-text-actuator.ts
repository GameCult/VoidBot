import { readFile } from "node:fs/promises";
import type { loadConfig } from "@voidbot/config";

export async function projectVoidMemoryOperations(input: {
  prompt: string;
  config: ReturnType<typeof loadConfig>;
  model?: string;
}, dependencies: { fetch?: typeof fetch; readText?: (path: string) => Promise<string> } = {}): Promise<string> {
  const api = input.config.openAiApi;
  const apiKey = api.apiKey ?? (api.apiKeyFile ? (await (dependencies.readText ?? ((path) => readFile(path, "utf8")))(api.apiKeyFile)).trim() : undefined);
  if (!apiKey) throw new Error("Void memory maintenance requires the configured OpenAI-compatible API key.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), api.timeoutMs);
  try {
    const response = await (dependencies.fetch ?? fetch)(`${api.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", [api.authHeader]: api.authHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey },
      body: JSON.stringify({ model: input.model ?? process.env.VOID_MEMORY_MAINTENANCE_MODEL ?? api.model, messages: [{ role: "user", content: input.prompt }], stream: false, max_completion_tokens: Math.min(api.maxCompletionTokens, Math.max(256, Number(process.env.VOID_MEMORY_MAINTENANCE_MAX_COMPLETION_TOKENS) || 2048)) }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Void memory model request failed with ${response.status}: ${redact(responseText, apiKey).slice(0, 1000)}`);
    const payload = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Void memory model response contained no assistant text.");
    return content.trim();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Void memory model request timed out after ${api.timeoutMs}ms.`);
    throw error;
  } finally { clearTimeout(timeout); }
}

function redact(value: string, secret: string): string { return secret ? value.split(secret).join("[redacted]") : value; }
