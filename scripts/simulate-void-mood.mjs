import { mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reconcileSemanticMemoryState } from "./void-memory-organ.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(repoRoot, ".voidbot/private/moderation-agent-state.json");
const statusPath = resolve(repoRoot, ".voidbot/status/void-mood-drift.json");
const lockPath = resolve(repoRoot, ".voidbot/status/void-mood-drift.lock");
const lastSpeechPath = resolve(repoRoot, ".voidbot/status/void-last-speech.json");
const moderationLockPath = resolve(repoRoot, ".voidbot/status/moderation-rumination.lock");

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

    const state = readJson(statePath);
    const canonicalState = ensureObject(state.canonical_state);
    const runtime = ensureObject(state.moderation_runtime);
    const sleepCycle = updateSleepCycle(runtime, now);
    const memoryOrgan = await reconcileSemanticMemoryState({
      state,
      now,
      repoRootPath: repoRoot,
    });
    const touchedVectors = [];

    for (const [categoryName, categoryValue] of Object.entries(canonicalState)) {
      if (!isObject(categoryValue)) {
        continue;
      }

      const categoryConfig = getCategoryConfig(categoryName);

      for (const [vectorName, vectorValue] of Object.entries(categoryValue)) {
        if (!isObject(vectorValue) || typeof vectorValue.mean !== "number" || typeof vectorValue.plasticity !== "number") {
          continue;
        }

        const currentActivation =
          typeof vectorValue.current_activation === "number" ? vectorValue.current_activation : vectorValue.mean;
        const target = computeTargetActivation({
          categoryName,
          vectorName,
          mean: vectorValue.mean,
          plasticity: vectorValue.plasticity,
          now,
          periodHours: categoryConfig.periodHours,
          amplitudeMultiplier: categoryConfig.amplitudeMultiplier,
        });
        const driftRate = clamp(0.08 + vectorValue.plasticity * 0.22 + categoryConfig.driftBonus, 0.06, 0.4);
        const nextActivation = clamp(currentActivation + (target - currentActivation) * driftRate, 0, 1);

        vectorValue.current_activation = round3(nextActivation);
        touchedVectors.push({
          key: `${categoryName}.${vectorName}`,
          previous: currentActivation,
          next: nextActivation,
          delta: nextActivation - currentActivation,
          target,
        });
      }
    }

    if (sleepCycle.isNapping) {
      applySleepBias(canonicalState, touchedVectors);
    }

    const speakingBias = ensureObject(runtime.speaking_bias);
    const candidateInterventions = Array.isArray(runtime.candidate_interventions)
      ? runtime.candidate_interventions.filter(isObject)
      : [];
    const noveltyChecks = Array.isArray(runtime.recent_novelty_checks)
      ? runtime.recent_novelty_checks.filter(isObject)
      : [];
    const repoSweeps = Array.isArray(runtime.recent_repo_activity_sweeps)
      ? runtime.recent_repo_activity_sweeps.filter(isObject)
      : [];

    const lastSpeech = readJsonSafe(lastSpeechPath);
    const lastSpokeAt =
      typeof lastSpeech?.sentAt === "string"
        ? lastSpeech.sentAt
        : typeof speakingBias.lastSpokeAt === "string"
          ? speakingBias.lastSpokeAt
          : null;
    const hoursSinceSpeech = lastSpokeAt ? hoursBetween(now, new Date(lastSpokeAt)) : 24;
    const lastSpeechWeight =
      lastSpeech && typeof lastSpeech.contentLength === "number"
        ? clamp(0.25 + Math.min(lastSpeech.contentLength, 900) / 900, 0.25, 1)
        : 0.5;
    const recentSpeechDamping = clamp(Math.exp(-hoursSinceSpeech / 3.5) * lastSpeechWeight, 0, 1);
    const draftPressure = candidateInterventions.reduce((score, entry) => {
      const status = typeof entry.status === "string" ? entry.status : "";
      const priority = typeof entry.priority === "string" ? entry.priority : "";
      if (status !== "draft") {
        return score;
      }

      return score + (priority === "medium" ? 0.18 : priority === "high" ? 0.24 : 0.1);
    }, 0);
    const recentNoveltyPressure = noveltyChecks
      .slice(-6)
      .filter((entry) => typeof entry.result === "string" && entry.result.toLowerCase() === "novel").length * 0.08;
    const freshRepoSweepPressure = repoSweeps
      .slice(-3)
      .reduce((score, sweep) => {
        const repoNames = Array.isArray(sweep.repoNames) ? sweep.repoNames.length : 0;
        const sweepAgeHours =
          typeof sweep.timestamp === "string" ? hoursBetween(now, new Date(sweep.timestamp)) : 999;
        if (repoNames < Number(speakingBias.minimumActiveReposForHeraldNote ?? 2) || sweepAgeHours > 18) {
          return score;
        }

        return score + 0.12;
      }, 0);
    const topSpeakUrge = topThreadDesire(runtime, 4);
    const silencePressure = clamp(hoursSinceSpeech / 6, 0, 1);
    const sleepiness = sleepCycle.isNapping ? 1 : 0;

    speakingBias.heraldRepoActivity = speakingBias.heraldRepoActivity !== false;
    speakingBias.minimumActiveReposForHeraldNote = Number(speakingBias.minimumActiveReposForHeraldNote ?? 2);
    speakingBias.maxQuietRunsBeforePostingFreshRepoObservation = Number(
      speakingBias.maxQuietRunsBeforePostingFreshRepoObservation ?? 2,
    );
    speakingBias.lastSpokeAt = lastSpokeAt;
    speakingBias.recentSpeechDamping = round3(recentSpeechDamping);

    const targetNeedToSpeak = clamp(
      0.2 + silencePressure * 0.32 + draftPressure * 0.45 + freshRepoSweepPressure + topSpeakUrge * 0.28 - recentSpeechDamping * 0.5 - sleepiness * 0.26,
      0,
      1,
    );
    const priorNeedToSpeak =
      typeof speakingBias.needToSpeak === "number" ? speakingBias.needToSpeak : 0.42;
    speakingBias.needToSpeak = round3(priorNeedToSpeak + (targetNeedToSpeak - priorNeedToSpeak) * 0.42);

    const targetConfessionPressure = clamp(
      0.16 + silencePressure * 0.22 + topExpressiveDelta(canonicalState) * 0.35 - recentSpeechDamping * 0.25 + sleepiness * 0.18,
      0,
      1,
    );
    const priorConfessionPressure =
      typeof speakingBias.confessionPressure === "number" ? speakingBias.confessionPressure : 0.33;
    speakingBias.confessionPressure = round3(
      priorConfessionPressure + (targetConfessionPressure - priorConfessionPressure) * 0.38,
    );

    const targetNoveltyPressure = clamp(
      0.2 + recentNoveltyPressure + freshRepoSweepPressure * 0.7 + topSpeakUrge * 0.18 + sleepiness * 0.06,
      0,
      1,
    );
    const priorNoveltyPressure =
      typeof speakingBias.noveltyPressure === "number" ? speakingBias.noveltyPressure : 0.46;
    speakingBias.noveltyPressure = round3(
      priorNoveltyPressure + (targetNoveltyPressure - priorNoveltyPressure) * 0.4,
    );

    state.moderation_runtime = runtime;
    writeJson(statePath, state);

    const strongestShifts = touchedVectors
      .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
      .slice(0, 8)
      .map((entry) => ({
        key: entry.key,
        previous: round3(entry.previous),
        next: round3(entry.next),
        delta: round3(entry.delta),
      }));

    writeStatus({
      status: "ok",
      observedAt: now.toISOString(),
      statePath,
      strongestShifts,
      speakingBias: {
        lastSpokeAt: speakingBias.lastSpokeAt ?? null,
        needToSpeak: speakingBias.needToSpeak,
        confessionPressure: speakingBias.confessionPressure,
        noveltyPressure: speakingBias.noveltyPressure,
        recentSpeechDamping: speakingBias.recentSpeechDamping,
      },
      memoryOrgan,
      sleepCycle: {
        isNapping: sleepCycle.isNapping,
        currentNapStartedAt: sleepCycle.currentNapStartedAt ?? null,
        currentNapEndsAt: sleepCycle.currentNapEndsAt ?? null,
        nextNapStartsAt: sleepCycle.nextNapStartsAt ?? null,
        activeDreamThemes: Array.isArray(sleepCycle.activeDreamThemes)
          ? sleepCycle.activeDreamThemes
          : [],
      },
    });
  });
}

function topThreadDesire(runtime, limit) {
  const thoughtLanes = isObject(runtime.thought_lanes) ? runtime.thought_lanes : {};
  const desires = [];

  for (const lane of ["analytic", "associative"]) {
    const activeThreads = Array.isArray(thoughtLanes?.[lane]?.active_threads)
      ? thoughtLanes[lane].active_threads
      : [];
    for (const thread of activeThreads) {
      if (isObject(thread) && typeof thread.desireToSpeak === "number") {
        desires.push(thread.desireToSpeak);
      }
    }
  }

  if (desires.length === 0) {
    return 0.2;
  }

  return desires
    .sort((left, right) => right - left)
    .slice(0, limit)
    .reduce((sum, value) => sum + value, 0) / Math.min(desires.length, limit);
}

function topExpressiveDelta(canonicalState) {
  let strongest = 0;

  for (const categoryName of ["voice_style", "behavioral_dimensions", "presentation_strategy", "situational_state"]) {
    const category = canonicalState?.[categoryName];
    if (!isObject(category)) {
      continue;
    }

    for (const value of Object.values(category)) {
      if (!isObject(value) || typeof value.mean !== "number" || typeof value.current_activation !== "number") {
        continue;
      }
      strongest = Math.max(strongest, Math.abs(value.current_activation - value.mean));
    }
  }

  return strongest;
}

function applySleepBias(canonicalState, touchedVectors) {
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "situational_state",
    vectorName: "exhaustion",
    target: 0.74,
    factor: 0.28,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "behavioral_dimensions",
    vectorName: "withdrawal",
    target: 0.46,
    factor: 0.18,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "behavioral_dimensions",
    vectorName: "distance_seeking",
    target: 0.43,
    factor: 0.16,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "behavioral_dimensions",
    vectorName: "drive",
    target: 0.41,
    factor: 0.14,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "presentation_strategy",
    vectorName: "detachment",
    target: 0.38,
    factor: 0.16,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "voice_style",
    vectorName: "figurative_language",
    target: 0.68,
    factor: 0.18,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "voice_style",
    vectorName: "self_disclosure",
    target: 0.44,
    factor: 0.16,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "voice_style",
    vectorName: "technical_density",
    target: 0.24,
    factor: 0.18,
  });
  nudgeVector({
    canonicalState,
    touchedVectors,
    categoryName: "voice_style",
    vectorName: "question_asking",
    target: 0.27,
    factor: 0.2,
  });
}

function nudgeVector({
  canonicalState,
  touchedVectors,
  categoryName,
  vectorName,
  target,
  factor,
}) {
  const category = canonicalState?.[categoryName];
  const vector = isObject(category) ? category[vectorName] : undefined;

  if (!isObject(vector) || typeof vector.current_activation !== "number") {
    return;
  }

  const previous = vector.current_activation;
  const next = clamp(previous + (target - previous) * factor, 0, 1);
  vector.current_activation = round3(next);
  touchedVectors.push({
    key: `${categoryName}.${vectorName}`,
    previous,
    next,
    delta: next - previous,
    target,
  });
}

function updateSleepCycle(runtime, now) {
  const sleepCycle = ensureObject(runtime.sleep_cycle);
  const enabled = sleepCycle.enabled !== false;
  const cycleHours = clampNumber(sleepCycle.cycleHours, 4, 2, 12);
  const napDurationMinutes = clampNumber(sleepCycle.napDurationMinutes, 60, 15, cycleHours * 60 - 5);
  const phaseOffsetMinutesLocal = clampNumber(sleepCycle.phaseOffsetMinutesLocal, 120, 0, cycleHours * 60 - 1);
  const replyMode =
    typeof sleepCycle.replyMode === "string" && sleepCycle.replyMode.trim().length > 0
      ? sleepCycle.replyMode
      : "sleep_grumble";
  const activeDreamThemes = Array.isArray(sleepCycle.activeDreamThemes)
    ? sleepCycle.activeDreamThemes.filter((value) => typeof value === "string")
    : [];

  sleepCycle.enabled = enabled;
  sleepCycle.cycleHours = cycleHours;
  sleepCycle.napDurationMinutes = napDurationMinutes;
  sleepCycle.phaseOffsetMinutesLocal = phaseOffsetMinutesLocal;
  sleepCycle.replyMode = replyMode;
  sleepCycle.activeDreamThemes = activeDreamThemes;

  if (!enabled) {
    sleepCycle.isNapping = false;
    sleepCycle.currentNapStartedAt = null;
    sleepCycle.currentNapEndsAt = null;
    sleepCycle.nextNapStartsAt = null;
    runtime.sleep_cycle = sleepCycle;
    return sleepCycle;
  }

  const schedule = computeSleepSchedule(now, cycleHours, napDurationMinutes, phaseOffsetMinutesLocal);
  const wasNapping = sleepCycle.isNapping === true;
  sleepCycle.isNapping = schedule.isNapping;
  sleepCycle.currentNapStartedAt = schedule.currentNapStartedAt;
  sleepCycle.currentNapEndsAt = schedule.currentNapEndsAt;
  sleepCycle.nextNapStartsAt = schedule.nextNapStartsAt;

  if (schedule.isNapping && !wasNapping) {
    sleepCycle.lastNapStartedAt = schedule.currentNapStartedAt;
    sleepCycle.dreamCountInCurrentNap = 0;
    sleepCycle.lastDistillationSummary = null;
  }

  if (!schedule.isNapping && wasNapping) {
    sleepCycle.lastNapCompletedAt = schedule.previousNapEndedAt ?? sleepCycle.currentNapEndsAt ?? now.toISOString();
    sleepCycle.activeDreamThemes = [];
  }

  runtime.sleep_cycle = sleepCycle;
  return sleepCycle;
}

function computeSleepSchedule(now, cycleHours, napDurationMinutes, phaseOffsetMinutesLocal) {
  const cycleLengthMinutes = cycleHours * 60;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const minutesSinceDayStart =
    now.getHours() * 60 +
    now.getMinutes() +
    now.getSeconds() / 60 +
    now.getMilliseconds() / 60000;
  const adjustedMinutes = minutesSinceDayStart - phaseOffsetMinutesLocal;
  const cycleIndex = Math.floor(adjustedMinutes / cycleLengthMinutes);
  const currentCycleStartMinutes = phaseOffsetMinutesLocal + cycleIndex * cycleLengthMinutes;
  const napStartMinutes = currentCycleStartMinutes;
  const napEndMinutes = napStartMinutes + napDurationMinutes;
  const isNapping = minutesSinceDayStart >= napStartMinutes && minutesSinceDayStart < napEndMinutes;
  const currentNapStartedAt = isNapping
    ? minutesOffsetIso(dayStart, napStartMinutes)
    : null;
  const currentNapEndsAt = isNapping ? minutesOffsetIso(dayStart, napEndMinutes) : null;
  const nextNapStartsAt = isNapping
    ? minutesOffsetIso(dayStart, napStartMinutes + cycleLengthMinutes)
    : minutesSinceDayStart < napStartMinutes
      ? minutesOffsetIso(dayStart, napStartMinutes)
      : minutesOffsetIso(dayStart, napStartMinutes + cycleLengthMinutes);
  const previousNapEndedAt =
    napEndMinutes <= minutesSinceDayStart
      ? minutesOffsetIso(dayStart, napEndMinutes)
      : minutesOffsetIso(dayStart, napEndMinutes - cycleLengthMinutes);

  return {
    isNapping,
    currentNapStartedAt,
    currentNapEndsAt,
    nextNapStartsAt,
    previousNapEndedAt,
  };
}

function minutesOffsetIso(dayStart, offsetMinutes) {
  const shifted = new Date(dayStart.getTime() + offsetMinutes * 60 * 1000);
  return shifted.toISOString();
}

function clampNumber(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, min, max)
    : fallback;
}

function computeTargetActivation({
  categoryName,
  vectorName,
  mean,
  plasticity,
  now,
  periodHours,
  amplitudeMultiplier,
}) {
  const time = now.getTime() / (periodHours * 60 * 60 * 1000);
  const seed = hashString(`${categoryName}:${vectorName}`);
  const noise = fbmNoise(seed, time);
  const amplitude = (0.06 + plasticity * 0.24) * amplitudeMultiplier;
  return clamp(mean + noise * amplitude, 0, 1);
}

function getCategoryConfig(categoryName) {
  switch (categoryName) {
    case "underlying_organization":
      return { periodHours: 14, amplitudeMultiplier: 0.55, driftBonus: 0.02 };
    case "stable_dispositions":
      return { periodHours: 9, amplitudeMultiplier: 0.65, driftBonus: 0.03 };
    case "behavioral_dimensions":
      return { periodHours: 5.5, amplitudeMultiplier: 1.0, driftBonus: 0.05 };
    case "presentation_strategy":
      return { periodHours: 4.5, amplitudeMultiplier: 0.95, driftBonus: 0.05 };
    case "voice_style":
      return { periodHours: 4.0, amplitudeMultiplier: 0.9, driftBonus: 0.06 };
    case "situational_state":
      return { periodHours: 2.5, amplitudeMultiplier: 1.1, driftBonus: 0.08 };
    default:
      return { periodHours: 6, amplitudeMultiplier: 0.75, driftBonus: 0.03 };
  }
}

function fbmNoise(seed, time) {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let amplitudeSum = 0;

  for (let octave = 0; octave < 4; octave += 1) {
    total += valueNoise1d(seed + octave * 1013, time * frequency) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return amplitudeSum === 0 ? 0 : total / amplitudeSum;
}

function valueNoise1d(seed, x) {
  const x0 = Math.floor(x);
  const x1 = x0 + 1;
  const t = smoothstep(x - x0);
  const v0 = hashToUnit(seed, x0);
  const v1 = hashToUnit(seed, x1);
  return lerp(v0, v1, t);
}

function hashToUnit(seed, x) {
  let value = seed ^ Math.imul(x, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = value ^ (value >>> 16);
  return ((value >>> 0) / 0xffffffff) * 2 - 1;
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function hoursBetween(later, earlier) {
  return Math.max(0, (later.getTime() - earlier.getTime()) / (1000 * 60 * 60));
}

function ensureObject(value) {
  return isObject(value) ? value : {};
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(stripBom(readFileSync(path, "utf8")));
}

function readJsonSafe(path) {
  try {
    return readJson(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeStatus(payload) {
  writeJson(statusPath, payload);
}

function stripBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

async function withLock(fn) {
  mkdirSync(dirname(lockPath), { recursive: true });

  try {
    const staleThresholdMs = 15 * 60 * 1000;
    if (isRecentLockPresent(lockPath, staleThresholdMs)) {
      writeStatus({
        status: "skipped",
        reason: "mood_lock_present",
        observedAt: new Date().toISOString(),
      });
      return;
    }

    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    closeSync(fd);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      writeStatus({
        status: "skipped",
        reason: "mood_lock_present",
        observedAt: new Date().toISOString(),
      });
      return;
    }
    throw error;
  }

  try {
    await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function isRecentLockPresent(path, thresholdMs) {
  try {
    const stats = statSync(path);
    return Date.now() - stats.mtimeMs < thresholdMs;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

try {
  await main();
} catch (error) {
  writeStatus({
    status: "failed",
    observedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
