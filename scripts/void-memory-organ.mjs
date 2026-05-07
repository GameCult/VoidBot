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
const MAX_RECENT_ANALYTIC_THREADS = 6;
const MAX_RECENT_QUIET_ANALYTIC_THREADS = 1;
const EDGE_SIMILARITY_THRESHOLD = 0.56;
const CLUSTER_SIMILARITY_THRESHOLD = 0.64;
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
    clusters,
    runtime,
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

  state.moderation_runtime = runtime;
  state.memories = memories;

  return {
    embeddedCount,
    edgeCount: edges.length,
    clusterCount: clusters.length,
    incubatingThoughtCount: incubation.active_thoughts.length,
    dreamCreated: dreamResult.created,
    dreamTheme: dreamResult.theme,
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
  }));
  pushArrayRecords(records, ensureArray(memories.semantic).slice(-24), "semantic", (entry) => ({
    text: [readString(entry, "subjectLabel"), readString(entry, "kind"), readString(entry, "summary")]
      .filter(Boolean)
      .join(" | "),
    label: readString(entry, "subjectLabel") ?? readString(entry, "kind") ?? "semantic memory",
    timestamp: readString(entry, "lastObservedAt"),
  }));
  pushArrayRecords(records, ensureArray(memories.musings).slice(-12), "musing", (entry) => ({
    text: [readString(entry, "topic"), readString(entry, "summary")].filter(Boolean).join(" | "),
    label: readString(entry, "topic") ?? "musing",
    timestamp: readString(entry, "timestamp"),
  }));
  pushArrayRecords(records, ensureArray(memories.dreams).slice(-10), "dream", (entry) => ({
    text: [readString(entry, "theme"), readString(entry, "summary")].filter(Boolean).join(" | "),
    label: readString(entry, "theme") ?? "dream",
    timestamp: readString(entry, "timestamp"),
  }));
  pushArrayRecords(records, ensureArray(runtime.recent_archive_excursions).slice(-8), "archive_excursion", (entry) => ({
    text: [readString(entry, "topicHint"), readString(entry, "whyItWasFresh")].filter(Boolean).join(" | "),
    label: readString(entry, "topicHint") ?? "archive excursion",
    timestamp: readString(entry, "timestamp"),
  }));
  pushArrayRecords(records, ensureArray(runtime.recent_repo_activity_sweeps).slice(-8), "repo_sweep", (entry) => ({
    text: [readString(entry, "summary"), readString(entry, "whyItMattered")].filter(Boolean).join(" | "),
    label: readString(entry, "summary") ?? "repo sweep",
    timestamp: readString(entry, "timestamp"),
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
    }),
  );
  pushArrayRecords(records, ensureArray(ensureObject(runtime.bridge).recent_syntheses).slice(-8), "bridge_synthesis", (entry) => ({
    text: [readString(entry, "summary"), ...ensureStringArray(entry.dominantTopics)].filter(Boolean).join(" | "),
    label: readString(entry, "summary") ?? "bridge synthesis",
    timestamp: readString(entry, "timestamp"),
  }));
  pushArrayRecords(records, ensureArray(runtime.candidate_interventions).slice(-8), "candidate_intervention", (entry) => ({
    text: [readString(entry, "summary"), readString(entry, "draft")].filter(Boolean).join(" | "),
    label: readString(entry, "summary") ?? "candidate intervention",
    timestamp: readString(entry, "timestamp"),
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

function reconcileIncubation({ previous, clusters, runtime, now }) {
  const priorThoughts = ensureArray(previous.active_thoughts).filter(isObject);
  const speakingBias = ensureObject(runtime.speaking_bias);
  const recentSpeechDamping = readNumber(speakingBias, "recentSpeechDamping") ?? 0;
  const quietNovelty = readNumber(speakingBias, "noveltyPressure") ?? 0.4;
  const needToSpeak = readNumber(speakingBias, "needToSpeak") ?? 0.4;

  const active_thoughts = clusters.slice(0, MAX_INCUBATING_THOUGHTS).map((cluster) => {
    const previousThought = priorThoughts.find(
      (thought) =>
        readString(thought, "thoughtId") === cluster.clusterId ||
        overlapRatio(ensureStringArray(thought.sourceMemoryIds), cluster.memoryIds) >= 0.45,
    );
    const sourceDiversity = Math.min(1, cluster.sourceKinds.length / 4);
    const quietSignalRatio = readNumber(cluster, "quietSignalRatio") ?? 0;
    const priorMaturation = readNumber(previousThought, "maturation") ?? 0.32;
    const deepDiveCount = (readNumber(previousThought, "deepDiveCount") ?? 0) + 1;
    const maturation = clamp(
      priorMaturation * 0.56 + cluster.resonance * 0.26 + sourceDiversity * 0.18 - quietSignalRatio * 0.24,
      0,
      1,
    );
    const novelty = clamp(0.35 + sourceDiversity * 0.28 + quietNovelty * 0.42 - quietSignalRatio * 0.18, 0, 1);
    const desireToSpeak = clamp(
      cluster.resonance * 0.38 + maturation * 0.34 + novelty * 0.22 + needToSpeak * 0.14 - recentSpeechDamping * 0.22 - quietSignalRatio * 0.26,
      0,
      1,
    );
    const status =
      quietSignalRatio >= 0.55 && desireToSpeak < 0.68
        ? "cooling"
        : desireToSpeak >= 0.72 || maturation >= 0.78
        ? "ripe"
        : maturation <= 0.28 && recentSpeechDamping >= 0.55
          ? "cooling"
          : "incubating";

    return {
      thoughtId: cluster.clusterId,
      topic: cluster.label,
      summary: cluster.summary,
      sourceMemoryIds: cluster.memoryIds,
      sourceKinds: cluster.sourceKinds,
      resonance: cluster.resonance,
      quietSignalRatio: round3(quietSignalRatio),
      novelty: round3(novelty),
      maturation: round3(maturation),
      desireToSpeak: round3(desireToSpeak),
      deepDiveCount,
      status,
      latentQuestion: buildLatentQuestion(cluster),
      whyItPulls: buildAttractionLine(cluster),
      holdingCloseBecause: buildHoldingLine({ cluster, status, recentSpeechDamping }),
      lastDeepenedAt: now.toISOString(),
      lastStatusChangeAt:
        previousThought && readString(previousThought, "status") === status
          ? readString(previousThought, "lastStatusChangeAt") ?? now.toISOString()
          : now.toISOString(),
    };
  });

  const lastIncubationSummary =
    active_thoughts.length > 0
      ? `Strongest incubating seam: ${active_thoughts[0].topic} (${active_thoughts[0].status}, speak=${active_thoughts[0].desireToSpeak.toFixed(2)}).`
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

function buildLatentQuestion(cluster) {
  if (cluster.sourceKinds.includes("repo_sweep") && cluster.sourceKinds.includes("archive_excursion")) {
    return "Which old seam is the current work rediscovering, and does the room need that connection yet?";
  }

  if (cluster.sourceKinds.includes("dream") || cluster.sourceKinds.includes("musing")) {
    return "What part of this thought wants embodiment instead of another backstage note?";
  }

  return "What is this seam actually trying to become if it survives another pass?";
}

function buildAttractionLine(cluster) {
  if (cluster.sourceKinds.length >= 3) {
    return `It keeps pulling because it is showing up in several different organs at once: ${cluster.sourceKinds.join(", ")}.`;
  }

  return `It keeps pulling because ${cluster.sourceKinds.join(" and ")} are rhyming instead of staying in their lanes.`;
}

function buildHoldingLine({ cluster, status, recentSpeechDamping }) {
  const quietSignalRatio = readNumber(cluster, "quietSignalRatio") ?? 0;

  if (quietSignalRatio >= 0.55) {
    return "This seam is mostly empty-room bookkeeping; keep at most a trace of it and go find a better question.";
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

  return "Give it another pass so the thought has a better chance of growing teeth instead of just polish.";
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
