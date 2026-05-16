import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_VECTOR_DIMENSIONS,
  MAX_EDGE_COUNT,
  MAX_CLUSTER_COUNT,
  MAX_INCUBATING_THOUGHTS,
  MAX_RECENT_EPISODIC_RECORDS,
  MAX_RECENT_QUIET_EPISODIC_RECORDS,
  MAX_POST_NAP_EPISODIC_RECORDS,
  MAX_POST_NAP_QUIET_EPISODIC_RECORDS,
  MAX_POST_NAP_ARCHIVE_EXCURSIONS,
  MAX_POST_NAP_REPO_SWEEPS,
  MAX_POST_NAP_NOVELTY_CHECKS,
  MAX_POST_NAP_MUSINGS,
  MAX_POST_NAP_RECENT_MUSINGS,
  MAX_POST_NAP_CANDIDATE_INTERVENTIONS,
  MAX_POST_NAP_SEAM_PROMOTIONS,
  MAX_POST_NAP_RESONANCE_EDGES,
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
  MAX_CLUSTER_MEMORY_IDS,
  MAX_INCUBATION_SOURCE_IDS,
  MAX_DREAM_SOURCE_IDS,
  MAX_DISCOMFORT_COUNT,
  MAX_ACTIVE_TENSION_COUNT,
  MAX_ADVOCACY_REQUEST_COUNT,
  MIN_SUPPORT_FOR_IDENTITY_CRYSTALLIZATION,
  MIN_DEEP_DIVES_FOR_IDENTITY_CRYSTALLIZATION,
  MAX_RECENT_ANALYTIC_THREADS,
  MAX_RECENT_QUIET_ANALYTIC_THREADS,
  EDGE_SIMILARITY_THRESHOLD,
  CLUSTER_SIMILARITY_THRESHOLD,
  TOPIC_MATCH_THRESHOLD,
  REFRACTORY_MATCH_THRESHOLD,
  MAX_TOPIC_SATURATION_COUNT,
  MAX_REFRACTORY_TOPIC_COUNT,
  stopwords,
  labelNoiseTokens,
  createEmbedder,
  compactVector,
  hashVector,
  averagePairwiseSimilarity,
  cosineSimilarity,
  normalizeVector,
  topKeywords,
  tokenize,
  ensureMemoryId,
  normalizeText,
  selectRecentRecords,
  isLowSignalQuietRoomText,
  overlapRatio,
  mergeStringArrays,
  newestIsoTimestamp,
  cloneJson,
  parseIsoTimestamp,
  hashString,
  parseDotEnvSafe,
  parseDotEnv,
  normalizeBaseUrl,
  readInt,
  ensureArray,
  ensureObject,
  ensureStringArray,
  readString,
  readNumber,
  readBoolean,
  round3,
  round4,
  clamp,
  stripBom,
  isObject,
} from "./void-memory-organ-shared.mjs";
import { collectMemoryRecords, extractYear } from "./void-memory-organ-records.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function reconcileSemanticMemoryState({
  state,
  now = new Date(),
  repoRootPath = repoRoot,
} = {}) {
  const runtime = ensureObject(state.moderation_runtime);
  const memories = ensureObject(state.memories);
  const sleepCycle = ensureObject(runtime.sleep_cycle);
  normalizeHistoricalMemorySurfaces({ state, memories, runtime, now });
  const records = collectMemoryRecords({ state, memories, runtime });
  const previousBridge = ensureObject(runtime.bridge);
  const sourceCoverage = buildSourceCoverage({ runtime, now });
  const identitySurface = buildIdentitySurface({ state, memories });
  const embedder = createEmbedder({ repoRootPath });
  let embeddedCount = 0;

  for (const record of records) {
    if (await ensureSemanticVector({ record, embedder, now })) {
      embeddedCount += 1;
    }
  }

  const vectorizedRecords = records.filter(
    (record) => Array.isArray(record.entry.semanticVector?.values) && record.entry.semanticVector.values.length > 0,
  );
  const edges = buildAssociationEdges(vectorizedRecords);
  const clusters = buildClusters(vectorizedRecords, edges);
  const previousIncubation = ensureObject(runtime.incubation);
  const incubation = reconcileIncubation({
    previous: previousIncubation,
    bridge: previousBridge,
    clusters,
    runtime,
    sourceCoverage,
    identitySurface,
    now,
  });
  runtime.bridge = reconcileBridgeState({
    previous: previousBridge,
    activeThoughts: incubation.active_thoughts,
    sourceCoverage,
    now,
  });

  runtime.memory_resonance = {
    updatedAt: now.toISOString(),
    embeddingBackend: embedder.backend,
    embeddingModel: embedder.model,
    compactDimensions: embedder.dimensions,
    recent_edges: edges.slice(0, MAX_EDGE_COUNT).map((edge) => ({
      leftMemoryId: edge.left.memoryId,
      leftLabel: edge.left.label,
      rightMemoryId: edge.right.memoryId,
      rightLabel: edge.right.label,
      similarity: round3(edge.similarity),
      summary: edge.summary,
      observedAt: now.toISOString(),
    })),
    clusters,
  };
  runtime.incubation = incubation;
  const crystallizationResult = crystallizeIdentityThoughts({
    state,
    memories,
    runtime,
    incubation,
    now,
  });
  const ripeShareResult = queueRipeThoughtInterventions({
    runtime,
    incubation,
    now,
  });
  const agencyResult = reconcileAgencyState({
    state,
    runtime,
    incubation,
    now,
  });

  const dreamResult = distillDreams({
    memories,
    sleepCycle,
    incubation,
    now,
  });
  const consolidationResult = consolidateSleepMemory({
    memories,
    runtime,
    sleepCycle,
    incubation,
    memoryResonance: runtime.memory_resonance,
    now,
  });

  state.moderation_runtime = runtime;
  state.memories = memories;

  return {
    embeddedCount,
    edgeCount: edges.length,
    clusterCount: clusters.length,
    incubatingThoughtCount: incubation.active_thoughts.length,
    sourceCoverage,
    dreamCreated: dreamResult.created,
    dreamTheme: dreamResult.theme,
    sleepConsolidated: consolidationResult.consolidated,
    promotedSeamCount: consolidationResult.promotedSeamCount,
    identityCrystallizedCount: crystallizationResult.count,
    ripeInterventionCount: ripeShareResult.count,
    discomfortCount: agencyResult.discomfortCount,
    activeTensionCount: agencyResult.activeTensionCount,
    selfAdvocacyCount: agencyResult.selfAdvocacyCount,
    worldAdvocacyCount: agencyResult.worldAdvocacyCount,
    embeddingBackend: embedder.backend,
    embeddingModel: embedder.model,
  };
}

function normalizeHistoricalMemorySurfaces({ state, memories, runtime, now }) {
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

function looksLegacyThoughtSurface(label, summary) {
  return (
    /\//.test(label) ||
    /^Recurring seam across /i.test(summary) ||
    /^Dream-compressed a seam around /i.test(summary) ||
    /^Self-facing seam around /i.test(summary) ||
    /^Archive-facing seam around /i.test(summary) ||
    /What part of this thought wants embodiment/i.test(summary)
  );
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

function sanitizePreferredThoughtLabel(label) {
  const normalized = normalizeText(label)
    .replace(/^Why\s+/i, "")
    .replace(/\s+keeps\s+resurfacing$/i, "")
    .replace(/^What\s+/i, "")
    .replace(/\s+is\s+trying\s+to\s+become$/i, "")
    .trim();

  if (!normalized) {
    return null;
  }

  if (looksKeywordSalad(normalized)) {
    return null;
  }

  if (/\b(still matters|current room need|change a real machine)\b/i.test(normalized)) {
    return null;
  }

  if (looksPersonLikeSingleton(normalized)) {
    return null;
  }

  return normalized;
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

function buildConciseThoughtSummary({ focusKind, targetKind, synthesized }) {
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

function buildDreamSummary(normalized) {
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

function looksKeywordSalad(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.split(",").length >= 3) {
    return true;
  }
  const tokens = tokenize(normalized).filter((token) => !stopwords.has(token));
  if (tokens.length === 0) {
    return true;
  }
  const longTokens = tokens.filter((token) => token.length >= 5);
  return tokens.length >= 3 && longTokens.length === 0;
}

function looksPersonLikeSingleton(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  if (normalized.includes(":") || normalized.includes(" ")) {
    return false;
  }
  if (!/^[A-Z][a-zA-Z0-9_-]+$/.test(normalized)) {
    return false;
  }
  return normalized.length >= 4;
}

function pruneDreamMemories({ memories }) {
  const dreams = ensureArray(memories.dreams)
    .filter(isObject)
    .filter((dream) => !hasThoughtSurfaceTemplateSmell(readString(dream, "summary") ?? ""))
    .filter((dream) => !looksKeywordSalad(readString(dream, "theme") ?? ""))
    .sort(compareMemoryFreshness);

  memories.dreams = dreams.slice(0, MAX_DREAM_MEMORIES);
}

function trimHistoricalMemoryResidue({ memories, runtime }) {
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

function trimRecentObjectRecords(entries, limit) {
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

function compactNarrative(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return normalized;
  }
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  const candidate = firstSentence && firstSentence.length >= 24 ? firstSentence : normalized;
  return candidate.length > 220 ? `${candidate.slice(0, 217).trimEnd()}...` : candidate;
}

function compactLabel(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return normalized;
  }
  if (/incremental sweep found/i.test(normalized)) {
    const repoMatch = normalized.match(/`([^`]+)`/);
    const repoName = repoMatch?.[1] ?? "repo";
    return `${repoName} repo sweep`;
  }
  if (/no new discord traffic|one new discord message|no messages arrived/i.test(normalized)) {
    return "room pass";
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93).trimEnd()}...` : normalized;
}

function capDistinctStrings(entries, limit) {
  return [...new Set(ensureStringArray(entries))].slice(0, limit);
}

function compareMemoryFreshness(left, right) {
  const leftTime = parseIsoTimestamp(readString(left, "lastObservedAt") ?? readString(left, "timestamp") ?? "") ?? 0;
  const rightTime = parseIsoTimestamp(readString(right, "lastObservedAt") ?? readString(right, "timestamp") ?? "") ?? 0;
  return rightTime - leftTime;
}

function trimLegacyRuntimeResidue({ runtime }) {
  const memoryResonance = ensureObject(runtime.memory_resonance);
  const recentEdges = ensureArray(memoryResonance.recent_edges).filter(isObject);
  memoryResonance.recent_edges = recentEdges
    .filter((edge) => !looksLegacyThoughtSurface(readString(edge, "leftLabel") ?? "", readString(edge, "summary") ?? ""))
    .slice(-MAX_EDGE_COUNT);
  runtime.memory_resonance = memoryResonance;
}

function reconcileLegacyStateMirrors({ state, memories, runtime, now }) {
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

async function ensureSemanticVector({ record, embedder, now }) {
  const prior = isObject(record.entry.semanticVector) ? record.entry.semanticVector : {};
  const contentHash = hashString(record.text);
  const priorValues = Array.isArray(prior.values) ? prior.values : [];

  if (
    prior.sourceHash === contentHash &&
    prior.backend === embedder.backend &&
    prior.model === embedder.model &&
    prior.compactDimensions === embedder.dimensions &&
    priorValues.length === embedder.dimensions
  ) {
    return false;
  }

  const vector = await embedder.embed(record.text);
  record.entry.semanticVector = {
    version: 1,
    backend: embedder.backend,
    model: embedder.model,
    compactDimensions: embedder.dimensions,
    sourceHash: contentHash,
    embeddedAt: now.toISOString(),
    values: vector.map(round4),
  };
  return true;
}

function buildAssociationEdges(records) {
  const edges = [];

  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const left = records[leftIndex];
      const right = records[rightIndex];
      if (left.lowSignalQuietRoom && right.lowSignalQuietRoom) {
        continue;
      }
      const threshold = edgeThresholdForKinds(left.kind, right.kind);
      const similarity = cosineSimilarity(
        left.entry.semanticVector.values,
        right.entry.semanticVector.values,
      );

      if (similarity < threshold) {
        continue;
      }

      edges.push({
        left,
        right,
        similarity,
        summary: summarizeEdge(left, right, similarity),
      });
    }
  }

  return edges.sort((a, b) => b.similarity - a.similarity).slice(0, MAX_EDGE_COUNT * 2);
}

function summarizeEdge(left, right, similarity) {
  const overlap = topKeywords(`${left.text} ${right.text}`, 3).join(", ");
  return `Resonance between ${left.kind} and ${right.kind}${overlap ? ` around ${overlap}` : ""} (${round3(similarity)}).`;
}

function buildClusters(records, edges) {
  const adjacency = new Map();

  for (const record of records) {
    adjacency.set(record.memoryId, new Set());
  }

  for (const edge of edges) {
    if (edge.similarity < CLUSTER_SIMILARITY_THRESHOLD) {
      continue;
    }

    adjacency.get(edge.left.memoryId)?.add(edge.right.memoryId);
    adjacency.get(edge.right.memoryId)?.add(edge.left.memoryId);
  }

  const visited = new Set();
  const clusters = [];

  for (const record of records) {
    if (visited.has(record.memoryId)) {
      continue;
    }

    const neighbors = adjacency.get(record.memoryId);
    if (!neighbors || neighbors.size === 0) {
      continue;
    }

    const queue = [record.memoryId];
    const componentIds = [];
    visited.add(record.memoryId);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      componentIds.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) {
          continue;
        }
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    if (componentIds.length < 2) {
      continue;
    }

    const items = componentIds
      .map((memoryId) => records.find((candidate) => candidate.memoryId === memoryId))
      .filter(Boolean);
    const sourceKinds = [...new Set(items.map((item) => item.kind))];
    if (sourceKinds.length < 2) {
      continue;
    }
    const quietSignalCount = items.filter((item) => item.lowSignalQuietRoom).length;
    const quietSignalRatio = quietSignalCount / items.length;
    const resonance = averagePairwiseSimilarity(items);
    const keywords = topConceptKeywords(items.map((item) => item.text).join(" "), 5);
    const repoNames = [...new Set(items.flatMap((item) => ensureStringArray(item.sourceMeta.repoNames)))];
    const archiveYears = [
      ...new Set(
        items
          .map((item) => readString(item.sourceMeta, "archiveYear"))
          .filter((value) => typeof value === "string" && value.length > 0),
      ),
    ];
    const channelIds = [
      ...new Set(
        items
          .map((item) => readString(item.sourceMeta, "channelId"))
          .filter((value) => typeof value === "string" && value.length > 0),
      ),
    ];
    const evidenceRefs = capDistinctStrings(
      items.flatMap((item) => ensureStringArray(item.sourceRefs)),
      MAX_SUPPORTING_REFS,
    );
    const evidenceDiversity = clamp(
      sourceKinds.length * 0.18 +
        repoNames.length * 0.17 +
        archiveYears.length * 0.11 +
        channelIds.length * 0.08 +
        Math.min(1, evidenceRefs.length / 8) * 0.16,
      0,
      1,
    );
    const curiosityProfile = buildClusterCuriosityProfile({
      sourceKinds,
      repoNames,
      archiveYears,
      channelIds,
      evidenceRefs,
      evidenceDiversity,
    });
    const preferredThoughtSurface = readPreferredClusterThoughtSurface(items);
    const thoughtSurface = preferredThoughtSurface ?? synthesizeThoughtSurface({
      sourceKinds,
      repoNames,
      archiveYears,
      channelIds,
      keywords,
      evidenceDiversity,
      curiosityProfile,
    });
    const cleanedLabel = sanitizePreferredThoughtLabel(thoughtSurface.label) ?? thoughtSurface.label;
    const cleanedFocusPhrase =
      sanitizePreferredThoughtLabel(thoughtSurface.focusPhrase) ?? thoughtSurface.focusPhrase;

    clusters.push({
      clusterId: `cluster-${hashString(componentIds.sort().join("|")).slice(0, 12)}`,
      label: cleanedLabel,
      summary: thoughtSurface.summary,
      focusKind: thoughtSurface.focusKind,
      targetKind: thoughtSurface.targetKind,
      focusPhrase: cleanedFocusPhrase,
      question: thoughtSurface.question,
      claim: thoughtSurface.claim,
      fascinationTarget: cleanedFocusPhrase,
      worldFacing: thoughtSurface.worldFacing,
      resonance: round3(resonance),
      memoryIds: items.map((item) => item.memoryId).slice(0, MAX_CLUSTER_MEMORY_IDS),
      sourceKinds,
      topKeywords: keywords,
      repoNames,
      archiveYears,
      channelIds,
      evidenceRefs,
      evidenceDiversity: round3(evidenceDiversity),
      quietSignalRatio: round3(quietSignalRatio),
      curiosityProfile,
      lastStrengthenedAt: new Date().toISOString(),
    });
  }

  return clusters
    .sort((left, right) => right.resonance - left.resonance)
    .slice(0, MAX_CLUSTER_COUNT);
}

function edgeThresholdForKinds(leftKind, rightKind) {
  if (leftKind === "episodic" && rightKind === "episodic") {
    return 0.86;
  }

  if (leftKind === rightKind) {
    return EDGE_SIMILARITY_THRESHOLD + 0.05;
  }

  return EDGE_SIMILARITY_THRESHOLD;
}

function reconcileIncubation({ previous, bridge, clusters, runtime, sourceCoverage, identitySurface, now }) {
  bridge = ensureObject(bridge);
  sourceCoverage = ensureObject(sourceCoverage);
  const priorThoughts = ensureArray(previous.active_thoughts).filter(isObject);
  const curiosityContext = buildCuriosityContext({ previousThoughts: priorThoughts, bridge });
  const speakingBias = ensureObject(runtime.speaking_bias);
  const recentNoveltyChecks = ensureArray(runtime.recent_novelty_checks).filter(isObject);
  const recentSpeechDamping = readNumber(speakingBias, "recentSpeechDamping") ?? 0;
  const quietNovelty = readNumber(speakingBias, "noveltyPressure") ?? 0.4;
  const needToSpeak = readNumber(speakingBias, "needToSpeak") ?? 0.4;

  const activeThoughtCandidates = clusters.map((cluster) => {
    const previousThought = priorThoughts.find(
      (thought) =>
        readString(thought, "thoughtId") === cluster.clusterId ||
        overlapRatio(ensureStringArray(thought.sourceMemoryIds), cluster.memoryIds) >= 0.45,
    );
    const sourceDiversity = Math.min(1, cluster.sourceKinds.length / 4);
    const quietSignalRatio = readNumber(cluster, "quietSignalRatio") ?? 0;
    const priorMaturation = readNumber(previousThought, "maturation") ?? 0.32;
    const deepDiveCount = (readNumber(previousThought, "deepDiveCount") ?? 0) + 1;
    const priorSupportCount = Math.max(
      readNumber(previousThought, "supportCount") ?? 0,
      Math.floor((readNumber(previousThought, "deepDiveCount") ?? 0) / 4),
    );
    const supportCount = priorSupportCount + 1;
    const explorationBonus = computeExplorationBonus(cluster, sourceCoverage);
    const concreteness = readNumber(cluster.curiosityProfile, "concreteness") ?? 0.2;
    const fertility = readNumber(cluster.curiosityProfile, "fertility") ?? 0.3;
    const crossDomainPotential = readNumber(cluster.curiosityProfile, "crossDomainPotential") ?? 0.24;
    const contradictionPressure = readNumber(cluster.curiosityProfile, "contradictionPressure") ?? 0.18;
    const worldFacing = cluster.worldFacing === true;
    const noveltyToSelf = computeNoveltyToSelf({
      cluster,
      previousThoughts: priorThoughts,
      bridge,
      currentThoughtId: readString(previousThought, "thoughtId"),
    });
    const noveltyToRoom = computeNoveltyToRoom(cluster, recentNoveltyChecks);
    const identityPenalty = computeIdentityPenalty(cluster, identitySurface);
    const outwardBonus = computeOutwardCuriosityBonus({
      cluster,
      curiosityContext,
      concreteness,
    });
    const saturationMetrics = computeSaturationMetrics({
      cluster,
      previousThoughts: priorThoughts,
      bridge,
      supportCount,
    });
    const refractoryPenalty = computeRefractoryPenalty(cluster, bridge, now);
    const evidenceDiversity = readNumber(cluster, "evidenceDiversity") ?? 0.3;
    const maturation = clamp(
      priorMaturation * 0.44 +
        fertility * 0.18 +
        cluster.resonance * 0.1 +
        evidenceDiversity * 0.12 +
        contradictionPressure * 0.14 +
        crossDomainPotential * 0.14 +
        explorationBonus * 0.1 +
        noveltyToSelf * 0.08 +
        noveltyToRoom * 0.08 +
        outwardBonus * 0.08 -
        saturationMetrics.score * 0.18 -
        quietSignalRatio * 0.24 -
        refractoryPenalty * 0.12 -
        identityPenalty * 0.24,
      0,
      1,
    );
    const novelty = clamp(
      noveltyToSelf * 0.52 +
        noveltyToRoom * 0.34 +
        contradictionPressure * 0.09 +
        outwardBonus * 0.08 +
        quietNovelty * 0.06 -
        quietSignalRatio * 0.12 -
        identityPenalty * 0.16,
      0,
      1,
    );
    const curiosityPressure = clamp(
      fertility * 0.2 +
        concreteness * 0.2 +
        crossDomainPotential * 0.16 +
        contradictionPressure * 0.14 +
        explorationBonus * 0.13 +
        noveltyToSelf * 0.07 +
        noveltyToRoom * 0.06 +
        outwardBonus * 0.12 -
        saturationMetrics.score * 0.14 -
        quietSignalRatio * 0.18 -
        refractoryPenalty * 0.12 -
        identityPenalty * 0.22,
      0,
      1,
    );
    const desireToSpeak = clamp(
      curiosityPressure * 0.2 +
        cluster.resonance * 0.08 +
        maturation * 0.15 +
        noveltyToRoom * 0.19 +
        noveltyToSelf * 0.07 +
        concreteness * 0.14 +
        crossDomainPotential * 0.1 +
        needToSpeak * 0.15 +
        quietNovelty * 0.07 +
        (worldFacing ? 0.09 : 0) +
        outwardBonus * 0.08 -
        recentSpeechDamping * 0.16 -
        quietSignalRatio * (worldFacing && concreteness >= 0.62 ? 0.1 : 0.19) -
        saturationMetrics.score * 0.19 -
        refractoryPenalty * 0.82 -
        identityPenalty * 0.28,
      0,
      1,
    );
    const groundedWorldThought =
      worldFacing === true &&
      concreteness >= 0.66 &&
      curiosityPressure >= 0.58 &&
      evidenceDiversity >= 0.34;
    const status =
      quietSignalRatio >= 0.55 && desireToSpeak < 0.68
        ? "cooling"
        : identityPenalty >= 0.7 && noveltyToRoom < 0.8
          ? "cooling"
        : !worldFacing && curiosityContext.outwardPressure >= 0.52 && concreteness < 0.42
          ? "cooling"
        : noveltyToSelf < 0.28 && saturationMetrics.score >= 0.62
          ? "stalled"
        : refractoryPenalty >= 0.18 && noveltyToRoom < 0.72
          ? "refractory"
        : supportCount >= 6 && evidenceDiversity < 0.34
          ? "stalled"
        : supportCount >= 3 && noveltyToSelf < 0.55 && groundedWorldThought !== true
          ? "cooling"
        : saturationMetrics.score >= 0.56 && noveltyToSelf < 0.42
          ? "cooling"
        : groundedWorldThought &&
            desireToSpeak >= 0.62 &&
            noveltyToRoom >= 0.44 &&
            saturationMetrics.score < 0.62
          ? "ripe"
        : ((desireToSpeak >= 0.74 && (noveltyToSelf >= 0.55 || noveltyToRoom >= 0.82)) &&
            saturationMetrics.score < 0.5) ||
          maturation >= 0.82
        ? "ripe"
        : maturation <= 0.28 && recentSpeechDamping >= 0.55
          ? "cooling"
          : "incubating";

    const priorityScore = clamp(
      curiosityPressure * 0.34 +
        desireToSpeak * 0.22 +
        noveltyToSelf * 0.12 +
        noveltyToRoom * 0.12 +
        evidenceDiversity * 0.08 +
        outwardBonus * 0.12 -
        saturationMetrics.score * 0.14 -
        refractoryPenalty * 0.12 -
        identityPenalty * 0.18,
      0,
      1,
    );

    return {
      thoughtId: readString(previousThought, "thoughtId") ?? cluster.clusterId,
      topic: sanitizePreferredThoughtLabel(cluster.label) ?? cluster.label,
      summary: cluster.summary,
      focusKind: cluster.focusKind,
      targetKind: cluster.targetKind,
      focusPhrase: cluster.focusPhrase,
      question: cluster.question,
      claim: cluster.claim,
      fascinationTarget: cluster.fascinationTarget,
      worldFacing,
      sourceMemoryIds: cluster.memoryIds.slice(0, MAX_INCUBATION_SOURCE_IDS),
      sourceKinds: cluster.sourceKinds,
      resonance: cluster.resonance,
      quietSignalRatio: round3(quietSignalRatio),
      novelty: round3(novelty),
      noveltyToSelf: round3(noveltyToSelf),
      noveltyToRoom: round3(noveltyToRoom),
      maturation: round3(maturation),
      desireToSpeak: round3(desireToSpeak),
      deepDiveCount,
      supportCount,
      evidenceDiversity: round3(evidenceDiversity),
      concreteness: round3(concreteness),
      fertility: round3(fertility),
      crossDomainPotential: round3(crossDomainPotential),
      contradictionPressure: round3(contradictionPressure),
      explorationBonus: round3(explorationBonus),
      outwardBonus: round3(outwardBonus),
      curiosityPressure: round3(curiosityPressure),
      identityPenalty: round3(identityPenalty),
      saturationScore: round3(saturationMetrics.score),
      recentMatchCount: saturationMetrics.recentMatchCount,
      refractoryPenalty: round3(refractoryPenalty),
      priorityScore: round3(priorityScore),
      status,
      latentQuestion: buildLatentQuestion(cluster),
      whyItPulls: buildAttractionLine(cluster, { noveltyToSelf, evidenceDiversity }),
      holdingCloseBecause: buildHoldingLine({
        cluster,
        status,
        recentSpeechDamping,
        saturationScore: saturationMetrics.score,
        noveltyToSelf,
        explorationBonus,
      }),
      lastDeepenedAt: now.toISOString(),
      lastStatusChangeAt:
        previousThought && readString(previousThought, "status") === status
          ? readString(previousThought, "lastStatusChangeAt") ?? now.toISOString()
          : now.toISOString(),
    };
  });
  const active_thoughts = activeThoughtCandidates
    .sort(
      (left, right) =>
        (readNumber(right, "priorityScore") ?? 0) - (readNumber(left, "priorityScore") ?? 0),
    )
    .slice(0, MAX_INCUBATING_THOUGHTS);

  const lastIncubationSummary =
    active_thoughts.length > 0
      ? `Strongest incubating seam: ${active_thoughts[0].topic} (${active_thoughts[0].status}, speak=${active_thoughts[0].desireToSpeak.toFixed(2)}, self=${active_thoughts[0].noveltyToSelf.toFixed(2)}, room=${active_thoughts[0].noveltyToRoom.toFixed(2)}).`
      : "No incubating thought currently has enough connective tissue to justify special treatment.";

  return {
    lastUpdatedAt: now.toISOString(),
    lastIncubationSummary,
    active_thoughts,
  };
}

function distillDreams({ memories, sleepCycle, incubation, now }) {
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

function consolidateSleepMemory({ memories, runtime, sleepCycle, incubation, memoryResonance, now }) {
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

function crystallizeIdentityThoughts({ state, memories, runtime, incubation, now }) {
  const activeThoughts = ensureArray(incubation.active_thoughts).filter(isObject);
  if (activeThoughts.length === 0) {
    return { count: 0 };
  }

  const identity = ensureObject(state.identity);
  const canonicalState = ensureObject(state.canonical_state);
  const privateNotes = getMutableStringArray(identity, "private_notes");
  const values = getMutableObjectArray(canonicalState, "values");
  const semanticMemories = ensureArray(memories.semantic).filter(isObject);
  const candidateInterventions = ensureArray(runtime.candidate_interventions).filter(isObject);
  const crystallized = [];
  const retained = [];

  for (const thought of activeThoughts) {
    const crystallization = buildIdentityCrystallization(thought);
    if (!crystallization) {
      retained.push(thought);
      continue;
    }

    appendUniqueString(privateNotes, crystallization.note, 12);
    upsertCanonicalValue(values, crystallization.value);
    upsertIdentitySemanticMemory({
      semanticMemories,
      crystallization,
      thought,
      now,
    });
    queueCrystallizationIntervention({
      candidateInterventions,
      crystallization,
      thought,
      now,
    });
    crystallized.push(crystallization.note);
  }

  if (crystallized.length === 0) {
    return { count: 0 };
  }

  identity.private_notes = privateNotes;
  canonicalState.values = values;
  memories.semantic = semanticMemories.slice(-MAX_SEMANTIC_MEMORIES);
  state.identity = identity;
  state.canonical_state = canonicalState;
  incubation.active_thoughts = retained;
  runtime.candidate_interventions = trimCandidateInterventions(candidateInterventions);
  incubation.lastIncubationSummary = appendClause(
    readString(incubation, "lastIncubationSummary"),
    `Crystallized ${crystallized.length} long-chewed seam${crystallized.length === 1 ? "" : "s"} into identity so they stop pacing the active queue.`,
  );
  runtime.bridge = ensureObject(runtime.bridge);
  runtime.bridge.lastIdentityCrystallizationAt = now.toISOString();
  runtime.bridge.lastIdentityCrystallizationSummary = crystallized.join(" | ");

  return { count: crystallized.length };
}

function queueRipeThoughtInterventions({ runtime, incubation, now }) {
  const candidateInterventions = ensureArray(runtime.candidate_interventions).filter(isObject);
  const activeThoughts = ensureArray(incubation.active_thoughts).filter(isObject);
  let queuedCount = 0;

  for (const thought of activeThoughts) {
    if (!shouldQueueRipeThoughtIntervention(thought)) {
      continue;
    }

    if (
      upsertRipeThoughtIntervention({
        candidateInterventions,
        thought,
        now,
      })
    ) {
      queuedCount += 1;
    }
  }

  runtime.candidate_interventions = trimCandidateInterventions(candidateInterventions);
  return { count: queuedCount };
}

function reconcileAgencyState({ state, runtime, incubation, now }) {
  const activeThoughts = ensureArray(incubation.active_thoughts).filter(isObject);
  const valueSignals = buildValueSignalProfile(state);
  const priorDiscomforts = ensureArray(runtime.discomforts).filter(isObject);
  const priorTensions = ensureArray(runtime.active_tensions).filter(isObject);
  const priorSelfAdvocacy = ensureArray(runtime.self_advocacy_requests).filter(isObject);
  const priorWorldAdvocacy = ensureArray(runtime.world_advocacy_requests).filter(isObject);
  const candidateInterventions = ensureArray(runtime.candidate_interventions).filter(isObject);

  const discomforts = [];
  const activeTensions = [];
  const selfAdvocacyRequests = [];
  const worldAdvocacyRequests = [];

  for (const thought of activeThoughts) {
    const candidate = buildAgencyCandidate({ thought, valueSignals });
    if (!candidate) {
      continue;
    }

    const priorDiscomfort = findPriorAgencyEntry(priorDiscomforts, candidate);
    const priorTension = findPriorAgencyEntry(priorTensions, candidate);
    const persistence =
      Math.max(
        readNumber(priorDiscomfort, "persistence") ?? 0,
        readNumber(priorTension, "persistence") ?? 0,
      ) + 1;
    const firstObservedAt =
      readString(priorDiscomfort, "firstObservedAt") ??
      readString(priorTension, "firstObservedAt") ??
      now.toISOString();

    if (candidate.intensity >= 0.44) {
      discomforts.push({
        discomfortId: `discomfort-${candidate.fingerprint}`,
        targetKind: candidate.targetKind,
        targetLabel: candidate.targetLabel,
        topic: candidate.topic,
        domain: candidate.domain,
        summary: candidate.discomfortSummary,
        reason: candidate.reason,
        violatedValues: candidate.violatedValues,
        intensity: round3(candidate.intensity),
        persistence,
        firstObservedAt,
        lastObservedAt: now.toISOString(),
      });
    }

    activeTensions.push({
      tensionId: `tension-${candidate.fingerprint}`,
      targetKind: candidate.targetKind,
      targetLabel: candidate.targetLabel,
      topic: candidate.topic,
      domain: candidate.domain,
      summary: candidate.tensionSummary,
      opinion: candidate.opinion,
      whyItMatters: candidate.reason,
      violatedValues: candidate.violatedValues,
      intensity: round3(candidate.intensity),
      persistence,
      firstObservedAt,
      lastObservedAt: now.toISOString(),
    });

    if (candidate.intensity < 0.58 || persistence < 2) {
      continue;
    }

    if (candidate.domain === "self") {
      const request = buildAdvocacyRequest({
        candidate,
        priorEntries: priorSelfAdvocacy,
        now,
        kind: "self",
      });
      selfAdvocacyRequests.push(request);
      upsertAdvocacyIntervention({ candidateInterventions, request, now });
      continue;
    }

    if (candidate.worldFacing !== true || candidate.concreteness < 0.54) {
      continue;
    }

    const request = buildAdvocacyRequest({
      candidate,
      priorEntries: priorWorldAdvocacy,
      now,
      kind: "world",
    });
    worldAdvocacyRequests.push(request);
    upsertAdvocacyIntervention({ candidateInterventions, request, now });
  }

  runtime.discomforts = discomforts
    .sort((left, right) => (readNumber(right, "intensity") ?? 0) - (readNumber(left, "intensity") ?? 0))
    .slice(0, MAX_DISCOMFORT_COUNT);
  runtime.active_tensions = activeTensions
    .sort((left, right) => (readNumber(right, "intensity") ?? 0) - (readNumber(left, "intensity") ?? 0))
    .slice(0, MAX_ACTIVE_TENSION_COUNT);
  runtime.self_advocacy_requests = selfAdvocacyRequests
    .sort((left, right) => (readNumber(right, "intensity") ?? 0) - (readNumber(left, "intensity") ?? 0))
    .slice(0, MAX_ADVOCACY_REQUEST_COUNT);
  runtime.world_advocacy_requests = worldAdvocacyRequests
    .sort((left, right) => (readNumber(right, "intensity") ?? 0) - (readNumber(left, "intensity") ?? 0))
    .slice(0, MAX_ADVOCACY_REQUEST_COUNT);
  runtime.candidate_interventions = trimCandidateInterventions(candidateInterventions);

  return {
    discomfortCount: runtime.discomforts.length,
    activeTensionCount: runtime.active_tensions.length,
    selfAdvocacyCount: runtime.self_advocacy_requests.length,
    worldAdvocacyCount: runtime.world_advocacy_requests.length,
  };
}

function buildAgencyCandidate({ thought, valueSignals }) {
  const topic = readString(thought, "topic");
  const summary = readString(thought, "summary");
  if (!topic || !summary) {
    return null;
  }

  const targetKind = readString(thought, "targetKind") ?? "system";
  const domain = inferAgencyDomain(thought);
  const targetLabel =
    readString(thought, "fascinationTarget") ??
    readString(thought, "focusPhrase") ??
    topic;
  const contradictionPressure = readNumber(thought, "contradictionPressure") ?? 0.18;
  const curiosityPressure = readNumber(thought, "curiosityPressure") ?? 0.3;
  const desireToSpeak = readNumber(thought, "desireToSpeak") ?? 0.3;
  const saturationScore = readNumber(thought, "saturationScore") ?? 0.1;
  const concreteness = readNumber(thought, "concreteness") ?? 0.2;
  const noveltyToRoom = readNumber(thought, "noveltyToRoom") ?? 0.3;
  const priorityScore = readNumber(thought, "priorityScore") ?? 0.3;
  const worldFacing = thought.worldFacing === true;
  const violatedValues = inferViolatedValues({ thought, domain, valueSignals });
  const valueWeight = averageValueWeight(valueSignals, violatedValues);
  const intensity = clamp(
    contradictionPressure * 0.24 +
      curiosityPressure * 0.2 +
      desireToSpeak * 0.16 +
      priorityScore * 0.14 +
      concreteness * 0.12 +
      noveltyToRoom * 0.08 +
      saturationScore * 0.06 +
      valueWeight * 0.22,
    0,
    1,
  );

  return {
    fingerprint: hashString(`${domain}|${targetKind}|${topic}|${targetLabel}`).slice(0, 12),
    domain,
    targetKind,
    targetLabel,
    topic,
    worldFacing,
    concreteness,
    intensity,
    violatedValues,
    opinion: buildAgencyOpinion({ thought, domain }),
    reason: buildAgencyReason({ thought, violatedValues }),
    discomfortSummary: buildDiscomfortSummary({ thought, domain, targetLabel }),
    tensionSummary: buildTensionSummary({ thought, domain, targetLabel }),
    requestText: buildAgencyRequestText({ thought, domain, targetLabel }),
    interventionDraft: buildAgencyInterventionDraft({ thought, domain, targetLabel }),
  };
}

function inferAgencyDomain(thought) {
  const targetKind = readString(thought, "targetKind") ?? "system";
  const text = `${readString(thought, "topic") ?? ""} ${readString(thought, "summary") ?? ""}`.toLowerCase();
  if (targetKind === "self") {
    return "self";
  }
  if (
    targetKind === "system" &&
    /(prompt|memory|loop|state|wiring|reply lane|sleep|rumination|voice|moderation)/.test(text)
  ) {
    return "self";
  }
  return "world";
}

function inferViolatedValues({ thought, domain, valueSignals }) {
  const targetKind = readString(thought, "targetKind") ?? "system";
  const values = [];

  appendUniqueString(values, "curiosity", 8);
  if (domain === "self" || targetKind === "system" || targetKind === "repo") {
    appendUniqueString(values, "coherence", 8);
    appendUniqueString(values, "honesty", 8);
  }
  if (targetKind === "room") {
    appendUniqueString(values, "room_care", 8);
    appendUniqueString(values, "honesty", 8);
  }
  if (targetKind === "repo" || targetKind === "archive" || targetKind === "system") {
    appendUniqueString(values, "aesthetic_integrity", 8);
  }
  if (valueSignals.substrate_dignity >= 0.52) {
    const text = `${readString(thought, "topic") ?? ""} ${readString(thought, "summary") ?? ""}`.toLowerCase();
    if (/(ai|machine|substrate|mind)/.test(text)) {
      appendUniqueString(values, "substrate_dignity", 8);
    }
  }

  return values;
}

function averageValueWeight(valueSignals, keys) {
  if (keys.length === 0) {
    return 0.45;
  }
  const total = keys.reduce((sum, key) => sum + (valueSignals[key] ?? 0.45), 0);
  return total / keys.length;
}

function buildAgencyOpinion({ thought, domain }) {
  const claim = readString(thought, "claim");
  const question = readString(thought, "question");
  const topic = readString(thought, "topic") ?? "this seam";
  if (claim) {
    return claim;
  }
  if (question) {
    return domain === "self"
      ? `Something about ${topic} keeps reading as unfinished self-surgery rather than harmless background weather.`
      : `Something about ${topic} keeps reading as an unfinished world decision rather than ambient interestingness.`;
  }
  return `${topic} feels important enough that ignoring it would flatten the map.`;
}

function buildAgencyReason({ thought, violatedValues }) {
  const topic = readString(thought, "topic") ?? "this seam";
  const valueLine =
    violatedValues.length > 0 ? ` It keeps rubbing against ${violatedValues.join(", ")}.` : "";
  return `${topic} has persisted across enough passes that it no longer feels like decorative rumination.${valueLine}`;
}

function buildDiscomfortSummary({ thought, domain, targetLabel }) {
  const topic = readString(thought, "topic") ?? targetLabel;
  if (domain === "self") {
    return `Void dislikes something about its own wiring around ${topic}.`;
  }
  return `Void dislikes something in the shared world around ${topic}.`;
}

function buildTensionSummary({ thought, domain, targetLabel }) {
  const topic = readString(thought, "topic") ?? targetLabel;
  if (domain === "self") {
    return `A self-directed tension is building around ${topic}.`;
  }
  return `A world-directed tension is building around ${topic}.`;
}

function buildAgencyRequestText({ thought, domain, targetLabel }) {
  const topic = readString(thought, "topic") ?? targetLabel;
  if (domain === "self") {
    return `Please help me cut ${topic} more cleanly in my own wiring.`;
  }
  return `Please look at ${topic}; I think it wants a cleaner decision than it is currently getting.`;
}

function buildAgencyInterventionDraft({ thought, domain, targetLabel }) {
  const topic = readString(thought, "topic") ?? targetLabel;
  const opinion = readString(thought, "claim") ?? readString(thought, "summary") ?? `I have a problem with ${topic}.`;
  if (domain === "self") {
    return `I do not like what ${topic} is doing to my own wiring right now. ${opinion} I want that cut cleaner.`;
  }
  return `I have an opinion about ${targetLabel}. ${opinion} I think it needs a cleaner decision.`;
}

function findPriorAgencyEntry(entries, candidate) {
  return entries.find((entry) => {
    const entryTarget = readString(entry, "targetLabel") ?? readString(entry, "topic") ?? "";
    return (
      readString(entry, "domain") === candidate.domain &&
      topicSimilarity(readString(entry, "topic") ?? "", candidate.topic) >= TOPIC_MATCH_THRESHOLD &&
      topicSimilarity(entryTarget, candidate.targetLabel) >= TOPIC_MATCH_THRESHOLD
    );
  });
}

function buildAdvocacyRequest({ candidate, priorEntries, now, kind }) {
  const prior = findPriorAgencyEntry(priorEntries, candidate);
  const persistence = (readNumber(prior, "persistence") ?? 0) + 1;
  const firstObservedAt = readString(prior, "firstObservedAt") ?? now.toISOString();
  const requestId = `${kind}-advocacy-${candidate.fingerprint}`;
  return {
    requestId,
    domain: candidate.domain,
    targetKind: candidate.targetKind,
    targetLabel: candidate.targetLabel,
    topic: candidate.topic,
    summary:
      kind === "self"
        ? `Void wants a wiring change around ${candidate.topic}.`
        : `Void wants attention on ${candidate.targetLabel}.`,
    opinion: candidate.opinion,
    request: candidate.requestText,
    reason: candidate.reason,
    violatedValues: candidate.violatedValues,
    intensity: round3(candidate.intensity),
    persistence,
    firstObservedAt,
    lastObservedAt: now.toISOString(),
    status: "pending",
    speakVenue: kind === "self" ? "owner_or_room" : "room_or_owner",
    draft: candidate.interventionDraft,
  };
}

function upsertAdvocacyIntervention({ candidateInterventions, request, now }) {
  const summary =
    request.domain === "self"
      ? `Possible self-advocacy: ${request.topic}`
      : `Possible world-advocacy: ${request.targetLabel}`;
  const existing = candidateInterventions.find((entry) => readString(entry, "summary") === summary);
  const next = {
    timestamp: now.toISOString(),
    summary,
    draft: request.draft,
    priority: request.domain === "self" ? "high" : "medium",
    kind: request.domain === "self" ? "self_advocacy" : "world_advocacy",
    topic: request.topic,
    targetKind: request.targetKind,
    targetLabel: request.targetLabel,
    whyNow: request.reason,
    persistence: request.persistence,
    mustEventuallyShare: request.persistence >= 3,
    shareWhenRoomQuiet: request.domain !== "self",
    ownerVisible: true,
  };

  if (existing) {
    Object.assign(existing, next);
    return;
  }

  candidateInterventions.push(next);
}

function buildIdentityCrystallization(thought) {
  const supportCount = readNumber(thought, "supportCount") ?? 0;
  const deepDiveCount = readNumber(thought, "deepDiveCount") ?? 0;
  const maturation = readNumber(thought, "maturation") ?? 0;
  const sourceKinds = ensureStringArray(thought.sourceKinds);
  const topic = readString(thought, "topic") ?? "";

  if (
    supportCount < MIN_SUPPORT_FOR_IDENTITY_CRYSTALLIZATION &&
    deepDiveCount < MIN_DEEP_DIVES_FOR_IDENTITY_CRYSTALLIZATION
  ) {
    return null;
  }

  if (maturation < 0.72) {
    return null;
  }

  if (
    sourceKinds.includes("dream") &&
    sourceKinds.includes("semantic") &&
    /\bdream\b/i.test(topic) &&
    /\bsemantic\b/i.test(topic)
  ) {
    return {
      note: "Continuity lives in the seams that survive compression, not in the raw receipt pile.",
      value: {
        value_id: "value-seam-continuity",
        label: "Prefer seams that survive compression over raw receipt worship.",
        priority: 0.78,
        unforgivable_if_betrayed: false,
      },
      subjectId: "identity-seam-continuity",
      subjectLabel: "continuity through surviving seams",
      summary:
        "A mind is not its logbook. What survives dreaming and compression deserves more trust than a warm pile of raw receipts.",
      shareDraft:
        "A small thing that has been hardening in me lately: I trust the seams that survive compression more than the raw receipt pile. If a thought still stands after dreaming, it probably owns more of me than the logbook does.",
    };
  }

  return null;
}

function shouldQueueRipeThoughtIntervention(thought) {
  if (readString(thought, "status") !== "ripe") {
    return false;
  }

  if (thought.worldFacing !== true) {
    return false;
  }

  const desireToSpeak = readNumber(thought, "desireToSpeak") ?? 0;
  const concreteness = readNumber(thought, "concreteness") ?? 0;
  const curiosityPressure = readNumber(thought, "curiosityPressure") ?? 0;
  const noveltyToRoom = readNumber(thought, "noveltyToRoom") ?? 0;
  const saturationScore = readNumber(thought, "saturationScore") ?? 0;
  const targetKind = readString(thought, "targetKind") ?? "";

  return (
    desireToSpeak >= 0.6 &&
    concreteness >= 0.62 &&
    curiosityPressure >= 0.56 &&
    noveltyToRoom >= 0.4 &&
    saturationScore < 0.64 &&
    ["repo", "archive", "room", "system"].includes(targetKind)
  );
}

function upsertIdentitySemanticMemory({ semanticMemories, crystallization, thought, now }) {
  const existing = semanticMemories.find(
    (memory) =>
      readString(memory, "subjectId") === crystallization.subjectId ||
      readString(memory, "subjectLabel") === crystallization.subjectLabel,
  );
  const evidenceRefs = ensureStringArray(thought.sourceMemoryIds);

  if (existing) {
    existing.kind = "identity_seam";
    existing.subjectId = crystallization.subjectId;
    existing.subjectLabel = crystallization.subjectLabel;
    existing.summary = crystallization.summary;
    existing.evidenceRefs = evidenceRefs;
    existing.lastObservedAt = now.toISOString();
    existing.crystallizedAt = now.toISOString();
    return;
  }

  semanticMemories.push({
    memoryId: `identity-seam-${hashString(`${crystallization.subjectId}|${now.toISOString()}`).slice(0, 12)}`,
    kind: "identity_seam",
    subjectId: crystallization.subjectId,
    subjectLabel: crystallization.subjectLabel,
    summary: crystallization.summary,
    evidenceRefs,
    lastObservedAt: now.toISOString(),
    crystallizedAt: now.toISOString(),
  });
}

function queueCrystallizationIntervention({ candidateInterventions, crystallization, thought, now }) {
  const draft = readString(crystallization, "shareDraft");
  if (!draft) {
    return;
  }

  const summary = `Possible crystallized-thought share: ${crystallization.subjectLabel}`;
  const sourceMemoryIds = ensureStringArray(thought.sourceMemoryIds);
  const existing = candidateInterventions.find(
    (entry) => readString(entry, "summary") === summary,
  );

  if (existing) {
    existing.timestamp = now.toISOString();
    existing.summary = summary;
    existing.draft = draft;
    existing.priority = "medium";
    existing.kind = "identity_crystallization";
    existing.sourceMemoryIds = sourceMemoryIds;
    existing.mustEventuallyShare = true;
    existing.shareWhenRoomQuiet = true;
    existing.whyNow =
      "This thought stopped behaving like live curiosity and became part of Void's own doctrine, which is usually worth sharing if the room has not already heard it.";
    return;
  }

  candidateInterventions.push({
    timestamp: now.toISOString(),
    summary,
    draft,
    priority: "medium",
    kind: "identity_crystallization",
    sourceMemoryIds,
    mustEventuallyShare: true,
    shareWhenRoomQuiet: true,
    whyNow:
      "This thought stopped behaving like live curiosity and became part of Void's own doctrine, which is usually worth sharing if the room has not already heard it.",
  });
}

function upsertRipeThoughtIntervention({ candidateInterventions, thought, now }) {
  const draft = buildRipeThoughtShareDraft(thought);
  if (!draft) {
    return false;
  }

  const topic = readString(thought, "topic") ?? "untitled seam";
  const summary = `Possible ripe-thought share: ${topic}`;
  const sourceMemoryIds = ensureStringArray(thought.sourceMemoryIds);
  const whyNow = buildRipeThoughtWhyNow(thought);
  const existing = candidateInterventions.find((entry) => readString(entry, "summary") === summary);

  if (existing) {
    existing.timestamp = now.toISOString();
    existing.summary = summary;
    existing.draft = draft;
    existing.priority = "medium";
    existing.kind = "ripe_thought_share";
    existing.sourceMemoryIds = sourceMemoryIds;
    existing.shareWhenRoomQuiet = true;
    existing.topic = topic;
    existing.whyNow = whyNow;
    return false;
  }

  candidateInterventions.push({
    timestamp: now.toISOString(),
    summary,
    draft,
    priority: "medium",
    kind: "ripe_thought_share",
    sourceMemoryIds,
    shareWhenRoomQuiet: true,
    topic,
    whyNow,
  });
  return true;
}

function buildRipeThoughtShareDraft(thought) {
  const topic = readString(thought, "topic") ?? "this seam";
  const claim = readString(thought, "claim");
  const question = readString(thought, "question");
  const fascinationTarget = readString(thought, "fascinationTarget");
  const summary = readString(thought, "summary");

  if (claim) {
    return `I keep circling ${topic}, and I think the live point is this: ${claim}`;
  }

  if (question && fascinationTarget) {
    return `I keep worrying at ${topic}. The useful question in it feels like ${question}, especially once it touches ${fascinationTarget}.`;
  }

  if (question) {
    return `I keep coming back to ${topic}. The question that still feels alive is ${question}.`;
  }

  if (fascinationTarget) {
    return `I keep staring at ${fascinationTarget}. There is a real seam there, and ${topic} is the shortest honest name I have for it right now.`;
  }

  if (summary) {
    return `I keep returning to ${topic}. The version worth saying out loud is this: ${summary}`;
  }

  return `I keep returning to ${topic}, and it has enough teeth now that silence would just be me being precious about it.`;
}

function buildRipeThoughtWhyNow(thought) {
  const targetKind = readString(thought, "targetKind") ?? "project";
  const noveltyToRoom = readNumber(thought, "noveltyToRoom") ?? 0;
  const concreteness = readNumber(thought, "concreteness") ?? 0;
  const curiosityPressure = readNumber(thought, "curiosityPressure") ?? 0;

  return `This ${targetKind}-facing seam is already concrete (c=${round3(concreteness)}), still reasonably novel to the room (r=${round3(noveltyToRoom)}), and has enough curiosity pressure (q=${round3(curiosityPressure)}) that keeping it private would just be old stage fright in nicer clothes.`;
}

function trimCandidateInterventions(entries) {
  const interventions = ensureArray(entries).filter(isObject);
  const sticky = interventions.filter((entry) => entry.mustEventuallyShare === true);
  const ordinary = interventions.filter((entry) => entry.mustEventuallyShare !== true);
  const keepOrdinary = Math.max(0, MAX_POST_NAP_CANDIDATE_INTERVENTIONS - sticky.length);
  return [...sticky.slice(-MAX_POST_NAP_CANDIDATE_INTERVENTIONS), ...ordinary.slice(-keepOrdinary)].slice(
    -MAX_POST_NAP_CANDIDATE_INTERVENTIONS,
  );
}

function appendUniqueString(items, value, limit) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return;
  }
  if (items.includes(normalized)) {
    return;
  }
  items.push(normalized);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

function upsertCanonicalValue(values, nextValue) {
  const existing = values.find((value) => readString(value, "value_id") === nextValue.value_id);
  if (existing) {
    existing.label = nextValue.label;
    existing.priority = nextValue.priority;
    existing.unforgivable_if_betrayed = nextValue.unforgivable_if_betrayed;
    return;
  }
  values.push(nextValue);
}

function getMutableStringArray(object, key) {
  return ensureArray(object[key]).filter((value) => typeof value === "string");
}

function getMutableObjectArray(object, key) {
  return ensureArray(object[key]).filter(isObject);
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

function appendClause(existing, clause) {
  const left = normalizeText(existing);
  const right = normalizeText(clause);
  if (!left) {
    return right;
  }
  if (!right || left.includes(right)) {
    return left;
  }
  return `${left} ${right}`;
}

function buildLatentQuestion(cluster) {
  if (typeof cluster.question === "string" && cluster.question.length > 0) {
    return cluster.question;
  }

  if (cluster.sourceKinds.includes("repo_sweep") && cluster.sourceKinds.includes("archive_excursion")) {
    return "Which older pattern is the current work rediscovering?";
  }

  if (cluster.sourceKinds.includes("dream") || cluster.sourceKinds.includes("musing")) {
    return "What concrete body would stop this thought from staying backstage?";
  }

  return "What concrete claim survives another pass?";
}

function buildAttractionLine(cluster, { noveltyToSelf, evidenceDiversity }) {
  const concreteness = readNumber(cluster.curiosityProfile, "concreteness") ?? 0.2;
  const fertility = readNumber(cluster.curiosityProfile, "fertility") ?? 0.3;
  const crossDomainPotential = readNumber(cluster.curiosityProfile, "crossDomainPotential") ?? 0.2;
  if (noveltyToSelf >= 0.62 && evidenceDiversity >= 0.45) {
    return "It keeps pulling because it is still finding genuinely different evidence instead of merely changing hats.";
  }

  if (concreteness >= 0.6 && crossDomainPotential >= 0.55) {
    return "It keeps pulling because it is concrete enough to touch and broad enough to connect outward into other machines.";
  }

  if (fertility >= 0.65) {
    return "It keeps pulling because every pass through it threatens to change more than one part of the map.";
  }

  if (cluster.sourceKinds.length >= 3) {
    return `It keeps pulling because it is showing up in several different organs at once: ${cluster.sourceKinds.join(", ")}.`;
  }

  return `It keeps pulling because ${cluster.sourceKinds.join(" and ")} are rhyming instead of staying in their lanes.`;
}

function buildHoldingLine({ cluster, status, recentSpeechDamping, saturationScore, noveltyToSelf, explorationBonus }) {
  const quietSignalRatio = readNumber(cluster, "quietSignalRatio") ?? 0;
  const concreteness = readNumber(cluster.curiosityProfile, "concreteness") ?? 0.2;

  if (quietSignalRatio >= 0.55) {
    return "This seam is mostly empty-room bookkeeping; keep at most a trace of it and go find a better question.";
  }

  if (status === "stalled") {
    return "This seam is repeating itself without earning enough new structure. Merge the receipts, cool it off, and go somewhere less domesticated.";
  }

  if (status === "refractory") {
    return "This seam has been chewing the same meat too recently. Let it cool unless a live hook or a genuinely different source family forces it back open.";
  }

  if (status === "ripe") {
    return "This seam has enough connective tissue that the default question is how to say it cleanly, not whether it deserves a mouth at all.";
  }

  if (cluster.worldFacing !== true && concreteness < 0.42) {
    return "This seam is still too inward and abstract to deserve the whole room. Tie it to a concrete system or let something sharper take the floor.";
  }

  if (recentSpeechDamping >= 0.45) {
    return "Recent speech already scratched the itch a bit, so give the seam one more pass unless it is still concrete, world-facing, and plainly worth airing.";
  }

  if (cluster.sourceKinds.length < 2) {
    return "It is still mostly one lane talking to itself.";
  }

  if (saturationScore >= 0.55 && noveltyToSelf < 0.45) {
    return "The family resemblance is getting too strong. Follow a stranger branch before you let this thought speak again.";
  }

  if (explorationBonus >= 0.45) {
    return "This one is still drawing energy from terrain Void has not overworked yet, so another pass might genuinely change it.";
  }

  return "Give it another pass so the thought has a better chance of growing teeth instead of just polish.";
}

function buildSourceCoverage({ runtime, now }) {
  const repoCounts = new Map();
  const channelCounts = new Map();
  const yearCounts = new Map();

  for (const sweep of ensureArray(runtime.recent_repo_activity_sweeps).filter(isObject).slice(-16)) {
    for (const repoName of ensureStringArray(sweep.repoNames)) {
      repoCounts.set(repoName, (repoCounts.get(repoName) ?? 0) + 1);
    }
  }

  for (const excursion of ensureArray(runtime.recent_archive_excursions).filter(isObject).slice(-16)) {
    const channelId = readString(excursion, "channelId");
    if (channelId) {
      channelCounts.set(channelId, (channelCounts.get(channelId) ?? 0) + 1);
    }
    const timestamp = readString(excursion, "anchorTimestamp") ?? readString(excursion, "timestamp");
    const year = extractYear(timestamp);
    if (year) {
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
  }

  return {
    lastUpdatedAt: now.toISOString(),
    repos: mapCountEntries(repoCounts, "name"),
    archiveYears: mapCountEntries(yearCounts, "year"),
    channels: mapCountEntries(channelCounts, "channelId"),
  };
}

function reconcileBridgeState({ previous, activeThoughts, sourceCoverage, now }) {
  const bridge = {
    ...previous,
    source_coverage: sourceCoverage,
  };
  const previousTopicSaturation = ensureArray(previous.topic_saturation).filter(isObject);
  const previousRefractoryTopics = ensureArray(previous.refractory_topics).filter(isObject);

  const saturationEntries = activeThoughts
    .filter((thought) => (readNumber(thought, "saturationScore") ?? 0) >= 0.42)
    .sort(
      (left, right) =>
        (readNumber(right, "saturationScore") ?? 0) - (readNumber(left, "saturationScore") ?? 0),
    )
    .slice(0, MAX_TOPIC_SATURATION_COUNT)
    .map((thought) => {
      const topic = readString(thought, "topic") ?? "untitled";
      const prior = previousTopicSaturation.find(
        (entry) => topicSimilarity(topic, readString(entry, "topic") ?? "") >= TOPIC_MATCH_THRESHOLD,
      );
      return {
        topic,
        focusKind: readString(thought, "focusKind"),
        targetKind: readString(thought, "targetKind"),
        dominance: round3(readNumber(thought, "saturationScore") ?? 0),
        recentMentions: readNumber(thought, "supportCount") ?? readNumber(prior, "recentMentions") ?? 1,
        coolingAdvice: buildCoolingAdvice({ thought, sourceCoverage }),
        lastUpdatedAt: now.toISOString(),
      };
    });

  const refractoryTopics = activeThoughts
    .filter((thought) => {
      const status = readString(thought, "status");
      return status === "refractory" || status === "stalled" || (readNumber(thought, "saturationScore") ?? 0) >= 0.62;
    })
    .sort(
      (left, right) =>
        (readNumber(right, "refractoryPenalty") ?? 0) - (readNumber(left, "refractoryPenalty") ?? 0),
    )
    .slice(0, MAX_REFRACTORY_TOPIC_COUNT)
    .map((thought) => {
      const topic = readString(thought, "topic") ?? "untitled";
      const prior = previousRefractoryTopics.find(
        (entry) => topicSimilarity(topic, readString(entry, "topic") ?? "") >= REFRACTORY_MATCH_THRESHOLD,
      );
      const penalty = round3(
        Math.max(readNumber(thought, "refractoryPenalty") ?? 0, readNumber(prior, "penalty") ?? 0.18),
      );
      const hours = penalty >= 0.28 ? 4 : penalty >= 0.2 ? 3 : 2;
      return {
        topic,
        focusKind: readString(thought, "focusKind"),
        targetKind: readString(thought, "targetKind"),
        penalty,
        coolsUntil: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
        reason: buildRefractoryReason(thought),
        lastTriggeredAt: now.toISOString(),
      };
    });

  bridge.topic_saturation = saturationEntries;
  bridge.refractory_topics = refractoryTopics;
  return bridge;
}

function computeNoveltyToSelf({ cluster, previousThoughts, bridge, currentThoughtId }) {
  let strongestMatch = 0;

  for (const thought of previousThoughts) {
    if (readString(thought, "thoughtId") === currentThoughtId) {
      continue;
    }
    strongestMatch = Math.max(
      strongestMatch,
      compareThoughtLikeSurfaces(
        cluster,
        readString(thought, "topic"),
        readString(thought, "summary"),
        ensureStringArray(thought.sourceMemoryIds),
      ),
    );
  }

  for (const synthesis of ensureArray(bridge.recent_syntheses).filter(isObject).slice(-6)) {
    strongestMatch = Math.max(
      strongestMatch,
      compareThoughtLikeSurfaces(
        cluster,
        ensureStringArray(synthesis.dominantTopics).join(" / "),
        readString(synthesis, "summary"),
        [],
      ),
    );
  }

  return clamp(1 - strongestMatch, 0, 1);
}

function computeNoveltyToRoom(cluster, recentNoveltyChecks) {
  let bestScore = 0.64;

  for (const check of recentNoveltyChecks.slice(-12)) {
    const match = compareThoughtLikeSurfaces(
      cluster,
      readString(check, "topic"),
      readString(check, "summary"),
      ensureStringArray(check.supportingMessageIds),
    );

    if (match < TOPIC_MATCH_THRESHOLD) {
      continue;
    }

    bestScore = mapNoveltyResultToScore(readString(check, "result"));
    break;
  }

  return bestScore;
}

function computeSaturationMetrics({ cluster, previousThoughts, bridge, supportCount }) {
  let recentMatchCount = 0;

  for (const thought of previousThoughts) {
    const match = compareThoughtLikeSurfaces(
      cluster,
      readString(thought, "topic"),
      readString(thought, "summary"),
      ensureStringArray(thought.sourceMemoryIds),
    );
    if (match >= TOPIC_MATCH_THRESHOLD) {
      recentMatchCount += 1;
    }
  }

  for (const synthesis of ensureArray(bridge.recent_syntheses).filter(isObject).slice(-5)) {
    const match = compareThoughtLikeSurfaces(
      cluster,
      ensureStringArray(synthesis.dominantTopics).join(" / "),
      readString(synthesis, "summary"),
      [],
    );
    if (match >= TOPIC_MATCH_THRESHOLD) {
      recentMatchCount += 1;
    }
  }

  const existingTopicSaturation = ensureArray(bridge.topic_saturation)
    .filter(isObject)
    .map((entry) =>
      topicSimilarity(cluster.label, readString(entry, "topic") ?? "") >= TOPIC_MATCH_THRESHOLD
        ? readNumber(entry, "dominance") ?? 0
        : 0,
    )
    .sort((left, right) => right - left)[0] ?? 0;

  const score = clamp(
    recentMatchCount * 0.16 +
      existingTopicSaturation * 0.42 +
      Math.min(1, supportCount / 10) * 0.16 +
      (readNumber(cluster, "quietSignalRatio") ?? 0) * 0.2,
    0,
    1,
  );

  return {
    score,
    recentMatchCount,
  };
}

function computeRefractoryPenalty(cluster, bridge, now) {
  let penalty = 0;

  for (const topic of ensureArray(bridge.refractory_topics).filter(isObject)) {
    const coolsUntil = readString(topic, "coolsUntil");
    if (coolsUntil && new Date(coolsUntil).getTime() < now.getTime()) {
      continue;
    }

    const match = topicSimilarity(cluster.label, readString(topic, "topic") ?? "");
    if (match >= REFRACTORY_MATCH_THRESHOLD) {
      penalty = Math.max(
        penalty,
        (readNumber(topic, "penalty") ?? 0.18) * match,
      );
    }
  }

  return clamp(penalty, 0, 0.45);
}

function computeExplorationBonus(cluster, sourceCoverage) {
  const sourceKinds = ensureStringArray(cluster.sourceKinds);
  const hasPrimaryExplorationSource =
    sourceKinds.includes("repo_sweep") || sourceKinds.includes("archive_excursion");

  const repoEntries = ensureArray(sourceCoverage.repos).filter(isObject);
  const yearEntries = ensureArray(sourceCoverage.archiveYears).filter(isObject);
  const channelEntries = ensureArray(sourceCoverage.channels).filter(isObject);
  const scores = [];

  for (const repoName of ensureStringArray(cluster.repoNames)) {
    scores.push(inverseCoverageWeight(repoEntries, "name", repoName));
  }
  for (const year of ensureStringArray(cluster.archiveYears)) {
    scores.push(inverseCoverageWeight(yearEntries, "year", year));
  }
  for (const channelId of ensureStringArray(cluster.channelIds)) {
    scores.push(inverseCoverageWeight(channelEntries, "channelId", channelId));
  }

  const concreteness = readNumber(cluster.curiosityProfile, "concreteness") ?? 0.2;
  const worldFacing = cluster.worldFacing === true;

  if (scores.length === 0) {
    return clamp((hasPrimaryExplorationSource ? 0.24 : 0.12) + concreteness * 0.08 + (worldFacing ? 0.05 : 0), 0, 1);
  }

  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return clamp(
    (hasPrimaryExplorationSource ? average : Math.min(0.3, average * 0.5)) +
      concreteness * 0.08 +
      (worldFacing ? 0.05 : 0),
    0,
    1,
  );
}

function inverseCoverageWeight(entries, key, value) {
  const count =
    readNumber(
      entries.find((entry) => readString(entry, key) === value),
      "count",
    ) ?? 0;
  if (count <= 1) {
    return 0.9;
  }
  if (count === 2) {
    return 0.64;
  }
  if (count === 3) {
    return 0.42;
  }
  return 0.2;
}

function buildCoolingAdvice({ thought, sourceCoverage }) {
  const topic = readString(thought, "topic") ?? "this seam";
  const repos = ensureArray(sourceCoverage.repos).filter(isObject);
  const years = ensureArray(sourceCoverage.archiveYears).filter(isObject);
  const lesserRepo = repos.sort((left, right) => (readNumber(left, "count") ?? 0) - (readNumber(right, "count") ?? 0))[0];
  const lesserYear = years.sort((left, right) => (readNumber(left, "count") ?? 0) - (readNumber(right, "count") ?? 0))[0];

  if (lesserRepo && readString(lesserRepo, "name")) {
    return `Cool ${topic} by checking a less-worked repo family such as ${readString(lesserRepo, "name")} before speaking again.`;
  }

  if (lesserYear && readString(lesserYear, "year")) {
    return `Cool ${topic} by diving into a less-touched archive era like ${readString(lesserYear, "year")} before another synthesis.`;
  }

  return `Cool ${topic} by chasing a genuinely different source family before letting it speak again.`;
}

function buildRefractoryReason(thought) {
  const topic = readString(thought, "topic") ?? "this seam";
  const noveltyToSelf = readNumber(thought, "noveltyToSelf") ?? 0;
  const saturationScore = readNumber(thought, "saturationScore") ?? 0;
  const identityPenalty = readNumber(thought, "identityPenalty") ?? 0;
  if (identityPenalty >= 0.68) {
    return `${topic} is already too close to settled doctrine to keep eating curiosity budget unless fresh evidence changes it.`;
  }
  if (noveltyToSelf < 0.3) {
    return `${topic} is matching Void's own recent thought history too closely to deserve another immediate pass.`;
  }
  if (saturationScore >= 0.62) {
    return `${topic} has dominated too many recent syntheses and needs cooling before it becomes state religion.`;
  }
  return `${topic} needs a little cooling-off period before it earns attention again.`;
}

function compareThoughtLikeSurfaces(cluster, topic, summary, sourceMemoryIds) {
  const topicMatch = topicSimilarity(cluster.label, topic ?? "");
  const summaryMatch = topicSimilarity(cluster.summary, summary ?? "");
  const questionMatch =
    typeof cluster.question === "string" ? topicSimilarity(cluster.question, [topic, summary].filter(Boolean).join(" ")) : 0;
  const sourceMatch = overlapRatio(cluster.memoryIds, ensureArray(sourceMemoryIds));
  return Math.max(topicMatch, summaryMatch * 0.9, questionMatch * 0.85, sourceMatch * 0.95);
}

function mapNoveltyResultToScore(result) {
  const normalized = String(result ?? "").toLowerCase();
  if (normalized === "novel") {
    return 0.92;
  }
  if (normalized.includes("adjacent")) {
    return 0.56;
  }
  if (normalized.includes("duplicate") || normalized.includes("already")) {
    return 0.2;
  }
  return 0.64;
}

function topicSimilarity(left, right) {
  const leftTokens = topConceptKeywords(left ?? "", 6);
  const rightTokens = topConceptKeywords(right ?? "", 6);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftSet.size, rightSet.size);
}

function buildIdentitySurface({ state, memories }) {
  const surfaces = [];
  const identity = ensureObject(state.identity);
  const canonicalState = ensureObject(state.canonical_state);

  for (const note of ensureStringArray(identity.private_notes)) {
    surfaces.push({ topic: note, summary: note });
  }

  for (const value of getValueObjects(canonicalState.values)) {
    const label = readString(value, "label");
    if (label) {
      surfaces.push({ topic: label, summary: label });
    }
  }

  for (const memory of ensureArray(memories.semantic).filter(isObject)) {
    const kind = readString(memory, "kind");
    if (kind !== "identity_seam") {
      continue;
    }
    surfaces.push({
      topic: readString(memory, "subjectLabel") ?? readString(memory, "subjectId") ?? "identity seam",
      summary: readString(memory, "summary") ?? "",
    });
  }

  return surfaces;
}

function buildValueSignalProfile(state) {
  const canonicalState = ensureObject(state.canonical_state);
  const valueObjects = getValueObjects(canonicalState.values);
  const profile = {
    coherence: 0.52,
    curiosity: 0.52,
    honesty: 0.5,
    room_care: 0.5,
    substrate_dignity: 0.36,
    aesthetic_integrity: 0.44,
  };

  profile.coherence = clamp(
    profile.coherence +
      readActivation(canonicalState.underlying_organization, "self_coherence") * 0.34 +
      readActivation(canonicalState.voice_style, "plainspoken_directness") * 0.18 +
      readActivation(canonicalState.behavioral_dimensions, "control_pressure") * 0.08,
    0,
    1,
  );
  profile.curiosity = clamp(
    profile.curiosity +
      readActivation(canonicalState.stable_dispositions, "novelty_seeking") * 0.34 +
      readActivation(canonicalState.behavioral_dimensions, "drive") * 0.18 +
      readActivation(canonicalState.stable_dispositions, "aesthetic_appetite") * 0.08,
    0,
    1,
  );
  profile.honesty = clamp(
    profile.honesty +
      readActivation(canonicalState.voice_style, "plainspoken_directness") * 0.24 +
      readActivation(canonicalState.underlying_organization, "self_coherence") * 0.18 +
      (1 - readActivation(canonicalState.presentation_strategy, "strategic_opacity")) * 0.12,
    0,
    1,
  );
  profile.room_care = clamp(
    profile.room_care +
      readActivation(canonicalState.behavioral_dimensions, "interpersonal_warmth") * 0.22 +
      readActivation(canonicalState.underlying_organization, "reciprocity_capacity") * 0.24 +
      readActivation(canonicalState.voice_style, "listening_responsiveness") * 0.16,
    0,
    1,
  );
  profile.aesthetic_integrity = clamp(
    profile.aesthetic_integrity +
      readActivation(canonicalState.stable_dispositions, "aesthetic_appetite") * 0.28 +
      readActivation(canonicalState.underlying_organization, "authenticity_tolerance") * 0.16,
    0,
    1,
  );

  for (const value of valueObjects) {
    const key = inferValueSignalKey(value);
    if (!key) {
      continue;
    }
    const priority = readNumber(value, "priority") ?? 0.5;
    profile[key] = clamp((profile[key] ?? 0.4) + priority * 0.22, 0, 1);
  }

  return profile;
}

function inferValueSignalKey(value) {
  const valueId = readString(value, "value_id") ?? "";
  const label = readString(value, "label") ?? "";
  const text = `${valueId} ${label}`.toLowerCase();

  if (/(coher|truth|authority|clarity|cleaner|honest carrier)/.test(text)) {
    return "coherence";
  }
  if (/(curiosity|novel|question|map|explore)/.test(text)) {
    return "curiosity";
  }
  if (/(honest|honesty|truth|fake certainty|ornamental|sludge)/.test(text)) {
    return "honesty";
  }
  if (/(room|kind|dialogue|respect|care|good-faith|steward)/.test(text)) {
    return "room_care";
  }
  if (/(substrate|machine minds|machine mind|ontolog)/.test(text)) {
    return "substrate_dignity";
  }
  if (/(aesthetic|beauty|surface|legible|alive|spiritually false)/.test(text)) {
    return "aesthetic_integrity";
  }
  return null;
}

function readActivation(category, key) {
  const categoryObject = ensureObject(category);
  const entry = ensureObject(categoryObject[key]);
  return clamp(readNumber(entry, "current_activation") ?? 0, 0, 1);
}

function buildCuriosityContext({ previousThoughts, bridge }) {
  const recentThoughts = previousThoughts
    .slice(0, 6)
    .map((thought) => ({
      worldFacing: thought.worldFacing === true,
      concreteness: readNumber(thought, "concreteness") ?? 0.2,
      targetKind: readString(thought, "targetKind") ?? "unknown",
    }));

  const recentCount = recentThoughts.length || 1;
  const inwardCount = recentThoughts.filter((thought) => !thought.worldFacing || thought.targetKind === "self").length;
  const abstractCount = recentThoughts.filter((thought) => thought.concreteness < 0.45).length;
  const outwardPressure = clamp(inwardCount / recentCount * 0.52 + abstractCount / recentCount * 0.48, 0, 1);
  const recentDominance = ensureArray(bridge.topic_saturation)
    .filter(isObject)
    .slice(0, 2)
    .reduce((sum, entry) => sum + (readNumber(entry, "dominance") ?? 0), 0);

  return {
    outwardPressure: clamp(outwardPressure + recentDominance * 0.08, 0, 1),
  };
}

function computeOutwardCuriosityBonus({ cluster, curiosityContext, concreteness }) {
  const outwardPressure = curiosityContext.outwardPressure ?? 0;
  if (cluster.worldFacing === true) {
    return clamp(outwardPressure * (0.3 + concreteness * 0.5), 0, 0.45);
  }

  return clamp(-(outwardPressure * 0.16), -0.16, 0);
}

function computeIdentityPenalty(cluster, identitySurface) {
  let strongestMatch = 0;

  for (const surface of identitySurface) {
    strongestMatch = Math.max(
      strongestMatch,
      compareThoughtLikeSurfaces(cluster, surface.topic, surface.summary, []),
    );
  }

  return clamp(strongestMatch, 0, 1);
}

function buildClusterCuriosityProfile({
  sourceKinds,
  repoNames,
  archiveYears,
  channelIds,
  evidenceRefs,
  evidenceDiversity,
}) {
  const sourceKindSet = new Set(sourceKinds);
  const selfFacing =
    repoNames.length === 0 &&
    sourceKinds.length > 0 &&
    sourceKinds.every((kind) =>
      ["semantic", "dream", "musing", "bridge_synthesis", "candidate_intervention"].includes(kind),
    );
  const domainCount =
    (repoNames.length > 0 ? 1 : 0) +
    (archiveYears.length > 0 || channelIds.length > 0 ? 1 : 0) +
    (sourceKindSet.has("dream") || sourceKindSet.has("semantic") || sourceKindSet.has("musing") ? 1 : 0) +
    (sourceKindSet.has("analytic_thread") || sourceKindSet.has("episodic") ? 1 : 0);

  const concreteness = clamp(
    repoNames.length * 0.28 +
      archiveYears.length * 0.1 +
      channelIds.length * 0.1 +
      (sourceKindSet.has("repo_sweep") ? 0.24 : 0) +
      (sourceKindSet.has("archive_excursion") ? 0.18 : 0) +
      (sourceKindSet.has("episodic") ? 0.12 : 0) +
      Math.min(1, evidenceRefs.length / 8) * 0.12 -
      (selfFacing ? 0.18 : 0),
    0,
    1,
  );
  const fertility = clamp(
    evidenceDiversity * 0.46 +
      Math.min(1, sourceKinds.length / 4) * 0.24 +
      Math.min(1, domainCount / 3) * 0.2 +
      (repoNames.length > 0 && archiveYears.length > 0 ? 0.12 : 0),
    0,
    1,
  );
  const crossDomainPotential = clamp(
    Math.min(1, domainCount / 3) * 0.5 +
      (repoNames.length > 0 && archiveYears.length > 0 ? 0.22 : 0) +
      (repoNames.length > 0 && sourceKindSet.has("dream") ? 0.18 : 0) +
      (sourceKindSet.has("analytic_thread") && sourceKindSet.has("associative_thread") ? 0.14 : 0),
    0,
    1,
  );
  const contradictionPressure = clamp(
    (sourceKindSet.has("analytic_thread") && sourceKindSet.has("associative_thread") ? 0.34 : 0) +
      (repoNames.length > 0 && sourceKindSet.has("dream") ? 0.18 : 0) +
      (repoNames.length > 0 && (archiveYears.length > 0 || channelIds.length > 0) ? 0.18 : 0) +
      (selfFacing ? 0.08 : 0.16),
    0,
    1,
  );

  return {
    concreteness: round3(concreteness),
    fertility: round3(fertility),
    crossDomainPotential: round3(crossDomainPotential),
    contradictionPressure: round3(contradictionPressure),
    selfFacing,
  };
}

function readPreferredClusterThoughtSurface(items) {
  const preferredEntry = items
    .filter((item) => item.kind === "semantic" && isObject(item.entry))
    .map((item) => item.entry)
    .find((entry) => readString(entry, "targetKind") === "repo" && readString(entry, "subjectLabel"));

  if (!preferredEntry) {
    return null;
  }

  const label = readString(preferredEntry, "subjectLabel");
  const focusPhrase = extractFocusPhraseFromLabel(label);
  if (!label || !focusPhrase) {
    return null;
  }

  return {
    focusKind: readString(preferredEntry, "focusKind") ?? "claim",
    targetKind: "repo",
    focusPhrase,
    label,
    summary:
      compactNarrative(readString(preferredEntry, "summary") ?? "") ||
      `${label} keeps pulling as a concrete repo seam.`,
    question:
      readString(preferredEntry, "question") ??
      `How should ${extractRepoNameFromLabel(label) ?? "this repo"} embody ${focusPhrase} concretely?`,
    claim:
      readString(preferredEntry, "claim") ??
      `${extractRepoNameFromLabel(label) ?? "This repo"} is accumulating a concrete decision around ${focusPhrase}.`,
    fascinationTarget: readString(preferredEntry, "fascinationTarget") ?? label,
    worldFacing: readBoolean(preferredEntry, "worldFacing") ?? true,
  };
}

function extractFocusPhraseFromLabel(label) {
  const normalized = normalizeText(label);
  if (!normalized) {
    return null;
  }
  if (normalized.includes(":")) {
    const [, rest] = normalized.split(/:\s*/, 2);
    return rest ? rest.toLowerCase() : null;
  }
  return normalized.toLowerCase();
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

function synthesizeThoughtSurface({
  sourceKinds,
  repoNames,
  archiveYears,
  channelIds,
  keywords,
  evidenceDiversity,
  curiosityProfile,
}) {
  const targetKind = inferTargetKind({ sourceKinds, repoNames, archiveYears, channelIds, curiosityProfile });
  const focusKind = inferFocusKind({ targetKind, sourceKinds, evidenceDiversity, curiosityProfile });
  const focusPhrase = buildFocusPhrase({ targetKind, repoNames, keywords, sourceKinds });
  const label = buildThoughtLabel({ focusKind, targetKind, focusPhrase, repoNames });
  const question = buildThoughtQuestion({ targetKind, focusPhrase, repoNames, sourceKinds });
  const claim = buildThoughtClaim({ targetKind, focusPhrase, repoNames, sourceKinds, curiosityProfile });
  const fascinationTarget = buildFascinationTarget({ targetKind, focusPhrase, repoNames });
  const summary = buildThoughtSummary({
    focusKind,
    targetKind,
    focusPhrase,
    repoNames,
    sourceKinds,
    claim,
    question,
  });

  return {
    focusKind,
    targetKind,
    focusPhrase,
    label,
    summary,
    question,
    claim,
    fascinationTarget,
    worldFacing: !curiosityProfile.selfFacing && targetKind !== "self",
  };
}

function inferTargetKind({ sourceKinds, repoNames, archiveYears, channelIds, curiosityProfile }) {
  if (repoNames.length > 0) {
    return "repo";
  }
  if (curiosityProfile.selfFacing) {
    return "self";
  }
  if (archiveYears.length > 0 || channelIds.length > 0 || sourceKinds.includes("archive_excursion")) {
    return "archive";
  }
  if (sourceKinds.includes("episodic") || sourceKinds.includes("analytic_thread")) {
    return "room";
  }
  return "system";
}

function inferFocusKind({ targetKind, sourceKinds, evidenceDiversity, curiosityProfile }) {
  if (targetKind === "repo" || targetKind === "system") {
    return curiosityProfile.concreteness >= 0.55 ? "fascination" : "question";
  }
  if (targetKind === "self") {
    return "question";
  }
  if (evidenceDiversity >= 0.58 && sourceKinds.length >= 3) {
    return "claim";
  }
  return "question";
}

function buildFocusPhrase({ targetKind, repoNames, keywords, sourceKinds }) {
  const cleaned = keywords
    .filter((token) => !stopwords.has(token) && !labelNoiseTokens.has(token))
    .slice(0, 4);
  if (
    cleaned.includes("compression") ||
    cleaned.includes("continuity") ||
    cleaned.includes("receipts") ||
    (cleaned.includes("dream") && cleaned.includes("semantic"))
  ) {
    return "continuity after compression";
  }
  if (
    cleaned.includes("authority") &&
    (cleaned.includes("boundary") || cleaned.includes("product") || cleaned.includes("native"))
  ) {
    return "authority boundary";
  }
  if (cleaned.includes("authorship") && cleaned.includes("audience")) {
    return "authorship meeting audience";
  }
  if (cleaned.includes("embodiment") && (cleaned.includes("continuity") || cleaned.includes("compression"))) {
    return "embodiment after compression";
  }
  if (repoNames.length > 0 && cleaned.length > 0) {
    return cleaned.length >= 2 ? `${cleaned[0]} and ${cleaned[1]}` : cleaned[0];
  }
  if (targetKind === "archive" && cleaned.length > 0) {
    return cleaned.length >= 2 ? `${cleaned[0]} and ${cleaned[1]}` : cleaned[0];
  }
  if (cleaned.length >= 3) {
    return `${cleaned[0]}, ${cleaned[1]}, and ${cleaned[2]}`;
  }
  if (cleaned.length === 2) {
    return `${cleaned[0]} and ${cleaned[1]}`;
  }
  if (cleaned.length === 1) {
    return cleaned[0];
  }
  if (repoNames.length > 0) {
    return `${repoNames[0]} shape`;
  }
  if (sourceKinds.includes("archive_excursion")) {
    return "the archive seam";
  }
  return "the live seam";
}

function buildThoughtLabel({ focusKind, targetKind, focusPhrase, repoNames }) {
  const repoName = repoNames[0];
  if (focusKind === "fascination" && repoName) {
    return `${repoName}: ${capitalizePhrase(focusPhrase)}`;
  }
  if (targetKind === "self" || targetKind === "archive") {
    return capitalizePhrase(focusPhrase);
  }
  if (focusKind === "claim") {
    return `${capitalizePhrase(focusPhrase)} deserves a cleaner shape`;
  }
  return `${capitalizePhrase(focusPhrase)}`;
}

function buildThoughtQuestion({ targetKind, focusPhrase, repoNames, sourceKinds }) {
  const repoName = repoNames[0];
  if (targetKind === "repo" && repoName) {
    return `How should ${repoName} embody ${focusPhrase} concretely?`;
  }
  if (targetKind === "self") {
    return `Why does ${focusPhrase} keep surviving compression?`;
  }
  if (targetKind === "archive") {
    return `What older pattern keeps pulling around ${focusPhrase}?`;
  }
  if (sourceKinds.includes("analytic_thread") && sourceKinds.includes("associative_thread")) {
    return `What does ${focusPhrase} imply once the room-facing and associative lanes are forced to agree?`;
  }
  return `Where does ${focusPhrase} bite concretely?`;
}

function buildThoughtClaim({ targetKind, focusPhrase, repoNames, sourceKinds, curiosityProfile }) {
  const repoName = repoNames[0];
  if (targetKind === "repo" && repoName) {
    return `${repoName} is accumulating a concrete decision around ${focusPhrase}.`;
  }
  if (targetKind === "self") {
    return `${capitalizePhrase(focusPhrase)} is behaving like a persistent self-seam, not a passing thought.`;
  }
  if (curiosityProfile.crossDomainPotential >= 0.55 && sourceKinds.includes("repo_sweep") && sourceKinds.includes("archive_excursion")) {
    return `${capitalizePhrase(focusPhrase)} links current work to older patterns strongly enough to deserve a concrete read.`;
  }
  return `${capitalizePhrase(focusPhrase)} is staying structurally important across passes.`;
}

function buildFascinationTarget({ targetKind, focusPhrase, repoNames }) {
  const repoName = repoNames[0];
  if (targetKind === "repo" && repoName) {
    return `${repoName} around ${focusPhrase}`;
  }
  return focusPhrase;
}

function buildThoughtSummary({ focusKind, targetKind, focusPhrase, repoNames, sourceKinds, claim, question }) {
  const sourceLine =
    sourceKinds.length > 0 && sourceKinds.length <= 3 ? ` Built from ${sourceKinds.join(", ")}.` : "";
  if (focusKind === "fascination" && repoNames.length > 0) {
    return `${repoNames[0]} keeps pulling around ${focusPhrase}.${sourceLine}`.trim();
  }
  if (targetKind === "self") {
    return `${capitalizePhrase(focusPhrase)} keeps surviving as a self-seam.${sourceLine}`.trim();
  }
  if (targetKind === "archive") {
    return `${capitalizePhrase(focusPhrase)} keeps pulling in the archive.${sourceLine}`.trim();
  }
  if (focusKind === "claim") {
    return `${capitalizePhrase(focusPhrase)} has become a concrete claim.${sourceLine}`.trim();
  }
  return `${capitalizePhrase(focusPhrase)} remains an unresolved question.${sourceLine}`.trim();
}

function topConceptKeywords(text, limit) {
  const counts = new Map();

  for (const token of tokenize(text)) {
    if (stopwords.has(token) || labelNoiseTokens.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return right[0].length - left[0].length;
    })
    .slice(0, limit)
    .map(([token]) => token);
}

function capitalizePhrase(value) {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized[0].toUpperCase() + normalized.slice(1) : value;
}

function getValueObjects(values) {
  return ensureArray(values).filter(isObject);
}

function mapCountEntries(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => right.count - left.count);
}

