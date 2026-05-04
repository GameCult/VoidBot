import { readFile } from "node:fs/promises";

import { type VoidSelfStateContext } from "@voidbot/shared";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export async function loadVoidSelfState(
  statePath: string,
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

  return {
    sourcePath: statePath,
    loadedAt: new Date().toISOString(),
    summary: renderVoidSelfStateSummary(parsed),
  };
}

type JsonObject = { [key: string]: JsonValue };

function renderVoidSelfStateSummary(state: JsonObject): string {
  const identity = getObject(state, "identity");
  const goals = getArray(state, "goals");
  const memories = getObject(state, "memories");
  const runtime = getObject(state, "moderation_runtime");
  const canonicalState = getObject(state, "canonical_state");

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
  const candidateInterventions = getArray(runtime, "candidate_interventions")
    .map((value) => (isObject(value) ? value : undefined))
    .filter((value): value is JsonObject => Boolean(value))
    .slice(-3)
    .map((intervention) => {
      const summary = readString(intervention, "summary") ?? "draft intervention";
      const draft = readString(intervention, "draft") ?? "(no draft)";
      return `- ${summary}: ${draft}`;
    });
  const lastRun = getObject(runtime, "last_run");
  const lastRunSummary = readString(lastRun, "summary");

  return [
    `- Identity: ${readString(identity, "name") ?? "Void"}${readString(identity, "public_description") ? ` — ${readString(identity, "public_description")}` : ""}`,
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
    lastRunSummary ? `- Last moderation run: ${lastRunSummary}` : "- Last moderation run: none recorded.",
    semanticMemories.length > 0
      ? ["- Recent semantic memories:", ...semanticMemories].join("\n")
      : "- Recent semantic memories: none recorded.",
    musings.length > 0
      ? ["- Stored musings:", ...musings].join("\n")
      : "- Stored musings: none recorded.",
    recentMusings.length > 0
      ? ["- Recent moderation musings:", ...recentMusings].join("\n")
      : "- Recent moderation musings: none recorded.",
    candidateInterventions.length > 0
      ? ["- Draft conversation/intervention seeds:", ...candidateInterventions].join("\n")
      : "- Draft conversation/intervention seeds: none recorded.",
  ].join("\n");
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
