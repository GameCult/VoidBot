import "dotenv/config";

import { loadConfig } from "@voidbot/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runPersonaSchedulerTick } from "./persona-scheduler-runner.js";
import { runVoidPhysiologyOrgan } from "./void-physiology-organ.js";
import { runVoidMemoryMaintenance } from "./void-memory-maintenance-organ.js";
import { projectVoidMemoryOperations } from "./void-memory-text-actuator.js";
import { runVoidModerationHeartbeat } from "./void-moderation-heartbeat-organ.js";
import { projectVoidModerationOperations } from "./void-moderation-text-actuator.js";
import { runVoidModerationEnforcement } from "./void-moderation-enforcement-organ.js";
import { runVoidCandidateDelivery } from "./void-candidate-delivery-organ.js";
import { deliverVoidCandidateViaBifrost } from "./bifrost-discord-delivery-actuator.js";
import { runVoidRumination } from "./void-rumination-organ.js";
import { projectVoidRuminationOperations } from "./void-rumination-text-actuator.js";
import { readVoidModerationEvidence } from "./void-moderation-evidence-source.js";

const config = loadConfig();
const intervalMs = Math.max(1, config.repoFaceHeartbeats.intervalMinutes) * 60_000;
let stopping = false;
let activeTick: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;
let lastPhysiologyAt = 0;
let lastModerationAt = 0;
let lastRuminationAt = 0;
const physiologyIntervalMs = Math.max(5, Number(process.env.VOIDBOT_MOOD_INTERVAL_MINUTES) || 5) * 60_000;
const moderationIntervalMs = config.voidModerationDaemon.intervalMinutes * 60_000;
const ruminationIntervalMs = config.voidRuminationDaemon.intervalMinutes * 60_000;

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
          if (physiology.memoryMaintenanceIntent) {
            try {
              const memory = await runVoidMemoryMaintenance({ statePath: physiology.statePath, intent: physiology.memoryMaintenanceIntent }, {
                projectText: (prompt) => projectVoidMemoryOperations({ prompt, config }),
              });
              console.log(`Void memory-maintenance pulse completed. ${JSON.stringify(memory)}`);
            } catch (error) {
              console.error(`Void memory-maintenance pulse failed without automatic nap retry. ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            }
          }
        } catch (error) {
          console.error(`Void physiology pulse failed. ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
      }
      if (config.voidModerationDaemon.enabled && Date.now() - lastModerationAt >= moderationIntervalMs) {
        lastModerationAt = Date.now();
        try {
          const moderation = await runVoidModerationHeartbeat({
            statePath: resolve(config.storageRoot, "private", "void-self-state.cc"),
            rules: await readFile(resolve("config", "discord-server-rules.md"), "utf8"),
            enforcementMode: config.voidModerationDaemon.enforcementMode,
          }, { projectText: (prompt) => projectVoidModerationOperations({ prompt, config }) });
          console.log(`Void moderation-heartbeat pulse completed. ${JSON.stringify(moderation)}`);
        } catch (error) {
          console.error(`Void moderation-heartbeat pulse failed without automatic evidence-window retry. ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
        try {
          const enforcement = await runVoidModerationEnforcement({
            statePath: resolve(config.storageRoot, "private", "void-self-state.cc"),
            mode: config.voidModerationDaemon.enforcementMode,
            botToken: config.botToken,
            guildId: config.developmentGuildId,
          });
          console.log(`Void moderation-enforcement pulse completed. ${JSON.stringify(enforcement)}`);
        } catch (error) {
          console.error(`Void moderation-enforcement pulse failed; pending cases remain typed debt for the next cadence. ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
      }
      if (config.voidRuminationDaemon.enabled && Date.now() - lastRuminationAt >= ruminationIntervalMs) {
        lastRuminationAt = Date.now();
        try {
          const evidence = await readVoidModerationEvidence({ fallbackHours: 6, limit: 80 });
          const latestMessage = evidence.messages.at(-1);
          const rumination = await runVoidRumination({
            statePath: resolve(config.storageRoot, "private", "void-self-state.cc"),
            recentHistory: { messages: evidence.messages },
            recentConversationTarget: latestMessage ? { channelId: latestMessage.channelId, replyToMessageId: latestMessage.id } : undefined,
            publicSpeechTarget: config.repoFaceHeartbeats.defaultChannelId ? { channelId: config.repoFaceHeartbeats.defaultChannelId } : undefined,
            doctrine: await readFile(resolve("config", "void-rumination-doctrine.md"), "utf8"),
            rules: await readFile(resolve("config", "discord-server-rules.md"), "utf8"),
            voice: await readFile(resolve(config.stylePackPath), "utf8"),
          }, { projectText: (prompt) => projectVoidRuminationOperations({ prompt, config }) });
          console.log(`Void rumination pulse completed. ${JSON.stringify(rumination)}`);
        } catch (error) {
          console.error(`Void rumination pulse failed without cadence retry. ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        }
      }
      if (config.voidCandidateDelivery.enabled) {
        try {
          const delivery = await runVoidCandidateDelivery({
            statePath: resolve(config.storageRoot, "private", "void-self-state.cc"),
            personaName: config.voidCandidateDelivery.personaName,
            personaAvatarUrl: config.voidCandidateDelivery.personaAvatarUrl,
          }, {
            deliver: (candidate) => deliverVoidCandidateViaBifrost(candidate, {
              ...config.bifrostCultMesh,
              bifrostRoot: config.bifrostRoot,
              cultlibRoot: process.env.VOIDBOT_CULTLIB_ROOT,
            }),
          });
          if (delivery.status === "ok") console.log(`Void candidate delivery completed. ${JSON.stringify(delivery)}`);
        } catch (error) {
          console.error(`Void candidate delivery failed; the queued candidate remains typed debt. ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
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
