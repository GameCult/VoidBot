import "dotenv/config";

import { loadConfig } from "@voidbot/config";
import { resolve } from "node:path";
import { runPersonaSchedulerTick } from "./persona-scheduler-runner.js";
import { runVoidPhysiologyOrgan } from "./void-physiology-organ.js";

const config = loadConfig();
const intervalMs = Math.max(1, config.repoFaceHeartbeats.intervalMinutes) * 60_000;
let stopping = false;
let activeTick: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;
let lastPhysiologyAt = 0;
const physiologyIntervalMs = Math.max(5, Number(process.env.VOIDBOT_MOOD_INTERVAL_MINUTES) || 5) * 60_000;

function runTick(): Promise<void> {
  if (activeTick) {
    console.warn("Persona scheduler skipped a pulse because the previous turn-selection tick is still active.");
    return activeTick;
  }
  const startedAt = new Date().toISOString();
  activeTick = runPersonaSchedulerTick({ config })
    .then(async (result) => {
      console.log(`Persona scheduler tick completed (started ${startedAt}). ${JSON.stringify(result)}`);
      if (Date.now() - lastPhysiologyAt >= physiologyIntervalMs) {
        try {
          const physiology = await runVoidPhysiologyOrgan({ statePath: resolve(config.storageRoot, "private", "void-self-state.cc"), statusDirectory: resolve(config.storageRoot, "status") });
          lastPhysiologyAt = Date.now();
          console.log(`Void physiology pulse completed. ${JSON.stringify(physiology)}`);
        } catch (error) {
          console.error(`Void physiology pulse failed. ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
      }
    })
    .catch((error) => { console.error(`Persona scheduler tick failed (started ${startedAt}). ${error instanceof Error ? error.stack ?? error.message : String(error)}`); })
    .finally(() => { activeTick = undefined; });
  return activeTick;
}

function scheduleNext(): void {
  if (stopping) return;
  timer = setTimeout(async () => { await runTick(); scheduleNext(); }, intervalMs);
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
console.log(`Persona scheduler owns the resident ${config.repoFaceHeartbeats.intervalMinutes}-minute observation pulse.`);
void runTick().then(scheduleNext);
