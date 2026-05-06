import { readFile } from "node:fs/promises";

import {
  type GuildContext,
  type SourceMessage,
  type VoidSelfStateContext,
} from "@voidbot/shared";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface LoadVoidSelfStateOptions {
  recentMessages?: SourceMessage[];
  guildContext?: GuildContext;
}

export async function loadVoidSelfState(
  statePath: string,
  options: LoadVoidSelfStateOptions = {},
): Promise<VoidSelfStateContext | undefined> {
  let raw: string;

  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as JsonObject;
  const projection = buildVoidSelfStateProjection(parsed);

  return {
    sourcePath: statePath,
    loadedAt: new Date().toISOString(),
    summary: renderVoidSelfStateSummary(parsed, options),
    projection,
  };
}

function renderVoidSelfStateSummary(
  state: JsonObject,
  options: LoadVoidSelfStateOptions,
): string {
  const identity = getObject(state, "identity");
  const goals = getArray(state, "goals");
  const memories = getObject(state, "memories");
  const runtime = getObject(state, "moderation_runtime");
  const canonicalState = getObject(state, "canonical_state");
  const thoughtLanes = getObject(runtime, "thought_lanes");
  const bridge = getObject(runtime, "bridge");
  const memoryResonance = getObject(runtime, "memory_resonance");
  const incubation = getObject(runtime, "incubation");

  const privateNotes = getStringArray(identity, "private_notes").slice(0, 4);
  const activeGoals = goals
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .filter((goal) => readString(goal, "status") === "active")
    .slice(0, 4)
    .map((goal) => readString(goal, "label"))
    .filter((value): value is string => Boolean(value));
  const topValues = getArray(canonicalState, "values")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .sort(
      (left, right) =>
        (readNumber(right, "priority") ?? 0) - (readNumber(left, "priority") ?? 0),
    )
    .slice(0, 4)
    .map((value) => readString(value, "label"))
    .filter((value): value is string => Boolean(value));
  const voiceSummary = summarizeCurrentActivations(getObject(canonicalState, "voice_style"), 5);
  const behavioralSummary = summarizeCurrentActivations(
    getObject(canonicalState, "behavioral_dimensions"),
    5,
  );
  const semanticMemories = getArray(memories, "semantic")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-6)
    .map((memory) => {
      const subject = readString(memory, "subjectLabel") ?? readString(memory, "subjectId") ?? "unknown";
      const summary = readString(memory, "summary") ?? "(no summary)";
      return `- ${subject}: ${summary}`;
    });
  const musings = getArray(memories, "musings")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-4)
    .map((musing) => {
      const topic = readString(musing, "topic") ?? "untitled";
      const summary = readString(musing, "summary") ?? "(no summary)";
      return `- ${topic}: ${summary}`;
    });
  const recentMusings = getArray(runtime, "recent_musings")
    .map((value) => (typeof value === "string" ? value : undefined))
    .filter((value): value is string => Boolean(value))
    .slice(-4)
    .map((value) => `- ${value}`);
  const analyticThreads = summarizeThoughtLane(getObject(thoughtLanes, "analytic"), 3);
  const associativeThreads = summarizeThoughtLane(getObject(thoughtLanes, "associative"), 3);
  const bridgeSyntheses = summarizeBridgeSyntheses(bridge, 3);
  const topicSaturation = summarizeTopicSaturation(bridge, 3);
  const unresolvedTensions = summarizeUnresolvedTensions(bridge, 3);
  const resonanceClusters = summarizeResonanceClusters(memoryResonance, 3);
  const incubatingThoughts = summarizeIncubatingThoughts(incubation, 3);
  const candidateInterventions = getArray(runtime, "candidate_interventions")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-3)
    .map((intervention) => {
      const summary = readString(intervention, "summary") ?? "draft intervention";
      const draft = readString(intervention, "draft") ?? "(no draft)";
      return `- ${summary}: ${draft}`;
    });
  const speakingBias = getObject(runtime, "speaking_bias");
  const recentRepoSweeps = getArray(runtime, "recent_repo_activity_sweeps")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-2)
    .reverse()
    .map((sweep) => {
      const summary = readString(sweep, "summary") ?? "(no summary)";
      const repoNames = getStringArray(sweep, "repoNames");
      return `- ${summary}${repoNames.length > 0 ? ` [${repoNames.join(", ")}]` : ""}`;
    });
  const recentNoveltyChecks = getArray(runtime, "recent_novelty_checks")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-3)
    .reverse()
    .map((check) => {
      const topic = readString(check, "topic") ?? "untitled";
      const result = readString(check, "result") ?? "unknown";
      const summary = readString(check, "summary") ?? "(no summary)";
      return `- ${topic} [${result}]: ${summary}`;
    });
  const lastRun = getObject(runtime, "last_run");
  const lastRunSummary = readString(lastRun, "summary");
  const sleepCycleSummary = renderSleepCycleSummary(runtime, memories);
  const transientRoomLog = renderTransientRoomLog(options);

  return [
    `- Identity: ${readString(identity, "name") ?? "Void"}${readString(identity, "public_description") ? ` - ${readString(identity, "public_description")}` : ""}`,
    privateNotes.length > 0
      ? `- Private notes: ${privateNotes.join(" | ")}`
      : "- Private notes: none recorded.",
    activeGoals.length > 0
      ? `- Active goals: ${activeGoals.join(" | ")}`
      : "- Active goals: none recorded.",
    topValues.length > 0
      ? `- Highest-priority values: ${topValues.join(" | ")}`
      : "- Highest-priority values: none recorded.",
    voiceSummary
      ? `- Current voice activations: ${voiceSummary}`
      : "- Current voice activations: none highlighted.",
    behavioralSummary
      ? `- Current behavioral activations: ${behavioralSummary}`
      : "- Current behavioral activations: none highlighted.",
    sleepCycleSummary,
    lastRunSummary ? `- Last moderation run: ${lastRunSummary}` : "- Last moderation run: none recorded.",
    semanticMemories.length > 0
      ? ["- Recent semantic memories:", ...semanticMemories].join("\n")
      : "- Recent semantic memories: none recorded.",
    analyticThreads.length > 0
      ? ["- Analytic active threads:", ...analyticThreads].join("\n")
      : "- Analytic active threads: none recorded.",
    associativeThreads.length > 0
      ? ["- Associative active threads:", ...associativeThreads].join("\n")
      : "- Associative active threads: none recorded.",
    bridgeSyntheses.length > 0
      ? ["- Bridge syntheses:", ...bridgeSyntheses].join("\n")
      : "- Bridge syntheses: none recorded.",
    resonanceClusters.length > 0
      ? ["- Resonance clusters:", ...resonanceClusters].join("\n")
      : "- Resonance clusters: none recorded.",
    incubatingThoughts.length > 0
      ? ["- Incubating thoughts:", ...incubatingThoughts].join("\n")
      : "- Incubating thoughts: none recorded.",
    topicSaturation.length > 0
      ? ["- Topic saturation warnings:", ...topicSaturation].join("\n")
      : "- Topic saturation warnings: none recorded.",
    unresolvedTensions.length > 0
      ? ["- Unresolved tensions:", ...unresolvedTensions].join("\n")
      : "- Unresolved tensions: none recorded.",
    renderSpeakingBiasSummary(speakingBias),
    recentRepoSweeps.length > 0
      ? ["- Recent repo activity sweeps:", ...recentRepoSweeps].join("\n")
      : "- Recent repo activity sweeps: none recorded.",
    recentNoveltyChecks.length > 0
      ? ["- Recent novelty checks:", ...recentNoveltyChecks].join("\n")
      : "- Recent novelty checks: none recorded.",
    musings.length > 0
      ? ["- Stored musings:", ...musings].join("\n")
      : "- Stored musings: none recorded.",
    recentMusings.length > 0
      ? ["- Recent moderation musings:", ...recentMusings].join("\n")
      : "- Recent moderation musings: none recorded.",
    candidateInterventions.length > 0
      ? ["- Draft conversation/intervention seeds:", ...candidateInterventions].join("\n")
      : "- Draft conversation/intervention seeds: none recorded.",
    transientRoomLog,
  ].join("\n");
}

function renderTransientRoomLog(options: LoadVoidSelfStateOptions): string {
  const recentMessages = (options.recentMessages ?? []).slice(-10);
  const guildName = options.guildContext?.guildName ?? options.guildContext?.guildId ?? "(direct/unknown)";
  const channelName =
    options.guildContext?.channelName ?? options.guildContext?.channelId ?? "(unknown channel)";

  if (recentMessages.length === 0) {
    return [
      "- Current room snapshot:",
      `- Current room: guild=${guildName}; channel=${channelName}`,
      "- No recent chat messages were captured in this snapshot.",
    ].join("\n");
  }

  const lines = recentMessages.map(
    (message) =>
      `- [${message.timestamp}] ${message.authorName}: ${collapseWhitespace(message.content || "(no text content)")}`,
  );

  return [
    "- Current room snapshot:",
    `- Current room: guild=${guildName}; channel=${channelName}`,
    ...lines,
  ].join("\n");
}

function summarizeThoughtLane(lane: JsonObject | undefined, limit: number): string[] {
  return getArray(lane, "active_threads")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(0, limit)
    .map((thread) => {
      const topic = readString(thread, "topic") ?? "untitled";
      const claim = readString(thread, "claim") ?? "(no claim)";
      const roomRelevance = readNumber(thread, "roomRelevance");
      const novelty = readNumber(thread, "novelty");
      const desireToSpeak = readNumber(thread, "desireToSpeak");
      const counterweight = readString(thread, "counterweight");
      const metrics = [
        roomRelevance !== undefined ? `room=${roomRelevance.toFixed(2)}` : undefined,
        novelty !== undefined ? `novelty=${novelty.toFixed(2)}` : undefined,
        desireToSpeak !== undefined ? `speak=${desireToSpeak.toFixed(2)}` : undefined,
      ].filter((value): value is string => Boolean(value));
      const counterweightText = counterweight ? ` Counterweight: ${counterweight}` : "";

      return `- ${topic}: ${claim}${metrics.length > 0 ? ` (${metrics.join(", ")})` : ""}${counterweightText}`;
    });
}

function summarizeBridgeSyntheses(bridge: JsonObject | undefined, limit: number): string[] {
  return getArray(bridge, "recent_syntheses")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-limit)
    .reverse()
    .map((synthesis) => {
      const summary = readString(synthesis, "summary") ?? "(no summary)";
      const laneBalance = readString(synthesis, "laneBalance");
      const speakDecision = readString(synthesis, "speakDecision");
      const tags = [laneBalance, speakDecision].filter((value): value is string => Boolean(value));
      return `- ${summary}${tags.length > 0 ? ` [${tags.join("; ")}]` : ""}`;
    });
}

function summarizeResonanceClusters(memoryResonance: JsonObject | undefined, limit: number): string[] {
  return getArray(memoryResonance, "clusters")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .sort(
      (left, right) =>
        (readNumber(right, "resonance") ?? 0) - (readNumber(left, "resonance") ?? 0),
    )
    .slice(0, limit)
    .map((cluster) => {
      const label = readString(cluster, "label") ?? "untitled";
      const summary = readString(cluster, "summary") ?? "(no summary)";
      const resonance = readNumber(cluster, "resonance");
      return `- ${label}${resonance !== undefined ? ` (resonance=${resonance.toFixed(2)})` : ""}: ${summary}`;
    });
}

function summarizeIncubatingThoughts(incubation: JsonObject | undefined, limit: number): string[] {
  return getArray(incubation, "active_thoughts")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .sort(
      (left, right) =>
        (readNumber(right, "maturation") ?? 0) - (readNumber(left, "maturation") ?? 0),
    )
    .slice(0, limit)
    .map((thought) => {
      const topic = readString(thought, "topic") ?? "untitled";
      const summary = readString(thought, "summary") ?? "(no summary)";
      const status = readString(thought, "status");
      const maturation = readNumber(thought, "maturation");
      const desireToSpeak = readNumber(thought, "desireToSpeak");
      const metrics = [
        status,
        maturation !== undefined ? `maturation=${maturation.toFixed(2)}` : undefined,
        desireToSpeak !== undefined ? `speak=${desireToSpeak.toFixed(2)}` : undefined,
      ].filter((value): value is string => Boolean(value));
      return `- ${topic}${metrics.length > 0 ? ` [${metrics.join("; ")}]` : ""}: ${summary}`;
    });
}

function summarizeTopicSaturation(bridge: JsonObject | undefined, limit: number): string[] {
  return getArray(bridge, "topic_saturation")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .sort(
      (left, right) =>
        (readNumber(right, "dominance") ?? 0) - (readNumber(left, "dominance") ?? 0),
    )
    .slice(0, limit)
    .map((entry) => {
      const topic = readString(entry, "topic") ?? "untitled";
      const dominance = readNumber(entry, "dominance");
      const recentMentions = readNumber(entry, "recentMentions");
      const coolingAdvice = readString(entry, "coolingAdvice");
      const metrics = [
        dominance !== undefined ? `dominance=${dominance.toFixed(2)}` : undefined,
        recentMentions !== undefined ? `recent=${recentMentions}` : undefined,
      ].filter((value): value is string => Boolean(value));
      return `- ${topic}${metrics.length > 0 ? ` (${metrics.join(", ")})` : ""}${coolingAdvice ? ` - ${coolingAdvice}` : ""}`;
    });
}

function summarizeUnresolvedTensions(bridge: JsonObject | undefined, limit: number): string[] {
  return getArray(bridge, "unresolved_tensions")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(0, limit)
    .map((tension) => {
      const topic = readString(tension, "topic") ?? "untitled";
      const summary = readString(tension, "summary") ?? "(no summary)";
      return `- ${topic}: ${summary}`;
    });
}

function summarizeCurrentActivations(
  category: JsonObject | undefined,
  limit: number,
): string | undefined {
  if (!category) {
    return undefined;
  }

  const entries = Object.entries(category)
    .map(([key, value]) => {
      if (!isObject(value)) {
        return undefined;
      }

      const activation = readNumber(value, "current_activation");

      if (activation === undefined) {
        return undefined;
      }

      return {
        key,
        activation,
      };
    })
    .filter((value): value is { key: string; activation: number } => Boolean(value))
    .sort((left, right) => right.activation - left.activation)
    .slice(0, limit);

  if (entries.length === 0) {
    return undefined;
  }

  return entries
    .map(({ key, activation }) => `${key}=${activation.toFixed(2)}`)
    .join(", ");
}

function renderSpeakingBiasSummary(speakingBias: JsonObject | undefined): string {
  if (!speakingBias) {
    return "- Speaking bias: none recorded.";
  }

  const needToSpeak = readNumber(speakingBias, "needToSpeak");
  const confessionPressure = readNumber(speakingBias, "confessionPressure");
  const noveltyPressure = readNumber(speakingBias, "noveltyPressure");
  const recentSpeechDamping = readNumber(speakingBias, "recentSpeechDamping");
  const lastHeraldAt = readString(speakingBias, "lastHeraldAt");
  const lastSpokeAt = readString(speakingBias, "lastSpokeAt");
  const parts = [
    needToSpeak !== undefined ? `needToSpeak=${needToSpeak.toFixed(2)}` : undefined,
    confessionPressure !== undefined ? `confession=${confessionPressure.toFixed(2)}` : undefined,
    noveltyPressure !== undefined ? `novelty=${noveltyPressure.toFixed(2)}` : undefined,
    recentSpeechDamping !== undefined ? `speechDamping=${recentSpeechDamping.toFixed(2)}` : undefined,
  ].filter((value): value is string => Boolean(value));

  const recency = [lastHeraldAt ? `lastHerald=${lastHeraldAt}` : undefined, lastSpokeAt ? `lastSpoke=${lastSpokeAt}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(" | ");

  if (parts.length === 0 && recency.length === 0) {
    return "- Speaking bias: none recorded.";
  }

  return `- Speaking bias: ${parts.join(", ")}${recency.length > 0 ? ` (${recency})` : ""}`;
}

function buildVoidSelfStateProjection(state: JsonObject): VoidSelfStateContext["projection"] {
  const memories = getObject(state, "memories");
  const runtime = getObject(state, "moderation_runtime");
  const sleepCycle = getObject(runtime, "sleep_cycle");
  const dreamEntries = getArray(memories, "dreams")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-3)
    .reverse();
  const dreamSummaries = dreamEntries
    .map((entry) => readString(entry, "summary"))
    .filter((entry): entry is string => Boolean(entry));
  const activeDreamThemes = getStringArray(sleepCycle, "activeDreamThemes");
  const isNapping = sleepCycle?.["isNapping"] === true;
  const napStartedAt = readString(sleepCycle, "currentNapStartedAt") ?? readString(sleepCycle, "lastNapStartedAt");
  const napEndsAt = readString(sleepCycle, "currentNapEndsAt");
  const nextNapAt = readString(sleepCycle, "nextNapStartsAt");

  return {
    mode: isNapping ? "napping" : "awake",
    effortCeiling: isNapping ? "minimal" : "normal",
    napStartedAt: isNapping ? napStartedAt : undefined,
    napEndsAt: isNapping ? napEndsAt : undefined,
    nextNapAt,
    activeDreamThemes,
    recentDreamSummaries: dreamSummaries,
    replyDirective: isNapping
      ? "You are in a scheduled nap. Reply in brief, low-effort, half-dreaming mutters instead of doing full attentive service-work."
      : undefined,
  };
}

function renderSleepCycleSummary(
  runtime: JsonObject | undefined,
  memories: JsonObject | undefined,
): string {
  const sleepCycle = getObject(runtime, "sleep_cycle");

  if (!sleepCycle) {
    return "- Sleep cycle: none recorded.";
  }

  const activeDreamThemes = getStringArray(sleepCycle, "activeDreamThemes").slice(0, 4);
  const dreams = getArray(memories, "dreams")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-2)
    .reverse()
    .map((dream) => {
      const theme = readString(dream, "theme") ?? "untitled";
      const summary = readString(dream, "summary") ?? "(no summary)";
      return `${theme}: ${summary}`;
    });
  const isNapping = sleepCycle?.["isNapping"] === true;
  const currentNapEndsAt = readString(sleepCycle, "currentNapEndsAt");
  const nextNapStartsAt = readString(sleepCycle, "nextNapStartsAt");
  const dreamCount = readNumber(sleepCycle, "dreamCountInCurrentNap");
  const replyMode = readString(sleepCycle, "replyMode");
  const headline = isNapping
    ? `- Sleep cycle: napping${currentNapEndsAt ? ` until ${currentNapEndsAt}` : ""}${replyMode ? ` (${replyMode})` : ""}${dreamCount !== undefined ? `; dreams this nap=${dreamCount}` : ""}.`
    : `- Sleep cycle: awake${nextNapStartsAt ? `; next nap ${nextNapStartsAt}` : ""}.`;
  const themeLine =
    activeDreamThemes.length > 0
      ? `- Active dream themes: ${activeDreamThemes.join(" | ")}`
      : "- Active dream themes: none recorded.";
  const dreamLine =
    dreams.length > 0
      ? `- Recent dream residue: ${dreams.join(" | ")}`
      : "- Recent dream residue: none recorded.";

  return [headline, themeLine, dreamLine].join("\n");
}

function getObject(value: JsonObject | undefined, key: string): JsonObject | undefined {
  const candidate = value?.[key];
  return isObject(candidate) ? candidate : undefined;
}

function getArray(value: JsonObject | undefined, key: string): JsonValue[] {
  const candidate = value?.[key];
  return Array.isArray(candidate) ? candidate : [];
}

function getStringArray(value: JsonObject | undefined, key: string): string[] {
  return getArray(value, key)
    .map((entry) => (typeof entry === "string" ? entry : undefined))
    .filter((entry): entry is string => Boolean(entry));
}

function readString(value: JsonObject | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readNumber(value: JsonObject | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
