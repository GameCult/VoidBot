import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_VECTOR_DIMENSIONS = 96;
const MAX_EDGE_COUNT = 24;
const MAX_CLUSTER_COUNT = 8;
const MAX_INCUBATING_THOUGHTS = 8;
const MAX_RECENT_EPISODIC_RECORDS = 10;
const MAX_RECENT_QUIET_EPISODIC_RECORDS = 2;
const MAX_POST_NAP_EPISODIC_RECORDS = 4;
const MAX_POST_NAP_QUIET_EPISODIC_RECORDS = 1;
const MAX_POST_NAP_ARCHIVE_EXCURSIONS = 3;
const MAX_POST_NAP_REPO_SWEEPS = 3;
const MAX_POST_NAP_NOVELTY_CHECKS = 3;
const MAX_POST_NAP_MUSINGS = 6;
const MAX_POST_NAP_RECENT_MUSINGS = 2;
const MAX_POST_NAP_CANDIDATE_INTERVENTIONS = 4;
const MAX_POST_NAP_SEAM_PROMOTIONS = 3;
const MAX_RECENT_ANALYTIC_THREADS = 6;
const MAX_RECENT_QUIET_ANALYTIC_THREADS = 1;
const EDGE_SIMILARITY_THRESHOLD = 0.56;
const CLUSTER_SIMILARITY_THRESHOLD = 0.64;
const TOPIC_MATCH_THRESHOLD = 0.42;
const REFRACTORY_MATCH_THRESHOLD = 0.48;
const MAX_TOPIC_SATURATION_COUNT = 6;
const MAX_REFRACTORY_TOPIC_COUNT = 6;
const stopwords = new Set([
  "a",
  "about",
  "after",
  "against",
  "all",
  "also",
  "an",
  "and",
  "another",
  "are",
  "around",
  "as",
  "at",
  "because",
  "been",
  "before",
  "being",
  "between",
  "but",
  "by",
  "can",
  "current",
  "did",
  "discord",
  "do",
  "does",
  "doing",
  "for",
  "from",
  "fresh",
  "get",
  "got",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "keep",
  "keeps",
  "kind",
  "last",
  "like",
  "live",
  "made",
  "make",
  "means",
  "message",
  "messages",
  "more",
  "most",
  "new",
  "no",
  "not",
  "now",
  "of",
  "on",
  "one",
  "owner",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "post",
  "posted",
  "quiet",
  "recent",
  "run",
  "same",
  "saved",
  "seam",
  "should",
  "small",
  "so",
  "still",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "they",
  "thing",
  "this",
  "thought",
  "traffic",
  "through",
  "to",
  "too",
  "toward",
  "under",
  "up",
  "use",
  "using",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "worth",
  "would",
  "yet",
  "you",
  "smoke",
]);

export async function reconcileSemanticMemoryState({
  state,
  now = new Date(),
  repoRootPath = repoRoot,
} = {}) {
  const runtime = ensureObject(state.moderation_runtime);
  const memories = ensureObject(state.memories);
  const sleepCycle = ensureObject(runtime.sleep_cycle);
  const records = collectMemoryRecords({ state, memories, runtime });
  const previousBridge = ensureObject(runtime.bridge);
  const sourceCoverage = buildSourceCoverage({ runtime, now });
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
    embeddingBackend: embedder.backend,
    embeddingModel: embedder.model,
  };
}

function collectMemoryRecords({ memories, runtime }) {
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
    const keywords = topKeywords(items.map((item) => item.text).join(" "), 4);
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
    const evidenceRefs = [...new Set(items.flatMap((item) => ensureStringArray(item.sourceRefs)))];
    const evidenceDiversity = clamp(
      sourceKinds.length * 0.18 +
        repoNames.length * 0.17 +
        archiveYears.length * 0.11 +
        channelIds.length * 0.08 +
        Math.min(1, evidenceRefs.length / 8) * 0.16,
      0,
      1,
    );
    const label = keywords.length > 0 ? keywords.join(" / ") : `${sourceKinds.join(" + ")} seam`;
    const summary = `Recurring seam across ${sourceKinds.join(", ")}${keywords.length > 0 ? ` around ${keywords.join(", ")}` : ""}.`;

    clusters.push({
      clusterId: `cluster-${hashString(componentIds.sort().join("|")).slice(0, 12)}`,
      label,
      summary,
      resonance: round3(resonance),
      memoryIds: items.map((item) => item.memoryId),
      sourceKinds,
      topKeywords: keywords,
      repoNames,
      archiveYears,
      channelIds,
      evidenceRefs,
      evidenceDiversity: round3(evidenceDiversity),
      quietSignalRatio: round3(quietSignalRatio),
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

function reconcileIncubation({ previous, bridge, clusters, runtime, sourceCoverage, now }) {
  bridge = ensureObject(bridge);
  sourceCoverage = ensureObject(sourceCoverage);
  const priorThoughts = ensureArray(previous.active_thoughts).filter(isObject);
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
    const noveltyToSelf = computeNoveltyToSelf({
      cluster,
      previousThoughts: priorThoughts,
      bridge,
      currentThoughtId: readString(previousThought, "thoughtId"),
    });
    const noveltyToRoom = computeNoveltyToRoom(cluster, recentNoveltyChecks);
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
        cluster.resonance * 0.18 +
        sourceDiversity * 0.12 +
        evidenceDiversity * 0.16 +
        explorationBonus * 0.14 +
        Math.min(1, supportCount / 10) * 0.08 +
        noveltyToSelf * 0.08 +
        noveltyToRoom * 0.08 -
        saturationMetrics.score * 0.18 -
        quietSignalRatio * 0.24 -
        refractoryPenalty * 0.12,
      0,
      1,
    );
    const novelty = clamp(
      noveltyToSelf * 0.55 + noveltyToRoom * 0.45 + quietNovelty * 0.08 - quietSignalRatio * 0.1,
      0,
      1,
    );
    const desireToSpeak = clamp(
      cluster.resonance * 0.18 +
        maturation * 0.17 +
        noveltyToRoom * 0.16 +
        noveltyToSelf * 0.11 +
        evidenceDiversity * 0.1 +
        explorationBonus * 0.11 +
        needToSpeak * 0.13 +
        quietNovelty * 0.08 -
        recentSpeechDamping * 0.19 -
        quietSignalRatio * 0.19 -
        saturationMetrics.score * 0.21 -
        (1 - noveltyToSelf) * 0.08 -
        refractoryPenalty,
      0,
      1,
    );
    const status =
      quietSignalRatio >= 0.55 && desireToSpeak < 0.68
        ? "cooling"
        : noveltyToSelf < 0.28 && saturationMetrics.score >= 0.62
          ? "stalled"
        : refractoryPenalty >= 0.18 && noveltyToRoom < 0.72
          ? "refractory"
        : supportCount >= 6 && evidenceDiversity < 0.34
          ? "stalled"
        : supportCount >= 3 && noveltyToSelf < 0.55
          ? "cooling"
        : saturationMetrics.score >= 0.56 && noveltyToSelf < 0.42
          ? "cooling"
        : ((desireToSpeak >= 0.74 && (noveltyToSelf >= 0.55 || noveltyToRoom >= 0.82)) &&
            saturationMetrics.score < 0.5) ||
          maturation >= 0.82
        ? "ripe"
        : maturation <= 0.28 && recentSpeechDamping >= 0.55
          ? "cooling"
          : "incubating";

    const priorityScore = clamp(
      desireToSpeak * 0.36 +
        noveltyToSelf * 0.2 +
        noveltyToRoom * 0.18 +
        evidenceDiversity * 0.12 +
        explorationBonus * 0.14 -
        saturationMetrics.score * 0.14 -
        refractoryPenalty * 0.12,
      0,
      1,
    );

    return {
      thoughtId: readString(previousThought, "thoughtId") ?? cluster.clusterId,
      topic: cluster.label,
      summary: cluster.summary,
      sourceMemoryIds: cluster.memoryIds,
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
      explorationBonus: round3(explorationBonus),
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

  const theme = readString(strongestThought, "topic") ?? "unlabeled seam";
  const summary = `Dream-compressed a seam around ${theme}. ${readString(strongestThought, "latentQuestion") ?? "It still wants another pass before speech."}`;
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
    distilledFrom: ensureStringArray(strongestThought.sourceMemoryIds),
    salience: round3(
      clamp(
        (readNumber(strongestThought, "maturation") ?? 0.4) * 0.55 +
          (readNumber(strongestThought, "resonance") ?? 0.4) * 0.45,
        0,
        1,
      ),
    ),
  });

  memories.dreams = dreams.slice(-12);
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
  runtime.candidate_interventions = ensureArray(runtime.candidate_interventions)
    .filter(isObject)
    .slice(-MAX_POST_NAP_CANDIDATE_INTERVENTIONS);

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
    const topic = readString(thought, "topic");
    const summary = readString(thought, "summary");
    if (!topic || !summary) {
      continue;
    }

    const cluster = clusterByLabel.get(topic);
    const distilledSummary = buildDistilledSeamSummary({ thought, cluster });
    const subjectId = `seam:${hashString(topic).slice(0, 12)}`;
    const sourceRefs = [
      ...ensureStringArray(thought.sourceMemoryIds),
      ...(cluster ? ensureStringArray(cluster.memoryIds) : []),
    ];
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

  memories.semantic = semanticMemories.slice(-40);
  return promoted;
}

function buildDistilledSeamSummary({ thought, cluster }) {
  const summary = readString(thought, "summary") ?? "Unlabeled seam.";
  const latentQuestion = readString(thought, "latentQuestion");
  const sourceKinds = cluster ? ensureStringArray(cluster.sourceKinds) : [];
  const sourceLine =
    sourceKinds.length >= 2
      ? ` Built from ${sourceKinds.join(", ")} rather than a single lane talking to itself.`
      : "";

  return `${summary}${latentQuestion ? ` ${latentQuestion}` : ""}${sourceLine}`.trim();
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
  if (cluster.sourceKinds.includes("repo_sweep") && cluster.sourceKinds.includes("archive_excursion")) {
    return "Which old seam is the current work rediscovering, and does the room need that connection yet?";
  }

  if (cluster.sourceKinds.includes("dream") || cluster.sourceKinds.includes("musing")) {
    return "What part of this thought wants embodiment instead of another backstage note?";
  }

  return "What is this seam actually trying to become if it survives another pass?";
}

function buildAttractionLine(cluster, { noveltyToSelf, evidenceDiversity }) {
  if (noveltyToSelf >= 0.62 && evidenceDiversity >= 0.45) {
    return "It keeps pulling because it is still finding genuinely different evidence instead of merely changing hats.";
  }

  if (cluster.sourceKinds.length >= 3) {
    return `It keeps pulling because it is showing up in several different organs at once: ${cluster.sourceKinds.join(", ")}.`;
  }

  return `It keeps pulling because ${cluster.sourceKinds.join(" and ")} are rhyming instead of staying in their lanes.`;
}

function buildHoldingLine({ cluster, status, recentSpeechDamping, saturationScore, noveltyToSelf, explorationBonus }) {
  const quietSignalRatio = readNumber(cluster, "quietSignalRatio") ?? 0;

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
    return "This seam has enough connective tissue that silence should be a choice, not a reflex.";
  }

  if (recentSpeechDamping >= 0.45) {
    return "Recent speech already scratched the itch a bit; let the seam deepen before another confession.";
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

  if (scores.length === 0) {
    return hasPrimaryExplorationSource ? 0.24 : 0.12;
  }

  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return clamp(
    hasPrimaryExplorationSource ? average : Math.min(0.3, average * 0.5),
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
  const sourceMatch = overlapRatio(cluster.memoryIds, ensureArray(sourceMemoryIds));
  return Math.max(topicMatch, summaryMatch * 0.9, sourceMatch * 0.95);
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
  const leftTokens = topKeywords(left ?? "", 6);
  const rightTokens = topKeywords(right ?? "", 6);
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

function mapCountEntries(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => right.count - left.count);
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
  const repoNames = ensureStringArray(entry.repoNames);
  if (repoNames.length > 0) {
    sourceMeta.repoNames = repoNames;
  }

  const channelId = readString(entry, "channelId");
  if (channelId) {
    sourceMeta.channelId = channelId;
  }

  const archiveTimestamp =
    readString(entry, "anchorTimestamp") ??
    readString(entry, "sourceTimestamp") ??
    readString(entry, "timestamp");
  const archiveYear = extractYear(archiveTimestamp);
  if (archiveYear) {
    sourceMeta.archiveYear = archiveYear;
  }

  if (kind === "bridge_synthesis") {
    const dominantTopics = ensureStringArray(entry.dominantTopics);
    if (dominantTopics.length > 0) {
      sourceMeta.dominantTopics = dominantTopics;
    }
  }

  return sourceMeta;
}

function extractYear(timestamp) {
  if (typeof timestamp !== "string" || timestamp.length < 4) {
    return undefined;
  }
  const match = timestamp.match(/^(\d{4})-/);
  return match ? match[1] : undefined;
}

function createEmbedder({ repoRootPath }) {
  const env = parseDotEnvSafe(resolve(repoRootPath, ".env"));
  const backend = env.RAG_EMBEDDING_BACKEND === "hash" ? "hash" : "ollama";
  const dimensions = readInt(env.VOID_MEMORY_VECTOR_DIMENSIONS, DEFAULT_VECTOR_DIMENSIONS);

  if (backend === "ollama") {
    return {
      backend: "ollama",
      model: env.RAG_OLLAMA_MODEL?.trim() || "qwen3-embedding:0.6b",
      dimensions,
      baseUrl: normalizeBaseUrl(env.RAG_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"),
      async embed(text) {
        try {
          const response = await fetch(`${this.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: this.model,
              input: [text],
            }),
          });

          if (!response.ok) {
            throw new Error(`Ollama responded ${response.status}`);
          }

          const payload = await response.json();
          const raw = Array.isArray(payload?.embeddings) ? payload.embeddings[0] : undefined;
          if (!Array.isArray(raw) || raw.length === 0) {
            throw new Error("No embedding returned.");
          }

          return compactVector(raw.map(Number), dimensions);
        } catch {
          this.backend = "hash";
          this.model = `hash:${dimensions}`;
          return hashVector(text, dimensions);
        }
      },
    };
  }

  return {
    backend: "hash",
    model: `hash:${dimensions}`,
    dimensions,
    async embed(text) {
      return hashVector(text, dimensions);
    },
  };
}

function compactVector(values, targetDimensions) {
  if (values.length === targetDimensions) {
    return normalizeVector(values);
  }

  const compacted = new Array(targetDimensions).fill(0);

  for (let index = 0; index < targetDimensions; index += 1) {
    const start = Math.floor((index * values.length) / targetDimensions);
    const end = Math.floor(((index + 1) * values.length) / targetDimensions);
    const slice = values.slice(start, Math.max(start + 1, end));
    compacted[index] =
      slice.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) /
      Math.max(1, slice.length);
  }

  return normalizeVector(compacted);
}

function hashVector(text, dimensions) {
  const terms = tokenize(text);

  if (terms.length === 0) {
    return new Array(dimensions).fill(0);
  }

  const vector = new Array(dimensions).fill(0);

  for (const term of terms) {
    const hash = createHash("sha1").update(term).digest();
    const index = hash.readUInt32BE(0) % dimensions;
    const sign = hash[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  return normalizeVector(vector);
}

function averagePairwiseSimilarity(items) {
  if (items.length < 2) {
    return 0;
  }

  let total = 0;
  let count = 0;

  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      total += cosineSimilarity(items[leftIndex].entry.semanticVector.values, items[rightIndex].entry.semanticVector.values);
      count += 1;
    }
  }

  return count === 0 ? 0 : total / count;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function topKeywords(text, limit) {
  const counts = new Map();

  for (const token of tokenize(text)) {
    if (stopwords.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([token]) => token);
}

function tokenize(input) {
  return String(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

function ensureMemoryId(entry, kind, text) {
  const existing = readString(entry, "memoryId");
  if (existing) {
    return existing;
  }

  const timestamp = readString(entry, "timestamp") ?? readString(entry, "lastObservedAt") ?? "undated";
  return `${kind}-${hashString(`${timestamp}|${text}`).slice(0, 12)}`;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function selectRecentRecords(entries, { limit, quietLimit }) {
  const recent = ensureArray(entries).slice(-Math.max(limit * 3, limit));
  const quiet = [];
  const active = [];

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index];
    if (!isObject(entry)) {
      continue;
    }

    const text = normalizeText([
      readString(entry, "summary"),
      readString(entry, "claim"),
      readString(entry, "topic"),
      readString(entry, "counterweight"),
    ].filter(Boolean).join(" | "));

    if (isLowSignalQuietRoomText(text)) {
      if (quiet.length < quietLimit) {
        quiet.unshift(entry);
      }
      continue;
    }

    if (active.length < limit - quietLimit) {
      active.unshift(entry);
    }
  }

  return [...active, ...quiet].slice(-limit);
}

function isLowSignalQuietRoomText(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return false;
  }

  const quietSignals = [
    "no new discord",
    "no fresh discord",
    "no new messages",
    "no fresh live traffic",
    "no live moderation",
    "no moderation smoke",
    "no owner escalation",
    "room was empty",
    "room is idle",
    "there was no live moderation pressure",
    "nothing got posted",
    "no discord post",
  ];

  let matches = 0;
  for (const signal of quietSignals) {
    if (normalized.includes(signal)) {
      matches += 1;
    }
  }

  return matches >= 2;
}

function overlapRatio(left, right) {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  let overlap = 0;

  for (const value of right) {
    if (leftSet.has(value)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(left.length, right.length);
}

function hashString(input) {
  return createHash("sha1").update(String(input)).digest("hex");
}

function parseDotEnvSafe(path) {
  try {
    return parseDotEnv(stripBom(readFileSync(path, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseDotEnv(raw) {
  const result = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(value) {
  return isObject(value) ? value : {};
}

function ensureStringArray(value) {
  return ensureArray(value).filter((entry) => typeof entry === "string");
}

function readString(value, key) {
  return isObject(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function readNumber(value, key) {
  return isObject(value) && typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stripBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
