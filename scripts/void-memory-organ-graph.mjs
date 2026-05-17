import {
  MAX_EDGE_COUNT,
  MAX_CLUSTER_COUNT,
  MAX_SUPPORTING_REFS,
  MAX_CLUSTER_MEMORY_IDS,
  EDGE_SIMILARITY_THRESHOLD,
  CLUSTER_SIMILARITY_THRESHOLD,
  stopwords,
  labelNoiseTokens,
  averagePairwiseSimilarity,
  cosineSimilarity,
  topKeywords,
  topConceptKeywords,
  normalizeText,
  sanitizePreferredThoughtLabel,
  compactNarrative,
  capDistinctStrings,
  ensureStringArray,
  readString,
  readBoolean,
  round3,
  round4,
  clamp,
  hashString,
  isObject,
} from "./void-memory-organ-shared.mjs";

export async function ensureSemanticVector({ record, embedder, now }) {
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

export function buildAssociationEdges(records) {
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

export function buildClusters(records, edges) {
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

export function buildClusterCuriosityProfile({
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

export function extractRepoNameFromLabel(label) {
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

export function synthesizeThoughtSurface({
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
    return "an archive pressure";
  }
  return "an unresolved pressure";
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

export function capitalizePhrase(value) {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized[0].toUpperCase() + normalized.slice(1) : value;
}

function mapCountEntries(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => right.count - left.count);
}
