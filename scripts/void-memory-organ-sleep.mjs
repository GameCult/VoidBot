import {
  MAX_DREAM_SOURCE_IDS,
  MAX_DREAM_MEMORIES,
  MAX_POST_NAP_EPISODIC_RECORDS,
  MAX_POST_NAP_QUIET_EPISODIC_RECORDS,
  MAX_POST_NAP_MUSINGS,
  MAX_POST_NAP_ARCHIVE_EXCURSIONS,
  MAX_POST_NAP_REPO_SWEEPS,
  MAX_POST_NAP_NOVELTY_CHECKS,
  MAX_POST_NAP_RECENT_MUSINGS,
  MAX_POST_NAP_RESONANCE_EDGES,
  MAX_CLUSTER_COUNT,
  MAX_POST_NAP_SEAM_PROMOTIONS,
  MAX_SUPPORTING_REFS,
  MAX_SEMANTIC_MEMORIES,
  TOPIC_MATCH_THRESHOLD,
  ensureArray,
  ensureStringArray,
  readString,
  readNumber,
  sanitizePreferredThoughtLabel,
  looksKeywordSalad,
  selectRecentRecords,
  capDistinctStrings,
  appendClause,
  topicSimilarity,
  hashString,
  round3,
  clamp,
  isObject,
} from "./void-memory-organ-shared.mjs";
import { trimCandidateInterventions } from "./void-memory-organ-agency.mjs";
import {
  trimHistoricalMemoryResidue,
  trimRecentObjectRecords,
  buildConciseThoughtSummary,
  buildDreamSummary,
} from "./void-memory-organ-cleanup.mjs";

export function distillDreams({ memories, sleepCycle, incubation, now }) {
  const dreams = ensureArray(memories.dreams);
  if (sleepCycle.isNapping !== true) {
    return { created: false, theme: null };
  }

  const strongestThought = ensureArray(incubation.active_thoughts)
    .filter(isObject)
    .sort((left, right) => (readNumber(right, "maturation") ?? 0) - (readNumber(left, "maturation") ?? 0))[0];

  if (!strongestThought) {
    return { created: false, theme: null };
  }

  const theme =
    sanitizePreferredThoughtLabel(readString(strongestThought, "topic") ?? "") ??
    readString(strongestThought, "focusPhrase") ??
    "unlabeled seam";
  if (looksKeywordSalad(theme)) {
    return { created: false, theme: null };
  }

  const summary = buildDreamSummary({
    label: theme,
    focusPhrase: theme,
    targetKind: readString(strongestThought, "targetKind") ?? "self",
  });
  const latestDream = dreams.length > 0 && isObject(dreams[dreams.length - 1]) ? dreams[dreams.length - 1] : null;

  if (
    latestDream &&
    readString(latestDream, "theme") === theme &&
    readString(latestDream, "summary") === summary
  ) {
    sleepCycle.activeDreamThemes = [theme];
    sleepCycle.lastDreamAt = now.toISOString();
    sleepCycle.lastDistillationSummary = `Strengthened dream seam: ${theme}.`;
    return { created: false, theme };
  }

  dreams.push({
    memoryId: `dream-${hashString(`${theme}|${now.toISOString()}`).slice(0, 12)}`,
    timestamp: now.toISOString(),
    theme,
    summary,
    distilledFrom: capDistinctStrings(strongestThought.sourceMemoryIds, MAX_DREAM_SOURCE_IDS),
    salience: round3(
      clamp(
        (readNumber(strongestThought, "maturation") ?? 0.4) * 0.55 +
          (readNumber(strongestThought, "resonance") ?? 0.4) * 0.45,
        0,
        1,
      ),
    ),
  });

  memories.dreams = dreams.slice(-MAX_DREAM_MEMORIES);
  sleepCycle.activeDreamThemes = [theme];
  sleepCycle.lastDreamAt = now.toISOString();
  sleepCycle.dreamCountInCurrentNap = Number(sleepCycle.dreamCountInCurrentNap ?? 0) + 1;
  sleepCycle.lastDistillationSummary = `Dreamed a tighter seam: ${theme}.`;

  return { created: true, theme };
}

export function consolidateSleepMemory({ memories, runtime, sleepCycle, incubation, memoryResonance, now }) {
  if (sleepCycle.isNapping !== true) {
    return { consolidated: false, promotedSeamCount: 0 };
  }

  const promotedSeamCount = promoteDistilledSeams({
    memories,
    incubation,
    memoryResonance,
    now,
  });

  memories.episodic = selectRecentRecords(ensureArray(memories.episodic), {
    limit: MAX_POST_NAP_EPISODIC_RECORDS,
    quietLimit: MAX_POST_NAP_QUIET_EPISODIC_RECORDS,
  });
  memories.musings = ensureArray(memories.musings)
    .filter(isObject)
    .slice(-MAX_POST_NAP_MUSINGS);
  runtime.recent_archive_excursions = ensureArray(runtime.recent_archive_excursions)
    .filter(isObject)
    .slice(-MAX_POST_NAP_ARCHIVE_EXCURSIONS);
  runtime.recent_repo_activity_sweeps = ensureArray(runtime.recent_repo_activity_sweeps)
    .filter(isObject)
    .slice(-MAX_POST_NAP_REPO_SWEEPS);
  runtime.recent_novelty_checks = ensureArray(runtime.recent_novelty_checks)
    .filter(isObject)
    .slice(-MAX_POST_NAP_NOVELTY_CHECKS);
  runtime.recent_musings = ensureArray(runtime.recent_musings)
    .filter((value) => typeof value === "string")
    .slice(-MAX_POST_NAP_RECENT_MUSINGS);
  trimHistoricalMemoryResidue({ memories, runtime });
  runtime.candidate_interventions = trimCandidateInterventions(runtime.candidate_interventions);
  memoryResonance.recent_edges = trimRecentObjectRecords(memoryResonance.recent_edges, MAX_POST_NAP_RESONANCE_EDGES);
  memoryResonance.clusters = trimRecentObjectRecords(memoryResonance.clusters, MAX_CLUSTER_COUNT);
  incubation.active_thoughts = trimRecentObjectRecords(incubation.active_thoughts, 3);

  sleepCycle.lastDistillationSummary = appendClause(
    sleepCycle.lastDistillationSummary,
    promotedSeamCount > 0
      ? `Compressed yesterday's specimens into ${promotedSeamCount} seam-shaped memory${promotedSeamCount === 1 ? "" : " seams"} and cut the loose scraps back down.`
      : "Compressed yesterday's specimens back into a smaller seam-shaped memory surface.",
  );

  return { consolidated: true, promotedSeamCount };
}

function promoteDistilledSeams({ memories, incubation, memoryResonance, now }) {
  const semanticMemories = ensureArray(memories.semantic).filter(isObject);
  const thoughtCandidates = ensureArray(incubation.active_thoughts)
    .filter(isObject)
    .sort(
      (left, right) =>
        (readNumber(right, "maturation") ?? 0) - (readNumber(left, "maturation") ?? 0),
    )
    .slice(0, MAX_POST_NAP_SEAM_PROMOTIONS);
  const clusterByLabel = new Map(
    ensureArray(memoryResonance?.clusters)
      .filter(isObject)
      .map((cluster) => [readString(cluster, "label") ?? "", cluster]),
  );

  let promoted = 0;

  for (const thought of thoughtCandidates) {
    const topic =
      sanitizePreferredThoughtLabel(readString(thought, "topic") ?? "") ??
      readString(thought, "focusPhrase") ??
      readString(thought, "fascinationTarget");
    const summary = readString(thought, "summary");
    if (!topic || !summary || looksKeywordSalad(topic)) {
      continue;
    }

    const cluster = clusterByLabel.get(topic);
    const distilledSummary = buildDistilledSeamSummary({ thought, cluster });
    const subjectId = `seam:${hashString(topic).slice(0, 12)}`;
    const sourceRefs = capDistinctStrings(
      [
        ...ensureStringArray(thought.sourceMemoryIds),
        ...(cluster ? ensureStringArray(cluster.memoryIds) : []),
      ],
      MAX_SUPPORTING_REFS,
    );
    const existing = semanticMemories.find((memory) => {
      const existingSubjectId = readString(memory, "subjectId");
      const existingSubjectLabel = readString(memory, "subjectLabel");
      return (
        existingSubjectId === subjectId ||
        topicSimilarity(existingSubjectLabel ?? "", topic) >= TOPIC_MATCH_THRESHOLD
      );
    });

    if (existing) {
      existing.kind = "distilled_seam";
      existing.subjectId = subjectId;
      existing.subjectLabel = topic;
      existing.summary = distilledSummary;
      existing.lastObservedAt = now.toISOString();
      existing.evidenceRefs = sourceRefs;
      existing.sleepDistilledAt = now.toISOString();
      existing.lastDistilledQuestion = readString(thought, "latentQuestion") ?? null;
    } else {
      semanticMemories.push({
        memoryId: `semantic-seam-${hashString(`${topic}|${now.toISOString()}`).slice(0, 12)}`,
        kind: "distilled_seam",
        subjectId,
        subjectLabel: topic,
        summary: distilledSummary,
        evidenceRefs: sourceRefs,
        lastObservedAt: now.toISOString(),
        sleepDistilledAt: now.toISOString(),
        lastDistilledQuestion: readString(thought, "latentQuestion") ?? null,
      });
    }

    promoted += 1;
  }

  memories.semantic = semanticMemories.slice(-MAX_SEMANTIC_MEMORIES);
  return promoted;
}

function buildDistilledSeamSummary({ thought, cluster }) {
  const targetKind = readString(thought, "targetKind") ?? "system";
  const focusKind = readString(thought, "focusKind") ?? "question";
  const focusPhrase =
    readString(thought, "focusPhrase") ??
    readString(thought, "topic") ??
    readString(thought, "fascinationTarget") ??
    "this seam";
  const synthesized = {
    focusPhrase,
    fascinationTarget: readString(thought, "fascinationTarget") ?? focusPhrase,
  };
  const summary = buildConciseThoughtSummary({ focusKind, targetKind, synthesized });
  const sourceKinds = cluster ? ensureStringArray(cluster.sourceKinds) : ensureStringArray(thought.sourceKinds);
  const shortSourceKinds = sourceKinds.filter(Boolean).slice(0, 3);
  const sourceLine =
    shortSourceKinds.length >= 2 ? ` Built from ${shortSourceKinds.join(", ")}.` : "";

  return `${summary}${sourceLine}`.trim();
}
