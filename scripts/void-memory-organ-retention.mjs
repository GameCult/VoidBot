import {
  MAX_ARCHIVE_EXCURSION_MEMORIES,
  MAX_REPO_SWEEP_MEMORIES,
  MAX_SEMANTIC_MEMORIES,
  MAX_DREAM_MEMORIES,
  MAX_RUNTIME_REPO_SWEEPS,
  MAX_RUNTIME_REPO_ACTIVITY_MEMORIES,
  MAX_RUNTIME_ARCHIVE_EXCURSIONS,
  MAX_RUNTIME_RUMINATION_SEEDS,
  MAX_RECENT_SYNTHESIS_COUNT,
  MAX_SUPPORTING_REFS,
  MAX_INCUBATION_SOURCE_IDS,
  MAX_DREAM_SOURCE_IDS,
  MAX_POST_NAP_MUSINGS,
  MAX_POST_NAP_ARCHIVE_EXCURSIONS,
  MAX_POST_NAP_REPO_SWEEPS,
  MAX_POST_NAP_NOVELTY_CHECKS,
  MAX_POST_NAP_RESONANCE_EDGES,
  MAX_DISCOMFORT_COUNT,
  MAX_ACTIVE_TENSION_COUNT,
  MAX_ADVOCACY_REQUEST_COUNT,
} from "./void-memory-organ-constants.mjs";
import {
  capDistinctStrings,
  compactLabel,
  compactNarrative,
  compareMemoryFreshness,
  ensureArray,
  ensureObject,
  isObject,
  looksKeywordSalad,
  looksPersonLikeSingleton,
  mergeStringArrays,
  newestIsoTimestamp,
  normalizeText,
  readNumber,
  readString,
  selectRecentRecords,
  topConceptKeywords,
} from "./void-memory-organ-utils.mjs";
import { trimCandidateInterventions } from "./void-memory-organ-agency.mjs";
import { shouldDropSemanticMemory, hasThoughtSurfaceTemplateSmell } from "./void-memory-organ-legacy-translation.mjs";
export function dedupeSemanticMemories({ memories }) {
  const semanticMemories = ensureArray(memories.semantic).filter(isObject);
  const bySignature = new Map();

  for (const memory of semanticMemories) {
    const kind = readString(memory, "kind") ?? "semantic";
    const subjectLabel = readString(memory, "subjectLabel") ?? "";
    const signature = `${kind}|${normalizeText(subjectLabel).toLowerCase()}`;
    const existing = bySignature.get(signature);

    if (!existing) {
      bySignature.set(signature, memory);
      continue;
    }

    existing.evidenceRefs = mergeStringArrays(existing.evidenceRefs, memory.evidenceRefs);
    existing.evidenceMessageIds = mergeStringArrays(existing.evidenceMessageIds, memory.evidenceMessageIds);
    existing.lastObservedAt =
      newestIsoTimestamp(readString(existing, "lastObservedAt"), readString(memory, "lastObservedAt")) ??
      readString(existing, "lastObservedAt") ??
      readString(memory, "lastObservedAt");
    existing.confidence = Math.max(readNumber(existing, "confidence") ?? 0, readNumber(memory, "confidence") ?? 0);
    if ((readString(memory, "summary") ?? "").length > (readString(existing, "summary") ?? "").length) {
      existing.summary = memory.summary;
    }
  }

  memories.semantic = [...bySignature.values()].slice(-MAX_SEMANTIC_MEMORIES);
}

export function dedupeDreamMemories({ memories }) {
  const dreams = ensureArray(memories.dreams).filter(isObject);
  const byTheme = new Map();

  for (const dream of dreams) {
    const theme = normalizeText(readString(dream, "theme") ?? "").toLowerCase();
    if (!theme) {
      continue;
    }
    const existing = byTheme.get(theme);
    if (!existing) {
      byTheme.set(theme, dream);
      continue;
    }
    existing.distilledFrom = mergeStringArrays(existing.distilledFrom, dream.distilledFrom);
    existing.salience = Math.max(readNumber(existing, "salience") ?? 0, readNumber(dream, "salience") ?? 0);
    existing.timestamp =
      newestIsoTimestamp(readString(existing, "timestamp"), readString(dream, "timestamp")) ??
      readString(existing, "timestamp") ??
      readString(dream, "timestamp");
  }

  memories.dreams = [...byTheme.values()].slice(-MAX_DREAM_MEMORIES);
}

export function pruneHistoricalSeamMemories({ memories }) {
  const semanticMemories = ensureArray(memories.semantic).filter(isObject);
  const identitySeams = [];
  const nonSeams = [];
  const groupedDistilled = new Map();

  for (const memory of semanticMemories) {
    if (shouldDropSemanticMemory(memory)) {
      continue;
    }

    const kind = readString(memory, "kind");
    if (kind === "identity_seam") {
      identitySeams.push(memory);
      continue;
    }
    if (kind !== "distilled_seam") {
      const subjectLabel = readString(memory, "subjectLabel") ?? "";
      const subjectId = readString(memory, "subjectId") ?? "";
      if (
        (!subjectLabel || subjectLabel.startsWith("seam:")) &&
        (subjectId.startsWith("seam:") || subjectId.startsWith("pattern-"))
      ) {
        continue;
      }
      if (hasThoughtSurfaceTemplateSmell(readString(memory, "summary") ?? "")) {
        continue;
      }
      nonSeams.push(memory);
      continue;
    }

    const targetKind = readString(memory, "targetKind") ?? "system";
    if (!groupedDistilled.has(targetKind)) {
      groupedDistilled.set(targetKind, []);
    }
    groupedDistilled.get(targetKind).push(memory);
  }

  const keptDistilled = [];
  const limits = new Map([
    ["repo", 8],
    ["archive", 6],
    ["room", 4],
    ["self", 3],
    ["system", 4],
  ]);

  for (const [targetKind, entries] of groupedDistilled.entries()) {
    const sorted = entries
      .filter((entry) => !isLowCoherenceDistilledSeam(entry))
      .filter((entry) => !hasThoughtSurfaceTemplateSmell(readString(entry, "summary") ?? ""))
      .sort(compareMemoryFreshness);
    keptDistilled.push(...sorted.slice(0, limits.get(targetKind) ?? 4));
  }

  memories.semantic = [...nonSeams, ...keptDistilled, ...identitySeams]
    .sort(compareMemoryFreshness)
    .slice(0, MAX_SEMANTIC_MEMORIES);
}

function isLowCoherenceDistilledSeam(entry) {
  const label = readString(entry, "subjectLabel") ?? "";
  const summary = readString(entry, "summary") ?? "";
  const targetKind = readString(entry, "targetKind") ?? "";
  const kind = readString(entry, "kind") ?? "";
  const keywords = topConceptKeywords(`${label} ${summary}`, 5);
  if (keywords.length < 2) {
    return true;
  }
  if (kind === "recent-preoccupation" || kind === "quiet-room-status") {
    return true;
  }
  if (targetKind === "self" && keywords.length < 3) {
    return true;
  }
  if (targetKind === "system" && /live seam|live question|live claim/i.test(summary)) {
    return true;
  }
  if (!label || label.startsWith("seam:")) {
    return true;
  }
  if (looksPersonLikeSingleton(label)) {
    return true;
  }
  if (looksKeywordSalad(label)) {
    return true;
  }
  if (/still matters\./i.test(summary) && !/^[A-Z][A-Za-z0-9]+: /.test(label)) {
    return true;
  }
  return false;
}

export function pruneDreamMemories({ memories }) {
  const dreams = ensureArray(memories.dreams)
    .filter(isObject)
    .filter((dream) => !hasThoughtSurfaceTemplateSmell(readString(dream, "summary") ?? ""))
    .filter((dream) => !looksKeywordSalad(readString(dream, "theme") ?? ""))
    .sort(compareMemoryFreshness);

  memories.dreams = dreams.slice(0, MAX_DREAM_MEMORIES);
}

export function trimHistoricalMemoryResidue({ memories, runtime }) {
  memories.archive_excursions = trimRecentObjectRecords(
    memories.archive_excursions,
    MAX_ARCHIVE_EXCURSION_MEMORIES,
  );
  memories.repo_sweeps = trimRecentObjectRecords(memories.repo_sweeps, MAX_REPO_SWEEP_MEMORIES);
  memories.musings = trimRecentObjectRecords(memories.musings, MAX_POST_NAP_MUSINGS);
  memories.candidate_interventions = trimCandidateInterventions(memories.candidate_interventions);

  runtime.recent_archive_excursions = trimRecentObjectRecords(
    runtime.recent_archive_excursions,
    MAX_POST_NAP_ARCHIVE_EXCURSIONS,
  );
  runtime.archive_excursions = trimRecentObjectRecords(runtime.archive_excursions, MAX_RUNTIME_ARCHIVE_EXCURSIONS);
  runtime.recent_repo_activity_sweeps = trimRecentObjectRecords(
    runtime.recent_repo_activity_sweeps,
    MAX_POST_NAP_REPO_SWEEPS,
  );
  runtime.repo_sweeps = trimRecentObjectRecords(runtime.repo_sweeps, MAX_RUNTIME_REPO_SWEEPS);
  runtime.repo_activity_memories = trimRecentObjectRecords(
    runtime.repo_activity_memories,
    MAX_RUNTIME_REPO_ACTIVITY_MEMORIES,
  );
  runtime.recent_novelty_checks = trimRecentObjectRecords(
    runtime.recent_novelty_checks,
    MAX_POST_NAP_NOVELTY_CHECKS,
  );
  runtime.rumination_seeds = trimRecentObjectRecords(runtime.rumination_seeds, MAX_RUNTIME_RUMINATION_SEEDS);
  runtime.candidate_interventions = trimCandidateInterventions(runtime.candidate_interventions);

  const bridge = ensureObject(runtime.bridge);
  bridge.recent_syntheses = trimRecentObjectRecords(bridge.recent_syntheses, MAX_RECENT_SYNTHESIS_COUNT);
  bridge.unresolved_tensions = trimRecentObjectRecords(bridge.unresolved_tensions, 3);
  runtime.bridge = bridge;

  const memoryResonance = ensureObject(runtime.memory_resonance);
  memoryResonance.recent_edges = trimRecentObjectRecords(
    memoryResonance.recent_edges,
    MAX_POST_NAP_RESONANCE_EDGES,
  );
  runtime.memory_resonance = memoryResonance;

  if (Array.isArray(runtime.pending_adjustments) && runtime.pending_adjustments.length > 0) {
    runtime.pending_adjustments = runtime.pending_adjustments.slice(-1);
  }

  scrubRuntimeThoughtResidue({ runtime });
  distillStateSurface({ memories, runtime });
}

export function trimRecentObjectRecords(entries, limit) {
  return ensureArray(entries).filter(isObject).sort(compareMemoryFreshness).slice(0, limit);
}

function scrubRuntimeThoughtResidue({ runtime }) {
  const candidateInterventions = ensureArray(runtime.candidate_interventions)
    .filter(isObject)
    .filter((entry) => !entryHasThoughtSurfaceTemplateSmell(entry))
    .map((entry) => scrubThoughtLikeEntry(entry));
  runtime.candidate_interventions = trimCandidateInterventions(candidateInterventions);

  runtime.discomforts = ensureArray(runtime.discomforts)
    .filter(isObject)
    .filter((entry) => !entryHasThoughtSurfaceTemplateSmell(entry))
    .map((entry) => scrubThoughtLikeEntry(entry))
    .slice(0, MAX_DISCOMFORT_COUNT);

  runtime.active_tensions = ensureArray(runtime.active_tensions)
    .filter(isObject)
    .filter((entry) => !entryHasThoughtSurfaceTemplateSmell(entry))
    .map((entry) => scrubThoughtLikeEntry(entry))
    .slice(0, MAX_ACTIVE_TENSION_COUNT);

  runtime.self_advocacy_requests = ensureArray(runtime.self_advocacy_requests)
    .filter(isObject)
    .filter((entry) => !entryHasThoughtSurfaceTemplateSmell(entry))
    .map((entry) => scrubThoughtLikeEntry(entry))
    .slice(0, MAX_ADVOCACY_REQUEST_COUNT);

  runtime.world_advocacy_requests = ensureArray(runtime.world_advocacy_requests)
    .filter(isObject)
    .filter((entry) => !entryHasThoughtSurfaceTemplateSmell(entry))
    .map((entry) => scrubThoughtLikeEntry(entry))
    .slice(0, MAX_ADVOCACY_REQUEST_COUNT);
}

function entryHasThoughtSurfaceTemplateSmell(entry) {
  return Object.values(entry).some((value) => typeof value === "string" && hasThoughtSurfaceTemplateSmell(value));
}

function scrubThoughtLikeEntry(entry) {
  const next = { ...entry };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value !== "string") {
      continue;
    }
    next[key] = scrubThoughtSurfaceText(value);
  }
  return next;
}

function scrubThoughtSurfaceText(value) {
  if (!hasThoughtSurfaceTemplateSmell(value)) {
    return value;
  }

  return normalizeText(value)
    .replace(/\bseems to have a live seam around\b/gi, "is accumulating a concrete decision around")
    .replace(/\blive seam around\b/gi, "concrete decision around")
    .replace(/\blooks like a live seam,? not just ambient noise\.?/gi, "is staying structurally important across passes.")
    .replace(/\bstill looks like a live seam\.?/gi, "remains unresolved enough to deserve a cleaner read.")
    .replace(/\blooks like a live claim\.?/gi, "has become a concrete claim.")
    .replace(/\bstill looks like a live question\.?/gi, "remains an unresolved question.")
    .replace(/\s+/g, " ")
    .trim();
}

function distillStateSurface({ memories, runtime }) {
  for (const entry of ensureArray(memories.episodic).filter(isObject)) {
    if (typeof entry.summary === "string") {
      entry.summary = compactNarrative(entry.summary);
    }
    if (typeof entry.significance === "string") {
      entry.significance = compactNarrative(entry.significance);
    }
  }
  for (const memory of ensureArray(memories.semantic).filter(isObject)) {
    memory.evidenceRefs = capDistinctStrings(memory.evidenceRefs, MAX_SUPPORTING_REFS);
    if (typeof memory.summary === "string") {
      memory.summary = compactNarrative(memory.summary);
    }
  }
  for (const dream of ensureArray(memories.dreams).filter(isObject)) {
    dream.distilledFrom = capDistinctStrings(dream.distilledFrom, MAX_DREAM_SOURCE_IDS);
    if (typeof dream.summary === "string") {
      dream.summary = compactNarrative(dream.summary);
    }
  }
  for (const thought of ensureArray(ensureObject(runtime.incubation).active_thoughts).filter(isObject)) {
    thought.sourceMemoryIds = capDistinctStrings(thought.sourceMemoryIds, MAX_INCUBATION_SOURCE_IDS);
  }
  for (const entry of ensureArray(ensureObject(runtime.bridge).recent_syntheses).filter(isObject)) {
    entry.dominantTopics = capDistinctStrings(entry.dominantTopics, 3);
    if (typeof entry.analytic === "string") {
      entry.analytic = compactNarrative(entry.analytic);
    }
    if (typeof entry.associative === "string") {
      entry.associative = compactNarrative(entry.associative);
    }
  }
  for (const entry of ensureArray(runtime.recent_repo_activity_sweeps).filter(isObject)) {
    if (typeof entry.summary === "string") {
      entry.summary = compactNarrative(entry.summary);
    }
  }
  for (const entry of ensureArray(runtime.repo_sweeps).filter(isObject)) {
    if (typeof entry.summary === "string") {
      entry.summary = compactNarrative(entry.summary);
    }
  }
  for (const entry of ensureArray(runtime.repo_activity_memories).filter(isObject)) {
    if (typeof entry.summary === "string") {
      entry.summary = compactNarrative(entry.summary);
    }
  }
  for (const entry of ensureArray(memories.repo_sweeps).filter(isObject)) {
    if (typeof entry.summary === "string") {
      entry.summary = compactNarrative(entry.summary);
    }
  }
  for (const entry of ensureArray(memories.musings).filter(isObject)) {
    if (typeof entry.summary === "string") {
      entry.summary = compactNarrative(entry.summary);
    }
  }
  const recentActivity = ensureObject(runtime.recent_activity);
  if (typeof recentActivity.summary === "string") {
    recentActivity.summary = compactNarrative(recentActivity.summary);
  }
  if (typeof recentActivity.lastDecisionRationale === "string") {
    recentActivity.lastDecisionRationale = compactNarrative(recentActivity.lastDecisionRationale);
  }
  runtime.recent_activity = recentActivity;
  const thoughtLanes = ensureObject(runtime.thought_lanes);
  if (typeof thoughtLanes.analytic === "string") {
    thoughtLanes.analytic = compactNarrative(thoughtLanes.analytic);
  }
  if (typeof thoughtLanes.associative === "string") {
    thoughtLanes.associative = compactNarrative(thoughtLanes.associative);
  }
  runtime.thought_lanes = thoughtLanes;
  runtime.pending_adjustments = ensureArray(runtime.pending_adjustments)
    .filter(isObject)
    .map((entry) => {
      if (typeof entry.summary !== "string") {
        return entry;
      }
      return {
        ...entry,
        summary: compactNarrative(entry.summary),
      };
    });
  const memoryResonance = ensureObject(runtime.memory_resonance);
  for (const edge of ensureArray(memoryResonance.recent_edges).filter(isObject)) {
    if (typeof edge.leftLabel === "string") {
      edge.leftLabel = compactLabel(edge.leftLabel);
    }
    if (typeof edge.rightLabel === "string") {
      edge.rightLabel = compactLabel(edge.rightLabel);
    }
    if (typeof edge.summary === "string") {
      edge.summary = compactNarrative(edge.summary);
    }
  }
}
