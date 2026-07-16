import type { loadConfig } from "@voidbot/config";
import { requestBoundedTextCompletion } from "./bounded-text-completion-actuator.js";

export async function projectVoidRuminationOperations(input: { prompt: string; config: ReturnType<typeof loadConfig>; model?: string }, dependencies: { fetch?: typeof fetch; readText?: (path: string) => Promise<string> } = {}): Promise<string> {
  return requestBoundedTextCompletion({
    prompt: input.prompt, config: input.config, purpose: "Void person-shaped rumination",
    model: input.model ?? process.env.VOID_RUMINATION_MODEL,
    maxCompletionTokens: Number(process.env.VOID_RUMINATION_MAX_COMPLETION_TOKENS) || 3072,
  }, dependencies);
}
