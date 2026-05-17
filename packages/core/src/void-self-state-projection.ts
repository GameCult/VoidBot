import {
  type GuildContext,
  type SourceMessage,
  type VoidSelfStateContext,
} from "@voidbot/shared";

import {
  type VoidCandidateInterventions,
  type VoidAgencyPressure,
  type VoidModerationCursor,
  type VoidScheduledRuntime,
  type VoidSelfProfile,
  type VoidSpeechReceipts,
  type VoidThoughtMemory,
  voidCandidateInterventionsSchema,
  voidAgencyPressureSchema,
  voidModerationCursorSchema,
  voidScheduledRuntimeSchema,
  voidSelfProfileSchema,
  voidSpeechReceiptsSchema,
  voidThoughtMemorySchema,
} from "./void-self-state-domain";

export interface VoidSelfStateTypedProjection {
  selfProfile: VoidSelfProfile;
  moderationCursor: VoidModerationCursor;
  speechReceipts: VoidSpeechReceipts;
  thoughtMemory: VoidThoughtMemory;
  scheduledRuntime: VoidScheduledRuntime;
  agencyPressure: VoidAgencyPressure;
  candidateInterventions: VoidCandidateInterventions;
}

export interface VoidSelfStateProjectionOptions {
  sourcePath: string;
  loadedAt?: string;
  recentMessages?: SourceMessage[];
  guildContext?: GuildContext;
}

export function createEmptyVoidSelfState(
  options: { createdAt?: string } = {},
): VoidSelfStateTypedProjection {
  const createdAt = options.createdAt ?? new Date().toISOString();

  return {
    selfProfile: voidSelfProfileSchema.parse({
      schemaVersion: 1,
      agentId: "void-moderator",
      publicName: "Void",
      privateNotes: [],
      values: [],
      activationProfile: {
        underlyingOrganization: {},
        stableDispositions: {},
        behavioralDimensions: {},
        presentationStrategy: {},
        voiceStyle: {},
        situationalState: {},
      },
      updatedAt: createdAt,
    }),
    moderationCursor: voidModerationCursorSchema.parse({
      schemaVersion: 1,
      openCases: [],
      repoActivityCursor: [],
      updatedAt: createdAt,
    }),
    speechReceipts: voidSpeechReceiptsSchema.parse({
      schemaVersion: 1,
      recentReceipts: [],
      updatedAt: createdAt,
    }),
    thoughtMemory: voidThoughtMemorySchema.parse({
      schemaVersion: 1,
      shortTerm: [],
      memories: [],
      incubation: [],
      updatedAt: createdAt,
    }),
    scheduledRuntime: voidScheduledRuntimeSchema.parse({
      schemaVersion: 1,
      sleepCycle: {
        isNapping: false,
        activeDreamThemes: [],
      },
      speakingPressure: {
        needToSpeak: 0,
      },
      lastRuns: [],
      updatedAt: createdAt,
    }),
    agencyPressure: voidAgencyPressureSchema.parse({
      schemaVersion: 1,
      pressures: [],
      updatedAt: createdAt,
    }),
    candidateInterventions: voidCandidateInterventionsSchema.parse({
      schemaVersion: 1,
      interventions: [],
      updatedAt: createdAt,
    }),
  };
}

export function buildVoidSelfStateContext(
  typedState: VoidSelfStateTypedProjection,
  options: VoidSelfStateProjectionOptions,
): VoidSelfStateContext {
  return {
    sourcePath: options.sourcePath,
    loadedAt: options.loadedAt ?? new Date().toISOString(),
    summary: renderVoidSelfStateSummary(typedState, options),
    projection: buildVoidSelfStateProjection(typedState),
  };
}

export function renderVoidSelfStateSummary(
  state: VoidSelfStateTypedProjection,
  options: Pick<VoidSelfStateProjectionOptions, "guildContext" | "recentMessages"> = {},
): string {
  const profile = state.selfProfile;
  const topValues = state.selfProfile.values
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 4)
    .map((value) => value.label);
  const memories = state.thoughtMemory.memories
    .filter((memory) => !memory.retiredAt)
    .slice(-6)
    .reverse()
    .map((memory) => renderTypedMemory(memory));
  const shortTermMemories = state.thoughtMemory.shortTerm
    .slice(-6)
    .reverse()
    .map((memory) => renderTypedMemory(memory));
  const incubation = state.thoughtMemory.incubation
    .filter((thread) => thread.status !== "retired")
    .sort((left, right) => right.maturation - left.maturation)
    .slice(0, 4)
    .map((thread) => renderTypedIncubationThread(thread));
  const openCases = state.moderationCursor.openCases
    .filter((entry) => !["answered", "resolved", "closed", "retired", "dropped"].includes(entry.status))
    .slice(-4)
    .reverse()
    .map((entry) => `- ${entry.summary}${entry.authorName ? ` [from ${entry.authorName}]` : ""}`);
  const interventions = state.candidateInterventions.interventions
    .filter((entry) => entry.status === "queued" || entry.status === "deferred")
    .slice(-3)
    .reverse()
    .map((entry) => `- ${entry.summary}: ${entry.draft}`);
  const agencyPressures = state.agencyPressure.pressures
    .filter((entry) => ["active", "cooling", "ready_to_act"].includes(entry.status))
    .sort((left, right) => right.intensity - left.intensity)
    .slice(0, 4)
    .map((entry) => renderAgencyPressure(entry));

  return [
    `- Identity: ${profile.publicName}${profile.publicDescription ? ` - ${profile.publicDescription}` : ""}`,
    profile.privateNotes.length > 0
      ? `- Private notes: ${profile.privateNotes.slice(0, 4).join(" | ")}`
      : "- Private notes: none recorded.",
    topValues.length > 0
      ? `- Highest-priority values: ${topValues.join(" | ")}`
      : "- Highest-priority values: none recorded.",
    renderTypedSleepCycleSummary(state.scheduledRuntime, state.thoughtMemory),
    renderTypedSpeakingPressureSummary(state.scheduledRuntime),
    openCases.length > 0
      ? ["- What Void owes the room:", ...openCases].join("\n")
      : "- What Void owes the room: nothing unresolved.",
    memories.length > 0
      ? ["- What Void remembers:", ...memories].join("\n")
      : "- What Void remembers: nothing durable yet.",
    shortTermMemories.length > 0
      ? ["- Short-term residue awaiting sleep:", ...shortTermMemories].join("\n")
      : "- Short-term residue awaiting sleep: none.",
    incubation.length > 0
      ? ["- Thoughts still moving:", ...incubation].join("\n")
      : "- Thoughts still moving: none.",
    agencyPressures.length > 0
      ? ["- Agency pressure:", ...agencyPressures].join("\n")
      : "- Agency pressure: none active.",
    interventions.length > 0
      ? ["- Things Void may say soon:", ...interventions].join("\n")
      : "- Things Void may say soon: none queued.",
    renderTransientRoomLog(options),
  ].join("\n");
}

function renderAgencyPressure(pressure: VoidAgencyPressure["pressures"][number]): string {
  const target = pressure.target.label ?? pressure.target.id;
  const lines = [`- ${target}: ${pressure.summary}`];
  if (pressure.claim) {
    lines.push(`  What Void is asserting: ${pressure.claim}`);
  }
  if (pressure.question) {
    lines.push(`  What Void needs answered: ${pressure.question}`);
  }
  if (pressure.tension) {
    lines.push(`  What makes it difficult: ${pressure.tension}`);
  }
  lines.push(`  What this pressure wants changed: ${pressure.actionImplication}`);
  return lines.join("\n");
}

export function buildVoidSelfStateProjection(
  typedState: VoidSelfStateTypedProjection,
): VoidSelfStateContext["projection"] {
  const sleepCycle = typedState.scheduledRuntime.sleepCycle;
  const dreamSummaries = typedState.thoughtMemory.memories
    .filter((memory) => memory.kind === "dream_residue" && !memory.retiredAt)
    .slice(-3)
    .reverse()
    .map((memory) => memory.summary);
  const isNapping = sleepCycle.isNapping === true;
  const now = new Date();
  const napStartedAt = formatRelativeTime(sleepCycle.currentNapStartedAt, now);
  const napEndsAt = formatRelativeTime(sleepCycle.currentNapEndsAt, now);
  const nextNapAt = formatRelativeTime(sleepCycle.nextNapStartsAt, now);

  return {
    mode: isNapping ? "napping" : "awake",
    effortCeiling: isNapping ? "minimal" : "normal",
    napStartedAt: isNapping ? napStartedAt : undefined,
    napEndsAt: isNapping ? napEndsAt : undefined,
    nextNapAt,
    activeDreamThemes: sleepCycle.activeDreamThemes,
    recentDreamSummaries: dreamSummaries,
    replyDirective: isNapping
      ? "You are in a scheduled nap. Reply in brief, low-effort, half-dreaming mutters instead of doing full attentive service-work."
      : undefined,
  };
}

function renderTypedMemory(memory: VoidThoughtMemory["memories"][number]): string {
  const target = memory.target.label ?? memory.target.id;
  const lines = [`- ${target}: ${memory.summary}`];
  if (memory.claim) {
    lines.push(`  Void's read: ${memory.claim}`);
  }
  if (memory.question) {
    lines.push(`  The question it keeps open: ${memory.question}`);
  }
  if (memory.tension) {
    lines.push(`  What keeps it honest: ${memory.tension}`);
  }
  if (memory.actionImplication) {
    lines.push(`  How it should change the next move: ${memory.actionImplication}`);
  }
  return lines.join("\n");
}

function renderTypedIncubationThread(thread: VoidThoughtMemory["incubation"][number]): string {
  const target = thread.target.label ?? thread.target.id;
  const lines = [`- ${thread.topic}: ${thread.summary}`];
  lines.push(`  It is pointed at ${target} and is currently ${describeIncubationStatus(thread.status)}.`);
  if (thread.desireToSpeak !== undefined && thread.desireToSpeak >= 0.65) {
    lines.push("  It has pressure to be said out loud.");
  }
  if (thread.saturationScore !== undefined && thread.saturationScore >= 0.75) {
    lines.push("  It may be over-chewed; find new evidence or let it cool.");
  }
  return lines.join("\n");
}

function describeIncubationStatus(status: VoidThoughtMemory["incubation"][number]["status"]): string {
  switch (status) {
    case "ready_to_share":
      return "nearly ready to share";
    case "cooling":
      return "cooling";
    case "crystallized":
      return "settling into doctrine";
    case "retired":
      return "retired";
    case "active":
    default:
      return "active";
  }
}

function renderTypedSleepCycleSummary(
  runtime: VoidScheduledRuntime,
  thoughtMemory: VoidThoughtMemory,
): string {
  const sleepCycle = runtime.sleepCycle;
  const now = new Date();
  const dreams = thoughtMemory.memories
    .filter((memory) => memory.kind === "dream_residue" && !memory.retiredAt)
    .slice(-2)
    .reverse()
    .map((memory) => `${memory.target.label ?? memory.target.id}: ${memory.summary}`);
  const headline = sleepCycle.isNapping
    ? `- Sleep: napping${sleepCycle.currentNapEndsAt ? `; ends ${formatRelativeTime(sleepCycle.currentNapEndsAt, now)}` : ""}.`
    : `- Sleep cycle: awake${sleepCycle.nextNapStartsAt ? `; next nap ${formatRelativeTime(sleepCycle.nextNapStartsAt, now)}` : ""}.`;
  const themeLine =
    sleepCycle.activeDreamThemes.length > 0
      ? `- Dream themes in reach: ${sleepCycle.activeDreamThemes.join(" | ")}`
      : "- Dream themes in reach: none.";
  const dreamLine =
    dreams.length > 0
      ? `- Recent dream residue: ${dreams.join(" | ")}`
      : "- Recent dream residue: none.";

  return [headline, themeLine, dreamLine].join("\n");
}

function renderTypedSpeakingPressureSummary(runtime: VoidScheduledRuntime): string {
  const pressure = runtime.speakingPressure;
  const parts = [`overall ${describePressure(pressure.needToSpeak)}`];
  if (pressure.confessionPressure !== undefined && pressure.confessionPressure >= 0.6) {
    parts.push("self-disclosure is tugging");
  }
  if (pressure.noveltyPressure !== undefined && pressure.noveltyPressure >= 0.6) {
    parts.push("something feels new enough to mention");
  }
  if (pressure.recentSpeechDamping !== undefined && pressure.recentSpeechDamping >= 0.5) {
    parts.push("recent speech should dampen the impulse");
  }

  return `- Pressure to speak: ${parts.join(", ")}`;
}

function describePressure(value: number): "low" | "medium" | "high" {
  if (value >= 0.7) {
    return "high";
  }
  if (value >= 0.35) {
    return "medium";
  }
  return "low";
}

function renderTransientRoomLog(
  options: Pick<VoidSelfStateProjectionOptions, "guildContext" | "recentMessages">,
): string {
  const recentMessages = (options.recentMessages ?? []).slice(-10);
  const guildName = options.guildContext?.guildName ?? options.guildContext?.guildId ?? "(direct/unknown)";
  const channelName =
    options.guildContext?.channelName ?? options.guildContext?.channelId ?? "(unknown channel)";

  if (recentMessages.length === 0) {
    return [
      "- Current room snapshot:",
      `- Current room: guild=${guildName}; channel=${channelName}`,
      "- Recent room: quiet in this snapshot.",
    ].join("\n");
  }

  const lines = recentMessages.map(
    (message) =>
      `- ${formatRelativeTime(message.timestamp)} ${message.authorName}: ${collapseWhitespace(message.content || "(no text content)")}`,
  );

  return [
    "- Current room snapshot:",
    `- Current room: guild=${guildName}; channel=${channelName}`,
    ...lines,
  ].join("\n");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatRelativeTime(value: string | undefined, now = new Date()): string {
  if (!value) {
    return "recently";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "recently";
  }

  const deltaMs = timestamp - now.getTime();
  const future = deltaMs > 0;
  const absoluteSeconds = Math.abs(deltaMs) / 1000;
  const phrase = describeRelativeDuration(absoluteSeconds);

  if (phrase === "just now") {
    return phrase;
  }

  return future ? `in ${phrase}` : `${phrase} ago`;
}

function describeRelativeDuration(absoluteSeconds: number): string {
  if (absoluteSeconds < 45) {
    return "just now";
  }

  const minutes = Math.round(absoluteSeconds / 60);
  if (minutes < 90) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 36) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const days = Math.round(hours / 24);
  if (days < 21) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }

  const weeks = Math.round(days / 7);
  if (weeks < 10) {
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }

  const months = Math.round(days / 30);
  if (months < 18) {
    return `${months} month${months === 1 ? "" : "s"}`;
  }

  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? "" : "s"}`;
}
