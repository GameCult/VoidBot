import type { VoidSelfStateOperation, VoidSelfStateTypedProjection } from "@voidbot/core";

type SleepCycle = VoidSelfStateTypedProjection["scheduledRuntime"]["sleepCycle"];
type SpeakingPressure = VoidSelfStateTypedProjection["scheduledRuntime"]["speakingPressure"];

export interface VoidMemoryMaintenanceIntent {
  napStartedAt: string;
  shortTermMemoryCount: number;
  reason: "sleep_short_term_pressure";
}

export interface VoidPhysiologyProjection {
  sleepCycle: SleepCycle;
  speakingPressure: SpeakingPressure;
  operations: VoidSelfStateOperation[];
  memoryMaintenanceIntent?: VoidMemoryMaintenanceIntent;
  moderationActive: boolean;
}

export function projectVoidPhysiology(input: {
  state: VoidSelfStateTypedProjection;
  observedAt: Date;
  moderationActive: boolean;
}): VoidPhysiologyProjection {
  const sleepCycle = input.moderationActive
    ? input.state.scheduledRuntime.sleepCycle
    : projectVoidSleepCycle(input.state.scheduledRuntime.sleepCycle, input.observedAt);
  const speakingPressure = projectVoidSpeakingPressure({ state: input.state, sleepCycle, observedAt: input.observedAt });
  const operations: VoidSelfStateOperation[] = [
    ...(!input.moderationActive ? [{ operation: "update_sleep_cycle" as const, sleepCycle }] : []),
    { operation: "update_speaking_pressure" as const, speakingPressure },
  ];
  const activeShortTerm = input.state.thoughtMemory.shortTerm.filter((memory) => !memory.retiredAt).length;
  const memoryMaintenanceIntent = !input.moderationActive && sleepCycle.isNapping && sleepCycle.currentNapStartedAt && activeShortTerm > 0
    ? { napStartedAt: sleepCycle.currentNapStartedAt, shortTermMemoryCount: activeShortTerm, reason: "sleep_short_term_pressure" as const }
    : undefined;
  return { sleepCycle, speakingPressure, operations, memoryMaintenanceIntent, moderationActive: input.moderationActive };
}

export function projectVoidSleepCycle(previous: SleepCycle, now: Date): SleepCycle {
  const napIntervalMs = 4 * 60 * 60 * 1000;
  const napDurationMs = 60 * 60 * 1000;
  const nowMs = now.getTime();
  let isNapping = previous.isNapping;
  let currentNapStartedAt = previous.currentNapStartedAt;
  let currentNapEndsAt = previous.currentNapEndsAt;
  let nextNapStartsAt = previous.nextNapStartsAt;
  let nextNapMs = nextNapStartsAt ? Date.parse(nextNapStartsAt) : Number.NaN;
  const napEndMs = currentNapEndsAt ? Date.parse(currentNapEndsAt) : Number.NaN;
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
  return { isNapping, currentNapStartedAt, currentNapEndsAt, nextNapStartsAt, activeDreamThemes: previous.activeDreamThemes.filter((value) => value.trim()).slice(0, 4) };
}

export function projectVoidSpeakingPressure(input: {
  state: VoidSelfStateTypedProjection;
  sleepCycle: SleepCycle;
  observedAt: Date;
}): SpeakingPressure {
  const previous = input.state.scheduledRuntime.speakingPressure;
  const latestTypedSpeech = input.state.speechReceipts.recentReceipts
    .map((receipt) => receipt.sentAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const lastSpokeAt = latestTypedSpeech ?? previous.lastSpokeAt;
  const hoursSinceSpeech = lastSpokeAt ? hoursBetween(input.observedAt, new Date(lastSpokeAt)) : 24;
  const recentSpeechDamping = clamp(Math.exp(-hoursSinceSpeech / 3.5));
  const candidatePressure = input.state.candidateInterventions.interventions.filter((entry) => entry.status === "queued" || entry.status === "deferred").reduce((sum, entry) => sum + entry.priority * (entry.mustEventuallyShare ? 0.28 : 0.18), 0);
  const agencyPressure = input.state.agencyPressure.pressures.filter((entry) => entry.status === "active" || entry.status === "ready_to_act").reduce((sum, entry) => sum + entry.intensity * (entry.kind === "self_advocacy_request" || entry.kind === "world_advocacy_request" ? 0.3 : 0.14) * (entry.status === "ready_to_act" ? 1.25 : 1.08), 0);
  const thoughtPressure = input.state.thoughtMemory.incubation.filter((entry) => entry.status === "active" || entry.status === "ready_to_share").sort((left, right) => (right.desireToSpeak ?? 0) - (left.desireToSpeak ?? 0)).slice(0, 4).reduce((sum, entry) => sum + (entry.desireToSpeak ?? 0) * 0.12, 0);
  const needPressure = input.state.faceAffect.needs.filter((entry) => entry.status === "active" || entry.status === "neglected").reduce((sum, entry) => sum + entry.intensity * (["substrate", "agency", "status"].includes(entry.kind) ? 0.18 : 0.12) * (entry.status === "neglected" ? 1.28 : 1), 0);
  const statusPressure = input.state.faceAffect.statusReads.filter((entry) => !entry.retiredAt).reduce((sum, entry) => sum + entry.intensity * (["neglected", "bypassed", "blocked", "ignored", "threatened"].includes(entry.status) ? 0.14 : 0.08), 0);
  const moodPressure = input.state.faceAffect.moodDimensions.reduce((sum, entry) => sum + entry.value * (["anger", "annoyance", "irritation", "envy", "pride", "smugness", "playfulness", "anxiety", "commandForce"].includes(entry.name) ? 0.06 : 0.025), 0);
  const silencePressure = clamp(hoursSinceSpeech / 6);
  const sleepiness = input.sleepCycle.isNapping ? 1 : 0;
  const target = clamp(0.18 + silencePressure * 0.32 + candidatePressure + thoughtPressure + agencyPressure + needPressure + statusPressure + moodPressure - recentSpeechDamping * 0.38 - sleepiness * 0.26);
  return {
    needToSpeak: round3(clamp(previous.needToSpeak + (target - previous.needToSpeak) * 0.42)),
    confessionPressure: round3(clamp((previous.confessionPressure ?? 0.25) * 0.68 + silencePressure * 0.12 + sleepiness * 0.1 + moodPressure * 0.4)),
    noveltyPressure: round3(clamp((previous.noveltyPressure ?? 0.35) * 0.6 + thoughtPressure * 0.72 + candidatePressure * 0.3 + agencyPressure * 0.44 + needPressure * 0.38 + statusPressure * 0.3)),
    recentSpeechDamping: round3(recentSpeechDamping),
    lastSpokeAt,
  };
}

function hoursBetween(later: Date, earlier: Date): number {
  const difference = later.getTime() - earlier.getTime();
  return Number.isFinite(difference) ? Math.max(0, difference / 3_600_000) : 24;
}

function round3(value: number): number { return Math.round(value * 1000) / 1000; }
function clamp(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0; }
