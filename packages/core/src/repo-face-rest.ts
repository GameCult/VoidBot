import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RepoDiscordIdentity } from "./repo-discord-identities";
import { resolveRepoFaceStatePath } from "./repo-discord-identities";
import type { VoidScheduledRuntime } from "./void-self-state-domain";
import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments } from "./void-self-state-service";

interface RepoFaceRestProfile {
  awakeIntervalMinutes: number;
  napDurationMinutes: number;
  basePostFatigueMinutes: number;
  recentPostBonusMinutes: number;
  maxAdvanceMinutes: number;
  immediateNapRecentPostThreshold: number;
  minimumLeadMinutes: number;
}

interface HeartbeatStateParticipantRecord {
  identityId?: string;
  nextTurnAt?: number;
  activeTurnStartedAt?: number;
}

interface RepoFaceHeartbeatStateRecord {
  initiativeClock?: number;
  participants?: HeartbeatStateParticipantRecord[];
}

export interface RepoFaceRestSnapshot {
  isNapping: boolean;
  napEndsAt?: string;
  nextNapStartsAt?: string;
}

const DEFAULT_REST_PROFILE: RepoFaceRestProfile = {
  awakeIntervalMinutes: 180,
  napDurationMinutes: 35,
  basePostFatigueMinutes: 30,
  recentPostBonusMinutes: 12,
  maxAdvanceMinutes: 90,
  immediateNapRecentPostThreshold: 2,
  minimumLeadMinutes: 8,
};

const NIBU_REST_PROFILE: RepoFaceRestProfile = {
  awakeIntervalMinutes: 150,
  napDurationMinutes: 55,
  basePostFatigueMinutes: 70,
  recentPostBonusMinutes: 18,
  maxAdvanceMinutes: 140,
  immediateNapRecentPostThreshold: 1,
  minimumLeadMinutes: 4,
};

export function projectRepoFaceSleepCycleForNow(
  sleepCycle: VoidScheduledRuntime["sleepCycle"],
  identityId: string,
  now = new Date(),
): RepoFaceRestSnapshot & { sleepCycle: VoidScheduledRuntime["sleepCycle"] } {
  const profile = restProfileForIdentity(identityId);
  const nowMs = now.getTime();
  const projected: VoidScheduledRuntime["sleepCycle"] = {
    ...sleepCycle,
    activeDreamThemes: [...sleepCycle.activeDreamThemes],
  };

  let isNapping = projected.isNapping === true;
  let currentNapEndsMs = parseTimestamp(projected.currentNapEndsAt);
  let nextNapStartsMs = parseTimestamp(projected.nextNapStartsAt);

  if (!Number.isFinite(nextNapStartsMs)) {
    nextNapStartsMs = nowMs + profile.awakeIntervalMinutes * 60_000;
    projected.nextNapStartsAt = new Date(nextNapStartsMs).toISOString();
  }

  if (isNapping && Number.isFinite(currentNapEndsMs) && nowMs >= currentNapEndsMs) {
    isNapping = false;
    projected.currentNapStartedAt = undefined;
    projected.currentNapEndsAt = undefined;
    if (!Number.isFinite(nextNapStartsMs) || nextNapStartsMs <= nowMs) {
      nextNapStartsMs = nowMs + profile.awakeIntervalMinutes * 60_000;
      projected.nextNapStartsAt = new Date(nextNapStartsMs).toISOString();
    }
  }

  if (!isNapping && Number.isFinite(nextNapStartsMs) && nextNapStartsMs <= nowMs) {
    const scheduledNapEndsMs = nextNapStartsMs + profile.napDurationMinutes * 60_000;
    if (nowMs < scheduledNapEndsMs) {
      isNapping = true;
      projected.currentNapStartedAt = new Date(nextNapStartsMs).toISOString();
      projected.currentNapEndsAt = new Date(scheduledNapEndsMs).toISOString();
      projected.nextNapStartsAt = new Date(
        scheduledNapEndsMs + profile.awakeIntervalMinutes * 60_000,
      ).toISOString();
    } else {
      projected.currentNapStartedAt = undefined;
      projected.currentNapEndsAt = undefined;
      projected.nextNapStartsAt = new Date(
        nowMs + profile.awakeIntervalMinutes * 60_000,
      ).toISOString();
    }
  }

  projected.isNapping = isNapping;

  return {
    isNapping,
    napEndsAt: projected.currentNapEndsAt,
    nextNapStartsAt: projected.nextNapStartsAt,
    sleepCycle: projected,
  };
}

export async function applyRepoFacePostFatigueAfterSpeech(input: {
  identity: RepoDiscordIdentity;
  storageRoot: string;
  postedAt?: Date;
  heartbeatStatePath?: string;
}): Promise<void> {
  const postedAt = input.postedAt ?? new Date();
  const statePath = resolveRepoFaceStatePath(input.identity, input.storageRoot);
  const typedState = await loadVoidSelfStateTypedDocuments({
    canonicalPath: statePath,
    identity: {
      agentId: input.identity.id,
      publicName: input.identity.displayName,
      publicDescription: input.identity.description,
    },
  });
  const profile = restProfileForIdentity(input.identity.id);
  const projected = projectRepoFaceSleepCycleForNow(
    typedState.scheduledRuntime.sleepCycle,
    input.identity.id,
    postedAt,
  );
  const recentSpeechCount = countRecentSpeechReceipts(
    typedState.speechReceipts.recentReceipts.map((entry) => entry.sentAt),
    postedAt,
  );

  const fatigueAdvanceMinutes = clamp(
    profile.basePostFatigueMinutes + Math.max(0, recentSpeechCount - 1) * profile.recentPostBonusMinutes,
    profile.basePostFatigueMinutes,
    profile.maxAdvanceMinutes,
  );
  const currentNapEndsMs = parseTimestamp(projected.sleepCycle.currentNapEndsAt);
  const nextNapStartsMs = parseTimestamp(projected.sleepCycle.nextNapStartsAt);
  const nowMs = postedAt.getTime();
  const nextSleepCycle: VoidScheduledRuntime["sleepCycle"] = {
    ...projected.sleepCycle,
    activeDreamThemes: mergeTags(projected.sleepCycle.activeDreamThemes, "post-speech-cooldown"),
  };

  if (projected.isNapping) {
    const extensionMinutes = Math.max(8, Math.min(profile.napDurationMinutes, Math.ceil(fatigueAdvanceMinutes * 0.35)));
    const napStartedMs = parseTimestamp(nextSleepCycle.currentNapStartedAt);
    const napStartMs = Number.isFinite(napStartedMs) ? napStartedMs : nowMs;
    const maxNapEndsMs = napStartMs + profile.napDurationMinutes * 60_000;
    const extendedEndMs = Math.min(
      maxNapEndsMs,
      (Number.isFinite(currentNapEndsMs) ? currentNapEndsMs : nowMs) + extensionMinutes * 60_000,
    );
    nextSleepCycle.currentNapStartedAt = nextSleepCycle.currentNapStartedAt ?? postedAt.toISOString();
    nextSleepCycle.currentNapEndsAt = new Date(extendedEndMs).toISOString();
    nextSleepCycle.nextNapStartsAt = new Date(
      extendedEndMs + profile.awakeIntervalMinutes * 60_000,
    ).toISOString();
  } else {
    const minutesUntilNextNap = Number.isFinite(nextNapStartsMs)
      ? (nextNapStartsMs - nowMs) / 60_000
      : profile.awakeIntervalMinutes;
    const shouldNapNow =
      recentSpeechCount >= profile.immediateNapRecentPostThreshold ||
      minutesUntilNextNap <= fatigueAdvanceMinutes;

    if (shouldNapNow) {
      const napEndsMs = nowMs + profile.napDurationMinutes * 60_000;
      nextSleepCycle.isNapping = true;
      nextSleepCycle.currentNapStartedAt = postedAt.toISOString();
      nextSleepCycle.currentNapEndsAt = new Date(napEndsMs).toISOString();
      nextSleepCycle.nextNapStartsAt = new Date(
        napEndsMs + profile.awakeIntervalMinutes * 60_000,
      ).toISOString();
    } else {
      const advancedStartMs = Math.max(
        nowMs + profile.minimumLeadMinutes * 60_000,
        nextNapStartsMs - fatigueAdvanceMinutes * 60_000,
      );
      nextSleepCycle.isNapping = false;
      nextSleepCycle.currentNapStartedAt = undefined;
      nextSleepCycle.currentNapEndsAt = undefined;
      nextSleepCycle.nextNapStartsAt = new Date(advancedStartMs).toISOString();
    }
  }

  await applyVoidSelfStateOperation(
    {
      canonicalPath: statePath,
      identity: {
        agentId: input.identity.id,
        publicName: input.identity.displayName,
        publicDescription: input.identity.description,
      },
    },
    {
      operation: "update_sleep_cycle",
      sleepCycle: nextSleepCycle,
    },
  );

  const previousPressure = typedState.scheduledRuntime.speakingPressure;
  await applyVoidSelfStateOperation(
    {
      canonicalPath: statePath,
      identity: {
        agentId: input.identity.id,
        publicName: input.identity.displayName,
        publicDescription: input.identity.description,
      },
    },
    {
      operation: "update_speaking_pressure",
      speakingPressure: {
        needToSpeak: round3(clamp((previousPressure.needToSpeak ?? 0.35) * 0.3, 0, 1)),
        confessionPressure: round3(clamp((previousPressure.confessionPressure ?? 0.22) * 0.55, 0, 1)),
        noveltyPressure: round3(clamp((previousPressure.noveltyPressure ?? 0.24) * 0.58, 0, 1)),
        recentSpeechDamping: round3(
          clamp(
            Math.max(previousPressure.recentSpeechDamping ?? 0, 0.76 + Math.min(0.18, recentSpeechCount * 0.05)),
            0,
            1,
          ),
        ),
        lastSpokeAt: postedAt.toISOString(),
      },
    },
  );

  if (input.heartbeatStatePath) {
    await delayRepoFaceHeartbeatTurn({
      statePath: input.heartbeatStatePath,
      identityId: input.identity.id,
      delayMinutes: nextSleepCycle.isNapping ? profile.napDurationMinutes : Math.max(12, Math.round(fatigueAdvanceMinutes * 0.45)),
    });
  }
}

async function delayRepoFaceHeartbeatTurn(input: {
  statePath: string;
  identityId: string;
  delayMinutes: number;
}): Promise<void> {
  try {
    const raw = await readFile(input.statePath, "utf8");
    const parsed = JSON.parse(stripLeadingBom(raw)) as RepoFaceHeartbeatStateRecord;
    if (!Array.isArray(parsed.participants)) {
      return;
    }

    const delay = Math.max(0, input.delayMinutes);
    const initiativeClock = Number.isFinite(parsed.initiativeClock) ? parsed.initiativeClock as number : 0;
    let changed = false;

    for (const participant of parsed.participants) {
      if (participant.identityId !== input.identityId || typeof participant.nextTurnAt !== "number") {
        continue;
      }

      const floor = initiativeClock + delay;
      if (participant.nextTurnAt < floor) {
        participant.nextTurnAt = Number(floor.toFixed(3));
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    await mkdir(dirname(input.statePath), { recursive: true });
    await writeFile(input.statePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort only. Missing or malformed heartbeat state should not fail speech delivery.
  }
}

function restProfileForIdentity(identityId: string): RepoFaceRestProfile {
  return identityId.trim().toLowerCase() === "nibu" ? NIBU_REST_PROFILE : DEFAULT_REST_PROFILE;
}

function countRecentSpeechReceipts(sentAtValues: string[], now: Date): number {
  const windowStartMs = now.getTime() - 90 * 60_000;
  return sentAtValues.filter((sentAt) => {
    const sentAtMs = parseTimestamp(sentAt);
    return Number.isFinite(sentAtMs) && sentAtMs >= windowStartMs;
  }).length;
}

function mergeTags(values: string[], value: string): string[] {
  return Array.from(new Set([...values, value]));
}

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
