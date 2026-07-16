import type { loadConfig } from "@voidbot/config";
import { requestBoundedTextCompletion } from "./bounded-text-completion-actuator.js";

export async function projectVoidModerationOperations(input: {
  prompt: string;
  config: ReturnType<typeof loadConfig>;
  model?: string;
}, dependencies: { fetch?: typeof fetch; readText?: (path: string) => Promise<string> } = {}): Promise<string> {
  return requestBoundedTextCompletion({
    prompt: input.prompt,
    config: input.config,
    purpose: "Void moderation heartbeat",
    model: input.model ?? process.env.VOID_MODERATION_HEARTBEAT_MODEL,
    maxCompletionTokens: Number(process.env.VOID_MODERATION_HEARTBEAT_MAX_COMPLETION_TOKENS) || 2048,
  }, dependencies);
}
