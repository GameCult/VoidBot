import {
  MAX_SEMANTIC_MEMORIES,
  MAX_DREAM_MEMORIES,
} from "./void-memory-organ-constants.mjs";
import {
  clamp,
  ensureArray,
  ensureStringArray,
  isObject,
  looksKeywordSalad,
  looksLegacyThoughtSurface,
  looksPersonLikeSingleton,
  normalizeText,
  readString,
  sanitizePreferredThoughtLabel,
  topConceptKeywords,
} from "./void-memory-organ-utils.mjs";
import {
  buildClusterCuriosityProfile,
  extractRepoNameFromLabel,
  synthesizeThoughtSurface,
  capitalizePhrase,
} from "./void-memory-organ-graph.mjs";
export function normalizeSemanticMemories({ memories, now }) {
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

export function normalizeDreamMemories({ memories, now }) {
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

export function shouldDropSemanticMemory(entry) {
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

export function hasThoughtSurfaceTemplateSmell(value) {
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
