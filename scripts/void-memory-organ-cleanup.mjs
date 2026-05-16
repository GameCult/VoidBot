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
  MAX_RECENT_ANALYTIC_THREADS,
  MAX_RECENT_QUIET_ANALYTIC_THREADS,
  MAX_RECENT_EPISODIC_RECORDS,
  MAX_RECENT_QUIET_EPISODIC_RECORDS,
  TOPIC_MATCH_THRESHOLD,
  ensureArray,
  ensureObject,
  ensureStringArray,
  readString,
  readNumber,
  normalizeText,
  sanitizePreferredThoughtLabel,
  looksKeywordSalad,
  looksPersonLikeSingleton,
  looksLegacyThoughtSurface,
  topConceptKeywords,
  compactNarrative,
  compactLabel,
  capDistinctStrings,
  compareMemoryFreshness,
  mergeStringArrays,
  newestIsoTimestamp,
  selectRecentRecords,
  topicSimilarity,
  clamp,
  isObject,
} from "./void-memory-organ-shared.mjs";
import {
  buildClusterCuriosityProfile,
  extractRepoNameFromLabel,
  synthesizeThoughtSurface,
  capitalizePhrase,
} from "./void-memory-organ-graph.mjs";
import { reconcileLegacyStateMirrors, trimLegacyRuntimeResidue } from "./void-memory-organ-legacy-mirrors.mjs";
import { trimCandidateInterventions } from "./void-memory-organ-agency.mjs";

export function normalizeHistoricalMemorySurfaces({ state, memories, runtime, now }) {
  normalizeSemanticMemories({ memories, now });
  normalizeDreamMemories({ memories, now });
  dedupeSemanticMemories({ memories });
  dedupeDreamMemories({ memories });
  pruneHistoricalSeamMemories({ memories });
  pruneDreamMemories({ memories });
  trimHistoricalMemoryResidue({ memories, runtime });
  trimLegacyRuntimeResidue({ runtime });
  reconcileLegacyStateMirrors({ state, memories, runtime, now });
}

function normalizeSemanticMemories({ memories, now }) {
  const semanticMemories = ensureArray(memories.semantic).filter(isObject);
  const kept = [];

  for (const memory of semanticMemories) {
    if (shouldDropSemanticMemory(memory)) {
      continue;
    }

    if (readString(memory, "kind") === "identity_seam") {
      kept.push(memory);
      continue;
    }

    if (isStableSemanticMemory(memory)) {
      memory.lastTranslatedAt = readString(memory, "lastTranslatedAt") ?? now.toISOString();
      kept.push(memory);
      continue;
    }

    const preferredLabel = choosePreferredThoughtLabel(memory);
    const normalized = translateLegacyThoughtLikeEntry({
      label: preferredLabel ?? readString(memory, "kind") ?? "semantic seam",
      summary: readString(memory, "summary") ?? "",
      fallbackTargetKind: "self",
      fallbackFocusKind: "question",
      evidenceRefs: ensureStringArray(memory.evidenceRefs),
      repoNames: ensureStringArray(memory.repoNames),
    });

    if (!normalized) {
      continue;
    }

    if (shouldPurgeThoughtLikeMemory({ entry: memory, normalized, preferredLabel })) {
      continue;
    }

    memory.subjectLabel = normalized.label;
    memory.summary = normalized.summary;
    memory.focusKind = normalized.focusKind;
    memory.targetKind = normalized.targetKind;
    memory.focusPhrase = normalized.focusPhrase;
    memory.question = normalized.question;
    memory.claim = normalized.claim;
    memory.fascinationTarget = normalized.fascinationTarget;
    memory.worldFacing = normalized.worldFacing;
    memory.lastTranslatedAt = now.toISOString();
    kept.push(memory);
  }

  memories.semantic = kept.slice(-MAX_SEMANTIC_MEMORIES);
}

function normalizeDreamMemories({ memories, now }) {
  const dreams = ensureArray(memories.dreams).filter(isObject);
  const kept = [];

  for (const dream of dreams) {
    if (isStableDreamMemory(dream)) {
      dream.lastTranslatedAt = readString(dream, "lastTranslatedAt") ?? now.toISOString();
      kept.push(dream);
      continue;
    }

    const normalized = translateLegacyThoughtLikeEntry({
      label: choosePreferredDreamTheme(dream) ?? "dream seam",
      summary: readString(dream, "summary") ?? "",
      fallbackTargetKind: "self",
      fallbackFocusKind: "question",
      evidenceRefs: ensureStringArray(dream.distilledFrom),
      repoNames: ensureStringArray(dream.repoNames),
    });

    if (!normalized) {
      continue;
    }

    if (
      shouldPurgeThoughtLikeMemory({
        entry: dream,
        normalized,
        preferredLabel: choosePreferredDreamTheme(dream),
      })
    ) {
      continue;
    }

    dream.theme = normalized.label;
    dream.summary = buildDreamSummary(normalized);
    dream.focusKind = normalized.focusKind;
    dream.targetKind = normalized.targetKind;
    dream.focusPhrase = normalized.focusPhrase;
    dream.question = normalized.question;
    dream.claim = normalized.claim;
    dream.worldFacing = normalized.worldFacing;
    dream.lastTranslatedAt = now.toISOString();
    kept.push(dream);
  }

  memories.dreams = kept.slice(-MAX_DREAM_MEMORIES);
}

function isStableSemanticMemory(memory) {
  const label = readString(memory, "subjectLabel") ?? "";
  const summary = readString(memory, "summary") ?? "";
  const targetKind = readString(memory, "targetKind") ?? "";
  const question = readString(memory, "question") ?? "";
  const claim = readString(memory, "claim") ?? "";

  if (!label || !summary || hasThoughtSurfaceTemplateSmell(summary)) {
    return false;
  }
  if (looksKeywordSalad(label) || looksPersonLikeSingleton(label)) {
    return false;
  }
  if (targetKind === "repo" && extractRepoNameFromLabel(label)) {
    return true;
  }
  if (targetKind === "self" && /compression|continuity|receipt|dream/i.test(`${label} ${summary}`)) {
    return true;
  }
  return normalizeText(question).length > 0 && normalizeText(claim).length > 0;
}

function isStableDreamMemory(dream) {
  const theme = readString(dream, "theme") ?? "";
  const summary = readString(dream, "summary") ?? "";
  if (!theme || !summary || hasThoughtSurfaceTemplateSmell(summary)) {
    return false;
  }
  if (looksKeywordSalad(theme) || looksPersonLikeSingleton(theme)) {
    return false;
  }
  return true;
}

function translateLegacyThoughtLikeEntry({
  label,
  summary,
  fallbackTargetKind,
  fallbackFocusKind,
  evidenceRefs,
  repoNames,
}) {
  const rawLabel = normalizeText(label);
  const rawSummary = normalizeText(summary);
  if (!rawLabel && !rawSummary) {
    return null;
  }

  const preferredLabel = sanitizePreferredThoughtLabel(rawLabel);

  const sourceKinds = inferSourceKindsFromThoughtText(rawSummary, rawLabel, evidenceRefs);
  const synthesized = synthesizeThoughtSurface({
    sourceKinds,
    repoNames,
    archiveYears: [],
    channelIds: [],
    keywords: topConceptKeywords(`${rawLabel} ${rawSummary}`, 6),
    evidenceDiversity: inferLegacyEvidenceDiversity(sourceKinds, evidenceRefs, repoNames),
    curiosityProfile: buildClusterCuriosityProfile({
      sourceKinds,
      repoNames,
      archiveYears: [],
      channelIds: [],
      evidenceRefs,
      evidenceDiversity: inferLegacyEvidenceDiversity(sourceKinds, evidenceRefs, repoNames),
    }),
  });
  const preferredFocusPhrase = preferredLabel ? normalizeText(preferredLabel).toLowerCase() : synthesized.focusPhrase;
  const stabilized = {
    ...synthesized,
    label: preferredLabel ?? synthesized.label,
    focusPhrase: preferredFocusPhrase,
    fascinationTarget: preferredFocusPhrase,
  };

  if (!looksLegacyThoughtSurface(rawLabel, rawSummary)) {
    return {
      ...stabilized,
      label: preferredLabel ?? rawLabel ?? stabilized.label,
      summary: rewriteLegacySummaryToModernShape({
        summary: rawSummary,
        synthesized: stabilized,
        fallbackFocusKind,
        fallbackTargetKind,
      }),
    };
  }

  return {
    ...stabilized,
    focusKind: stabilized.focusKind ?? fallbackFocusKind,
    targetKind: stabilized.targetKind ?? fallbackTargetKind,
    summary: rewriteLegacySummaryToModernShape({
      summary: rawSummary,
      synthesized: stabilized,
      fallbackFocusKind,
      fallbackTargetKind,
    }),
  };
}

function choosePreferredThoughtLabel(entry) {
  return (
    sanitizePreferredThoughtLabel(readString(entry, "subjectLabel") ?? "") ??
    sanitizePreferredThoughtLabel(readString(entry, "subjectId") ?? "") ??
    null
  );
}

function choosePreferredDreamTheme(entry) {
  return sanitizePreferredThoughtLabel(readString(entry, "theme") ?? "") ?? null;
}

function rewriteLegacySummaryToModernShape({ summary, synthesized, fallbackFocusKind, fallbackTargetKind }) {
  const cleanSummary = normalizeText(summary)
    .replace(/^Recurring seam across .*?\.\s*/i, "")
    .replace(/^Dream-compressed a seam around .*?\.\s*/i, "")
    .replace(/^Self-facing seam around .*?\.\s*/i, "")
    .replace(/^Archive-facing seam around .*?\.\s*/i, "")
    .replace(/^Fascination with .*?\.\s*/i, "")
    .replace(/Built from .*? rather than a single lane talking to itself\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const focusKind = synthesized.focusKind ?? fallbackFocusKind;
  const targetKind = synthesized.targetKind ?? fallbackTargetKind;

  if (cleanSummary && !hasThoughtSurfaceTemplateSmell(cleanSummary)) {
    return cleanSummary;
  }

  return buildConciseThoughtSummary({ focusKind, targetKind, synthesized });
}

function inferSourceKindsFromThoughtText(summary, label, evidenceRefs) {
  const kinds = new Set();
  const text = `${label} ${summary}`.toLowerCase();
  const refKinds = evidenceRefs.map((ref) => inferSourceKindFromRef(ref)).filter(Boolean);
  for (const kind of refKinds) {
    kinds.add(kind);
  }
  const acrossMatch = summary.match(/Recurring seam across ([^.]+?) around/i);
  if (acrossMatch) {
    for (const part of acrossMatch[1].split(",")) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) {
        kinds.add(trimmed);
      }
    }
  }
  if (text.includes("dream")) {
    kinds.add("dream");
  }
  if (text.includes("semantic")) {
    kinds.add("semantic");
  }
  if (text.includes("archive")) {
    kinds.add("archive_excursion");
  }
  if (text.includes("repo")) {
    kinds.add("repo_sweep");
  }
  return [...kinds].filter(Boolean);
}

function inferSourceKindFromRef(ref) {
  const normalized = String(ref ?? "");
  if (normalized.startsWith("repo-sweep-")) {
    return "repo_sweep";
  }
  if (normalized.startsWith("archive-excursion-")) {
    return "archive_excursion";
  }
  if (normalized.startsWith("dream-")) {
    return "dream";
  }
  if (normalized.startsWith("musing-")) {
    return "musing";
  }
  if (normalized.startsWith("semantic-") || normalized.startsWith("semantic-seam-")) {
    return "semantic";
  }
  if (normalized.startsWith("episodic-")) {
    return "episodic";
  }
  return undefined;
}

function inferLegacyEvidenceDiversity(sourceKinds, evidenceRefs, repoNames) {
  return clamp(
    Math.min(1, sourceKinds.length / 4) * 0.42 +
      Math.min(1, evidenceRefs.length / 10) * 0.28 +
      Math.min(1, repoNames.length / 2) * 0.2,
    0,
    1,
  );
}

export function buildConciseThoughtSummary({ focusKind, targetKind, synthesized }) {
  const focus = capitalizePhrase(synthesized.focusPhrase);
  const repoTarget = capitalizePhrase(synthesized.fascinationTarget ?? synthesized.focusPhrase);
  if (focusKind === "fascination" && targetKind === "repo") {
    return `${repoTarget} keeps pulling as a concrete repo seam.`;
  }
  if (targetKind === "archive") {
    return `${focus} keeps showing up in the archive strongly enough to deserve a cleaner read.`;
  }
  if (targetKind === "self") {
    return `${focus} keeps surviving compression as a self-seam.`;
  }
  if (focusKind === "claim") {
    return `${focus} has hardened into a concrete claim.`;
  }
  return `${focus} remains unresolved enough to deserve a cleaner read.`;
}

export function buildDreamSummary(normalized) {
  const focus = capitalizePhrase(normalized.focusPhrase ?? normalized.label ?? "this seam");
  if ((normalized.targetKind ?? "") === "archive") {
    return `Dream residue around ${focus} from older archive pressure.`;
  }
  if ((normalized.targetKind ?? "") === "self") {
    return `Dream residue around ${focus} as a self-seam.`;
  }
  return `Dream residue around ${focus}.`;
}

function dedupeSemanticMemories({ memories }) {
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

function dedupeDreamMemories({ memories }) {
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

function pruneHistoricalSeamMemories({ memories }) {
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

function shouldPurgeThoughtLikeMemory({ entry, normalized, preferredLabel }) {
  const rawSummary = readString(entry, "summary") ?? "";
  const rawQuestion = readString(entry, "question") ?? "";
  const rawClaim = readString(entry, "claim") ?? "";
  const label =
    preferredLabel ??
    readString(entry, "subjectLabel") ??
    readString(entry, "theme") ??
    normalized.label ??
    "";

  if (!hasThoughtSurfaceTemplateSmell(rawSummary) && !hasThoughtSurfaceTemplateSmell(rawQuestion)) {
    return false;
  }

  if (sanitizePreferredThoughtLabel(label)) {
    return false;
  }

  if (normalizeText(rawClaim).length > 0 && !hasThoughtSurfaceTemplateSmell(rawClaim)) {
    return false;
  }

  return true;
}

function shouldDropSemanticMemory(entry) {
  const kind = readString(entry, "kind") ?? "";
  const label = readString(entry, "subjectLabel") ?? readString(entry, "theme") ?? "";
  const summary = readString(entry, "summary") ?? "";
  const targetKind = readString(entry, "targetKind") ?? "";
  const focusKind = readString(entry, "focusKind") ?? "";

  if (kind === "identity_seam") {
    return false;
  }

  if (kind === "recent-preoccupation" || kind === "quiet-room-status") {
    return true;
  }

  if (looksPersonLikeSingleton(label)) {
    return true;
  }

  if (targetKind === "system" && focusKind === "question" && !/repo|archive|lore|room|self/i.test(summary)) {
    return true;
  }

  if (hasThoughtSurfaceTemplateSmell(summary)) {
    return true;
  }

  return false;
}

function hasThoughtSurfaceTemplateSmell(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("what does the current room need from it") ||
    normalized.includes("if it had to change a real machine") ||
    normalized.includes("keeps returning with enough structure to deserve another honest pass") ||
    normalized.includes("still matters. what would") ||
    normalized.includes("looks like a live seam") ||
    normalized.includes("live seam around") ||
    normalized.includes("looks like a live claim") ||
    normalized.includes("looks like a live question") ||
    normalized.includes("archive-facing seam around") ||
    normalized.includes("self-facing seam around") ||
    normalized.includes("dream-compressed a seam around")
  );
}

function pruneDreamMemories({ memories }) {
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
