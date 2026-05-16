import {
  MAX_EDGE_COUNT,
  MAX_POST_NAP_NOVELTY_CHECKS,
  MAX_REPO_SWEEP_MEMORIES,
  MAX_RUNTIME_ARCHIVE_EXCURSIONS,
  MAX_RUNTIME_REPO_ACTIVITY_MEMORIES,
} from "./void-memory-organ-constants.mjs";
import {
  cloneJson,
  compactNarrative,
  compareMemoryFreshness,
  ensureArray,
  ensureObject,
  isObject,
  looksLegacyThoughtSurface,
  readString,
} from "./void-memory-organ-utils.mjs";

export function trimLegacyRuntimeResidue({ runtime }) {
  const memoryResonance = ensureObject(runtime.memory_resonance);
  const recentEdges = ensureArray(memoryResonance.recent_edges).filter(isObject);
  memoryResonance.recent_edges = recentEdges
    .filter((edge) => !looksLegacyThoughtSurface(readString(edge, "leftLabel") ?? "", readString(edge, "summary") ?? ""))
    .slice(-MAX_EDGE_COUNT);
  runtime.memory_resonance = memoryResonance;
}

export function reconcileLegacyStateMirrors({ state, memories, runtime, now }) {
  const timestamp = now.toISOString();
  const bridge = ensureObject(runtime.bridge);
  const runtimeThoughtLanes = ensureObject(runtime.thought_lanes);
  const activeThoughts = ensureArray(ensureObject(runtime.incubation).active_thoughts).filter(isObject);
  const activeTensions = ensureArray(runtime.active_tensions).filter(isObject);

  state.archive_excursions = [];
  state.repo_sweeps = ensureArray(memories.repo_sweeps)
    .filter(isObject)
    .map((entry) => compactRepoSweepMirror(entry))
    .slice(0, MAX_REPO_SWEEP_MEMORIES);
  state.repo_activity_memories = ensureArray(runtime.repo_activity_memories)
    .filter(isObject)
    .map((entry) => compactRepoSweepMirror(entry))
    .slice(0, MAX_RUNTIME_REPO_ACTIVITY_MEMORIES);
  state.recent_archive_excursions = ensureArray(runtime.recent_archive_excursions)
    .filter(isObject)
    .map((entry) => compactArchiveExcursionMirror(entry))
    .slice(0, MAX_RUNTIME_ARCHIVE_EXCURSIONS);
  state.recent_novelty_checks = ensureArray(runtime.recent_novelty_checks)
    .filter(isObject)
    .map((entry) => compactNoveltyCheckMirror(entry))
    .slice(0, MAX_POST_NAP_NOVELTY_CHECKS);
  state.recent_activity = compactRecentActivityMirror(runtime.recent_activity, runtime, timestamp);
  state.source_coverage = cloneJson(ensureObject(runtime.source_coverage));
  state.speaking_bias = cloneJson(ensureObject(runtime.speaking_bias));
  state.lastReviewSummary = readString(runtime, "lastReviewSummary") ?? readString(runtime, "last_review_summary") ?? null;
  state.lastReviewSummaryShort =
    readString(runtime, "lastReviewSummaryShort") ?? readString(runtime, "last_review_summary_short") ?? null;
  state.last_review_summary = state.lastReviewSummary;
  state.last_review_summary_short = state.lastReviewSummaryShort;
  state.thought_lanes = {
    analytic: buildThoughtLaneMirror({
      sourceValue: runtimeThoughtLanes.analytic,
      fallback: activeTensions[0],
      timestamp,
    }),
    associative: buildThoughtLaneMirror({
      sourceValue: runtimeThoughtLanes.associative,
      fallback: activeThoughts[0] ?? bridge,
      timestamp,
    }),
  };
}

function compactRepoSweepMirror(entry) {
  return {
    timestamp: readString(entry, "timestamp") ?? null,
    memoryId: readString(entry, "memoryId") ?? null,
    summary: compactNarrative(readString(entry, "summary") ?? ""),
    repoNames: ensureStringArray(entry.repoNames).slice(0, 3),
    whyItMattered: compactNarrative(readString(entry, "whyItMattered") ?? ""),
  };
}

function compactArchiveExcursionMirror(entry) {
  return {
    memoryId: readString(entry, "memoryId") ?? null,
    timestamp: readString(entry, "timestamp") ?? null,
    topicHint: compactNarrative(readString(entry, "topicHint") ?? ""),
    whyItWasFresh: compactNarrative(readString(entry, "whyItWasFresh") ?? ""),
  };
}

function compactNoveltyCheckMirror(entry) {
  return {
    timestamp: readString(entry, "timestamp") ?? null,
    query: compactNarrative(readString(entry, "query") ?? ""),
    candidate: compactNarrative(readString(entry, "candidate") ?? ""),
    result: readString(entry, "result") ?? null,
    note: compactNarrative(readString(entry, "note") ?? ""),
  };
}

function compactRecentActivityMirror(value, runtime, timestamp) {
  const recentActivity = isObject(value) ? cloneJson(value) : {};
  recentActivity.checkedAt = readString(recentActivity, "checkedAt") ?? timestamp;
  if (typeof recentActivity.summary === "string") {
    recentActivity.summary = compactNarrative(recentActivity.summary);
  }
  if (typeof recentActivity.lastDecisionRationale === "string") {
    recentActivity.lastDecisionRationale = compactNarrative(recentActivity.lastDecisionRationale);
  }
  if (!recentActivity.summary) {
    recentActivity.summary =
      compactNarrative(readString(runtime, "lastReviewSummary") ?? readString(runtime, "last_review_summary") ?? "") ??
      "";
  }
  return recentActivity;
}

function buildThoughtLaneMirror({ sourceValue, fallback, timestamp }) {
  const summary = summarizeThoughtLaneSource(sourceValue, fallback);
  return summary
    ? [
        {
          timestamp,
          summary,
        },
      ]
    : [];
}

function summarizeThoughtLaneSource(sourceValue, fallback) {
  if (typeof sourceValue === "string") {
    return compactNarrative(sourceValue);
  }

  if (isObject(sourceValue)) {
    const threads = ensureArray(sourceValue.active_threads).filter(isObject);
    if (threads.length > 0) {
      const latest = threads
        .slice()
        .sort(compareMemoryFreshness)[0];
      return compactNarrative(
        [readString(latest, "topic"), readString(latest, "claim"), readString(latest, "counterweight")]
          .filter(Boolean)
          .join(". "),
      );
    }
    const description = readString(sourceValue, "description");
    if (description) {
      return compactNarrative(description);
    }
  }

  if (isObject(fallback)) {
    return compactNarrative(
      [
        readString(fallback, "topic"),
        readString(fallback, "summary"),
        readString(fallback, "claim"),
        readString(fallback, "opinion"),
      ]
        .filter(Boolean)
        .join(". "),
    );
  }

  return null;
}
