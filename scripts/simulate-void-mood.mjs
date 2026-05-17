import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  applyVoidSelfStateOperation,
  loadVoidSelfStateTypedDocuments,
} = require(resolve(repoRoot, "packages/core/dist/index.js"));

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const statePath = resolveArgPath("--state-path", ".voidbot/private/void-self-state.cc");
const statusDir = resolveStatusDir();
const statusPath = resolve(statusDir, "void-mood-drift.json");
const lockPath = resolve(statusDir, "void-mood-drift.lock");
const lastSpeechPath = resolve(statusDir, "void-last-speech.json");
const moderationLockPath = resolve(statusDir, "moderation-rumination.lock");
const memoryMaintenanceStatusPath = resolveMemoryMaintenanceStatusPath();
const memoryMaintenanceScriptPath = resolve(repoRoot, "scripts/run-void-memory-maintenance.ps1");

async function main() {
  const now = new Date();

  await withLock(async () => {
    if (isRecentLockPresent(moderationLockPath, 20 * 60 * 1000)) {
      writeStatus({
        status: "skipped",
        reason: "moderation_loop_active",
        observedAt: now.toISOString(),
      });
      return;
    }

    const typedState = await loadVoidSelfStateTypedDocuments({ canonicalPath: statePath });
    const sleepCycle = updateSleepCycle(typedState.scheduledRuntime.sleepCycle, now);
    const speakingPressure = updateSpeakingPressure({
      typedState,
      previous: typedState.scheduledRuntime.speakingPressure,
      sleepCycle,
      now,
    });

    await applyVoidSelfStateOperation(
      { canonicalPath: statePath },
      {
        operation: "update_sleep_cycle",
        sleepCycle,
      },
    );
    await applyVoidSelfStateOperation(
      { canonicalPath: statePath },
      {
        operation: "update_speaking_pressure",
        speakingPressure,
      },
    );

    const memoryMaintenance = runSleepMemoryMaintenanceIfDue({ sleepCycle });
    if (memoryMaintenance.status === "failed") {
      writeStatus({
        status: "failed",
        reason: "sleep_memory_maintenance_failed",
        observedAt: now.toISOString(),
        statePath,
        speakingPressure,
        sleepCycle,
        memoryMaintenance,
      });
      throw new Error(`Sleep memory maintenance failed with exit code ${memoryMaintenance.exitCode}.`);
    }

    writeStatus({
      status: "ok",
      observedAt: now.toISOString(),
      statePath,
      speakingPressure,
      sleepCycle,
      memoryMaintenance,
    });
  });
}

function updateSleepCycle(previous, now) {
  const prior = previous && typeof previous === "object" ? previous : {};
  const napIntervalMs = 4 * 60 * 60 * 1000;
  const napDurationMs = 60 * 60 * 1000;
  const nowMs = now.getTime();
  let isNapping = prior.isNapping === true;
  let currentNapStartedAt = typeof prior.currentNapStartedAt === "string" ? prior.currentNapStartedAt : undefined;
  let currentNapEndsAt = typeof prior.currentNapEndsAt === "string" ? prior.currentNapEndsAt : undefined;
  let nextNapStartsAt = typeof prior.nextNapStartsAt === "string" ? prior.nextNapStartsAt : undefined;
  let nextNapMs = nextNapStartsAt ? Date.parse(nextNapStartsAt) : Number.NaN;
  let napEndMs = currentNapEndsAt ? Date.parse(currentNapEndsAt) : Number.NaN;

  if (!Number.isFinite(nextNapMs)) {
    nextNapMs = nowMs + napIntervalMs;
    nextNapStartsAt = new Date(nextNapMs).toISOString();
  }

  if (isNapping && Number.isFinite(napEndMs) && nowMs >= napEndMs) {
    isNapping = false;
    currentNapStartedAt = undefined;
    currentNapEndsAt = undefined;
    nextNapMs = nowMs + napIntervalMs;
    nextNapStartsAt = new Date(nextNapMs).toISOString();
  }

  if (!isNapping && nowMs >= nextNapMs) {
    isNapping = true;
    currentNapStartedAt = now.toISOString();
    currentNapEndsAt = new Date(nowMs + napDurationMs).toISOString();
    nextNapStartsAt = new Date(nowMs + napIntervalMs).toISOString();
  }

  return {
    isNapping,
    currentNapStartedAt,
    currentNapEndsAt,
    nextNapStartsAt,
    activeDreamThemes: Array.isArray(prior.activeDreamThemes)
      ? prior.activeDreamThemes.filter((value) => typeof value === "string" && value.trim().length > 0).slice(0, 4)
      : [],
  };
}

function updateSpeakingPressure({ typedState, previous, sleepCycle, now }) {
  const lastSpeech = readJsonSafe(lastSpeechPath);
  const lastSpokeAt =
    typeof lastSpeech?.sentAt === "string"
      ? lastSpeech.sentAt
      : typeof previous.lastSpokeAt === "string"
        ? previous.lastSpokeAt
        : undefined;
  const hoursSinceSpeech = lastSpokeAt ? hoursBetween(now, new Date(lastSpokeAt)) : 24;
  const recentSpeechDamping = clamp(Math.exp(-hoursSinceSpeech / 3.5), 0, 1);
  const queuedInterventionPressure = typedState.candidateInterventions.interventions
    .filter((entry) => entry.status === "queued" || entry.status === "deferred")
    .reduce((sum, entry) => sum + entry.priority * (entry.mustEventuallyShare ? 0.28 : 0.18), 0);
  const agencySpeechPressure = typedState.agencyPressure.pressures
    .filter((entry) => entry.status === "active" || entry.status === "ready_to_act")
    .reduce((sum, entry) => {
      const advocacyWeight =
        entry.kind === "self_advocacy_request" || entry.kind === "world_advocacy_request" ? 0.22 : 0.12;
      const readinessWeight = entry.status === "ready_to_act" ? 1.2 : 1;
      return sum + entry.intensity * advocacyWeight * readinessWeight;
    }, 0);
  const topThreadPressure = typedState.thoughtMemory.incubation
    .filter((thread) => thread.status === "active" || thread.status === "ready_to_share")
    .sort((left, right) => (right.desireToSpeak ?? 0) - (left.desireToSpeak ?? 0))
    .slice(0, 4)
    .reduce((sum, thread) => sum + (thread.desireToSpeak ?? 0) * 0.12, 0);
  const silencePressure = clamp(hoursSinceSpeech / 6, 0, 1);
  const sleepiness = sleepCycle.isNapping ? 1 : 0;
  const priorNeedToSpeak = clamp(previous.needToSpeak ?? 0.35, 0, 1);
  const targetNeedToSpeak = clamp(
    0.16 + silencePressure * 0.32 + queuedInterventionPressure + topThreadPressure + agencySpeechPressure - recentSpeechDamping * 0.42 - sleepiness * 0.26,
    0,
    1,
  );
  const needToSpeak = round3(priorNeedToSpeak + (targetNeedToSpeak - priorNeedToSpeak) * 0.42);
  const noveltyPressure = round3(
    clamp((previous.noveltyPressure ?? 0.35) * 0.62 + topThreadPressure * 0.72 + queuedInterventionPressure * 0.28 + agencySpeechPressure * 0.35, 0, 1),
  );
  const confessionPressure = round3(
    clamp((previous.confessionPressure ?? 0.25) * 0.68 + silencePressure * 0.12 + sleepiness * 0.1, 0, 1),
  );

  return {
    needToSpeak,
    confessionPressure,
    noveltyPressure,
    recentSpeechDamping: round3(recentSpeechDamping),
    lastSpokeAt,
  };
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runSleepMemoryMaintenanceIfDue({ sleepCycle }) {
  if (args.has("--skip-memory-maintenance")) {
    return {
      status: "skipped",
      reason: "disabled_by_argument",
    };
  }

  if (sleepCycle.isNapping !== true) {
    return {
      status: "skipped",
      reason: "not_napping",
    };
  }

  const napStartedMs = Date.parse(sleepCycle.currentNapStartedAt ?? "");
  if (!Number.isFinite(napStartedMs)) {
    return {
      status: "skipped",
      reason: "missing_nap_start",
    };
  }

  if (!args.has("--force-memory-maintenance") && completedMemoryMaintenanceAfter(napStartedMs)) {
    return {
      status: "skipped",
      reason: "already_completed_this_nap",
    };
  }

  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      memoryMaintenanceScriptPath,
      "-StateFilePath",
      statePath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );

  const output = [result.stdout, result.stderr].filter((value) => value && value.trim().length > 0).join("\n").trim();
  if (result.status !== 0) {
    return {
      status: "failed",
      exitCode: result.status,
      output,
    };
  }

  return {
    status: "ok",
    exitCode: result.status,
    output,
  };
}

function completedMemoryMaintenanceAfter(timestampMs) {
  const status = readJsonSafe(memoryMaintenanceStatusPath);
  if (status?.status !== "ok") {
    return false;
  }
  if (typeof status.stateFile !== "string" || resolve(status.stateFile) !== statePath) {
    return false;
  }

  const finishedMs = Date.parse(status.finishedAt ?? "");
  return Number.isFinite(finishedMs) && finishedMs >= timestampMs;
}

function writeStatus(payload) {
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function withLock(fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST" && isRecentLockPresent(lockPath, 10 * 60 * 1000)) {
      writeStatus({
        status: "skipped",
        reason: "lock_present",
        observedAt: new Date().toISOString(),
      });
      return;
    }
    rmSync(lockPath, { force: true });
    fd = openSync(lockPath, "wx");
  }

  try {
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    await fn();
  } finally {
    if (typeof fd === "number") {
      closeSync(fd);
    }
    rmSync(lockPath, { force: true });
  }
}

function isRecentLockPresent(path, thresholdMs) {
  try {
    const stats = statSync(path);
    return Date.now() - stats.mtimeMs < thresholdMs;
  } catch {
    return false;
  }
}

function hoursBetween(later, earlier) {
  const diff = later.getTime() - earlier.getTime();
  return Number.isFinite(diff) ? Math.max(0, diff / (60 * 60 * 1000)) : 24;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

await main();

function getArgValue(name) {
  const index = rawArgs.indexOf(name);
  if (index < 0) {
    return undefined;
  }

  const value = rawArgs[index + 1];
  return typeof value === "string" && !value.startsWith("--") ? value : undefined;
}

function resolveArgPath(name, fallbackRelativePath) {
  const value = getArgValue(name);
  return value ? resolve(value) : resolve(repoRoot, fallbackRelativePath);
}

function resolveStatusDir() {
  const value = process.env.VOID_STATUS_DIR;
  return resolve(value && value.trim().length > 0 ? value : resolve(repoRoot, ".voidbot/status"));
}

function resolveMemoryMaintenanceStatusPath() {
  const statusDir = process.env.VOID_MEMORY_MAINTENANCE_STATUS_DIR;
  return resolve(statusDir && statusDir.trim().length > 0 ? statusDir : resolveStatusDir(), "void-memory-maintenance.json");
}
