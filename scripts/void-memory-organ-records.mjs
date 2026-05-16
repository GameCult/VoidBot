import {
  MAX_RECENT_ANALYTIC_THREADS,
  MAX_RECENT_EPISODIC_RECORDS,
  MAX_RECENT_QUIET_ANALYTIC_THREADS,
  MAX_RECENT_QUIET_EPISODIC_RECORDS,
} from "./void-memory-organ-constants.mjs";
import {
  ensureArray,
  ensureMemoryId,
  ensureObject,
  ensureStringArray,
  isLowSignalQuietRoomText,
  isObject,
  normalizeText,
  readString,
  selectRecentRecords,
} from "./void-memory-organ-utils.mjs";

export function collectMemoryRecords({ memories, runtime }) {
  const records = [];

  pushArrayRecords(records, selectRecentRecords(ensureArray(memories.episodic), {
    limit: MAX_RECENT_EPISODIC_RECORDS,
    quietLimit: MAX_RECENT_QUIET_EPISODIC_RECORDS,
  }), "episodic", (entry) => ({
    text: readString(entry, "summary"),
    label: readString(entry, "summary") ?? "episodic memory",
    timestamp: readString(entry, "timestamp"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "episodic" }),
  }));
  pushArrayRecords(records, ensureArray(memories.semantic).slice(-24), "semantic", (entry) => ({
    text: [readString(entry, "subjectLabel"), readString(entry, "kind"), readString(entry, "summary")]
      .filter(Boolean)
      .join(" | "),
    label: readString(entry, "subjectLabel") ?? readString(entry, "kind") ?? "semantic memory",
    timestamp: readString(entry, "lastObservedAt"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "semantic" }),
  }));
  pushArrayRecords(records, ensureArray(memories.musings).slice(-12), "musing", (entry) => ({
    text: [readString(entry, "topic"), readString(entry, "summary")].filter(Boolean).join(" | "),
    label: readString(entry, "topic") ?? "musing",
    timestamp: readString(entry, "timestamp"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "musing" }),
  }));
  pushArrayRecords(records, ensureArray(memories.dreams).slice(-10), "dream", (entry) => ({
    text: [readString(entry, "theme"), readString(entry, "summary")].filter(Boolean).join(" | "),
    label: readString(entry, "theme") ?? "dream",
    timestamp: readString(entry, "timestamp"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "dream" }),
  }));
  pushArrayRecords(records, ensureArray(runtime.recent_archive_excursions).slice(-8), "archive_excursion", (entry) => ({
    text: [readString(entry, "topicHint"), readString(entry, "whyItWasFresh")].filter(Boolean).join(" | "),
    label: readString(entry, "topicHint") ?? "archive excursion",
    timestamp: readString(entry, "timestamp"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "archive_excursion" }),
  }));
  pushArrayRecords(records, ensureArray(runtime.recent_repo_activity_sweeps).slice(-8), "repo_sweep", (entry) => ({
    text: [readString(entry, "summary"), readString(entry, "whyItMattered")].filter(Boolean).join(" | "),
    label: readString(entry, "summary") ?? "repo sweep",
    timestamp: readString(entry, "timestamp"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "repo_sweep" }),
  }));
  pushArrayRecords(
    records,
    selectRecentRecords(ensureArray(ensureObject(runtime.thought_lanes).analytic?.active_threads), {
      limit: MAX_RECENT_ANALYTIC_THREADS,
      quietLimit: MAX_RECENT_QUIET_ANALYTIC_THREADS,
    }),
    "analytic_thread",
    (entry) => ({
      text: [readString(entry, "topic"), readString(entry, "claim"), readString(entry, "counterweight")]
        .filter(Boolean)
        .join(" | "),
      label: readString(entry, "topic") ?? "analytic thread",
      timestamp: readString(entry, "lastTouchedAt"),
      sourceRefs: gatherSourceRefs(entry),
      sourceMeta: gatherSourceMeta({ entry, kind: "analytic_thread" }),
    }),
  );
  pushArrayRecords(
    records,
    ensureArray(ensureObject(runtime.thought_lanes).associative?.active_threads).slice(-6),
    "associative_thread",
    (entry) => ({
      text: [readString(entry, "topic"), readString(entry, "claim"), readString(entry, "counterweight")]
        .filter(Boolean)
        .join(" | "),
      label: readString(entry, "topic") ?? "associative thread",
      timestamp: readString(entry, "lastTouchedAt"),
      sourceRefs: gatherSourceRefs(entry),
      sourceMeta: gatherSourceMeta({ entry, kind: "associative_thread" }),
    }),
  );
  pushArrayRecords(records, ensureArray(ensureObject(runtime.bridge).recent_syntheses).slice(-8), "bridge_synthesis", (entry) => ({
    text: [readString(entry, "summary"), ...ensureStringArray(entry.dominantTopics)].filter(Boolean).join(" | "),
    label: readString(entry, "summary") ?? "bridge synthesis",
    timestamp: readString(entry, "timestamp"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "bridge_synthesis" }),
  }));
  pushArrayRecords(records, ensureArray(runtime.candidate_interventions).slice(-8), "candidate_intervention", (entry) => ({
    text: [readString(entry, "summary"), readString(entry, "draft")].filter(Boolean).join(" | "),
    label: readString(entry, "summary") ?? "candidate intervention",
    timestamp: readString(entry, "timestamp"),
    sourceRefs: gatherSourceRefs(entry),
    sourceMeta: gatherSourceMeta({ entry, kind: "candidate_intervention" }),
  }));

  return records;
}

function pushArrayRecords(target, entries, kind, toRecord) {
  for (const entry of entries) {
    if (!isObject(entry)) {
      continue;
    }

    const record = toRecord(entry);
    const text = normalizeText(record.text);

    if (!text) {
      continue;
    }

    entry.memoryId = ensureMemoryId(entry, kind, text);
    target.push({
      kind,
      entry,
      memoryId: entry.memoryId,
      text,
      label: record.label ?? kind,
      timestamp: record.timestamp ?? null,
      sourceRefs: ensureStringArray(record.sourceRefs),
      sourceMeta: isObject(record.sourceMeta) ? record.sourceMeta : {},
      lowSignalQuietRoom: isLowSignalQuietRoomText(text),
    });
  }
}

function gatherSourceRefs(entry) {
  if (!isObject(entry)) {
    return [];
  }
  return [
    ...ensureStringArray(entry.evidenceRefs),
    ...ensureStringArray(entry.evidenceMessageIds),
    ...ensureStringArray(entry.distilledFrom),
    ...ensureStringArray(entry.sourceMemoryIds),
  ];
}

function gatherSourceMeta({ entry, kind }) {
  const sourceMeta = {};
  const repoNames = [
    ...new Set([
      ...ensureStringArray(entry.repoNames),
      ...inferRepoNamesFromEntry(entry),
    ]),
  ];
  if (repoNames.length > 0) {
    sourceMeta.repoNames = repoNames;
  }

  const channelId = readString(entry, "channelId");
  if (channelId) {
    sourceMeta.channelId = channelId;
  }

  if (kind === "archive_excursion") {
    const archiveTimestamp =
      readString(entry, "anchorTimestamp") ??
      readString(entry, "sourceTimestamp") ??
      readString(entry, "timestamp");
    const archiveYear = extractYear(archiveTimestamp);
    if (archiveYear) {
      sourceMeta.archiveYear = archiveYear;
    }
  }

  if (kind === "bridge_synthesis") {
    const dominantTopics = ensureStringArray(entry.dominantTopics);
    if (dominantTopics.length > 0) {
      sourceMeta.dominantTopics = dominantTopics;
    }
  }

  return sourceMeta;
}

function inferRepoNamesFromEntry(entry) {
  const subjectLabel =
    readString(entry, "subjectLabel") ??
    readString(entry, "topic") ??
    readString(entry, "label") ??
    readString(entry, "fascinationTarget");
  const repoName = extractRepoNameFromLabel(subjectLabel);
  return repoName ? [repoName] : [];
}

export function extractYear(timestamp) {
  if (typeof timestamp !== "string" || timestamp.length < 4) {
    return undefined;
  }
  const match = timestamp.match(/^(\d{4})-/);
  return match ? match[1] : undefined;
}

function extractRepoNameFromLabel(label) {
  const normalized = normalizeText(label);
  if (!normalized || !normalized.includes(":")) {
    return null;
  }
  const [prefix] = normalized.split(/:\s*/, 1);
  if (!prefix || !/[A-Z]/.test(prefix)) {
    return null;
  }
  return prefix;
}
