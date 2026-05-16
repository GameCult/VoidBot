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
  sanitizePreferredThoughtLabel,
  looksKeywordSalad,
  looksPersonLikeSingleton,
  selectRecentRecords,
  isLowSignalQuietRoomText,
  overlapRatio,
  mergeStringArrays,
  newestIsoTimestamp,
  cloneJson,
  looksLegacyThoughtSurface,
  compactNarrative,
  compactLabel,
  capDistinctStrings,
  compareMemoryFreshness,
  appendClause,
  getValueObjects,
  topicSimilarity,
  topConceptKeywords,
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
import { reconcileLegacyStateMirrors, trimLegacyRuntimeResidue } from "./void-memory-organ-legacy-mirrors.mjs";
import {
  crystallizeIdentityThoughts,
  queueRipeThoughtInterventions,
  reconcileAgencyState,
  trimCandidateInterventions,
} from "./void-memory-organ-agency.mjs";
import {
  ensureSemanticVector,
  buildAssociationEdges,
  buildClusters,
  buildClusterCuriosityProfile,
  extractRepoNameFromLabel,
  synthesizeThoughtSurface,
  capitalizePhrase,
} from "./void-memory-organ-graph.mjs";
import {
  reconcileIncubation,
  buildSourceCoverage,
  reconcileBridgeState,
  buildIdentitySurface,
} from "./void-memory-organ-incubation.mjs";
import { normalizeHistoricalMemorySurfaces } from "./void-memory-organ-cleanup.mjs";
import { distillDreams, consolidateSleepMemory } from "./void-memory-organ-sleep.mjs";

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
