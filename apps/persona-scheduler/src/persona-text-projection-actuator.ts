import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { loadConfig } from "@voidbot/config";

type VoidBotConfig = ReturnType<typeof loadConfig>;

export function projectPersonaText(input: { prompt: string; config: VoidBotConfig; command: string; jobId: string; timeoutMs: number }): Promise<string> {
  const models = [...input.config.repoFaceHeartbeats.codexModels, input.config.repoFaceHeartbeats.codexModel, input.config.codexModel]
    .filter((model, index, all): model is string => Boolean(model) && all.indexOf(model) === index);
  return projectWithModels({ ...input, models, attemptedErrors: [] });
}

function projectWithModels(input: { prompt: string; config: VoidBotConfig; command: string; jobId: string; timeoutMs: number; models: string[]; attemptedErrors: string[] }): Promise<string> {
  return new Promise((resolveProjection, rejectProjection) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const model = input.models[0] ?? input.config.codexModel;
    const reasoningEffort = input.config.repoFaceHeartbeats.codexModelReasoningEffort ?? "low";
    const args = [...input.config.codexExecArgs, "exec", "-m", model, "-c", 'approval_policy="never"', "-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`, "--json", "--skip-git-repo-check", "-s", "read-only", "-"];
    const child = spawn(input.config.codexExecutable, args, { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectProjection);
    child.stdin.end(input.prompt);
    const timer = setTimeout(() => { child.kill(); }, input.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const finishedAt = new Date().toISOString();
      void appendProjectionLog({ config: input.config, jobId: input.jobId, command: input.command, model, prompt: input.prompt, startedAt, finishedAt, durationMs: Date.now() - startedMs, exitCode: code, signal, stdout, stderr }).catch(() => undefined);
      if (code !== 0) {
        const attemptedErrors = [...input.attemptedErrors, `${model}: ${code ?? signal ?? "unknown"} ${`${stdout}\n${stderr}`.trim().slice(-2400)}`];
        if (input.models.length > 1 && isRetryablePersonaProjectionFailure({ stdout, stderr })) {
          projectWithModels({ ...input, models: input.models.slice(1), attemptedErrors }).then(resolveProjection, rejectProjection);
          return;
        }
        rejectProjection(new Error(`Repo Face ${input.command} failed: ${attemptedErrors.join("\n---\n")}`));
        return;
      }
      const text = extractLastPersonaProjectionMessage(stdout).trim();
      if (!text) {
        rejectProjection(new Error("Repo Face state projector returned no visible agent message."));
        return;
      }
      resolveProjection(text);
    });
  });
}

export function isRetryablePersonaProjectionFailure(input: { stdout: string; stderr: string }): boolean {
  const text = `${input.stdout}\n${input.stderr}`.toLowerCase();
  return /quota|rate limit|rate-limit|usage limit|capacity|too many requests|(?:http|status|code|error)\s*429|429\s*(?:too many requests|rate)|insufficient_quota|model.*unavailable|model.*access|limit exceeded|tool .*not supported|unsupported.*tool/.test(text);
}

async function appendProjectionLog(input: { config: VoidBotConfig; jobId: string; command: string; model: string; prompt: string; startedAt: string; finishedAt: string; durationMs: number; exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }): Promise<void> {
  const logPath = resolve(input.config.storageRoot, "logs", "model-outputs.jsonl");
  const record = {
    schemaVersion: 1, loggedAt: new Date().toISOString(), jobId: input.jobId, command: input.command, turn: 1, model: input.model,
    promptMarker: input.prompt.match(/<!--\s*prompt:([^>\s]+)\s*-->/)?.[1] ?? null, promptLength: input.prompt.length,
    startedAt: input.startedAt, finishedAt: input.finishedAt, durationMs: input.durationMs, exitCode: input.exitCode, signal: input.signal,
    timedOut: input.signal === "SIGTERM", handoffReason: null, usage: null,
    finalMessage: extractLastPersonaProjectionMessage(input.stdout).trim() || null,
    stdoutTail: input.stdout.slice(-4000), stderrTail: input.stderr.slice(-4000), toolCalls: [], commandExecutions: [], artifactRefs: {},
  };
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

export function extractLastPersonaProjectionMessage(stdout: string): string {
  const messages = stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } }; } catch { return undefined; }
  }).filter((event): event is { type?: string; item?: { type?: string; text?: string } } => Boolean(event))
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item?.text?.trim() ?? "").filter(Boolean);
  return messages.at(-1) ?? stdout.trim();
}
