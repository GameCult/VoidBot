import "dotenv/config";

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { loadConfig } from "@voidbot/config";

const config = loadConfig();
const intervalMs = Math.max(1, config.repoFaceHeartbeats.intervalMinutes) * 60_000;
const turnEnginePath = resolve(process.cwd(), "scripts", "run-repo-face-heartbeats.ts");

let stopping = false;
let activeTick: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;

function runTick(): Promise<void> {
  if (activeTick) {
    console.warn("Persona scheduler skipped a pulse because the previous turn-selection tick is still active.");
    return activeTick;
  }

  activeTick = new Promise<void>((done) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [turnEnginePath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      console.error(`Persona scheduler tick failed to start: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      const output = stdout.trim();
      if (code === 0) {
        console.log(`Persona scheduler tick completed (started ${startedAt}).${output ? ` ${output}` : ""}`);
      } else {
        console.error(
          `Persona scheduler tick failed (started ${startedAt}, code ${String(code)}, signal ${String(signal)}).${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
        );
      }
      done();
    });
  }).finally(() => {
    activeTick = undefined;
  });
  return activeTick;
}

function scheduleNext(): void {
  if (stopping) return;
  timer = setTimeout(async () => {
    await runTick();
    scheduleNext();
  }, intervalMs);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  console.log(`Persona scheduler stopping after ${signal}.`);
  await activeTick;
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

console.log(`Persona scheduler owns the resident ${config.repoFaceHeartbeats.intervalMinutes}-minute turn pulse.`);
void runTick().then(scheduleNext);
