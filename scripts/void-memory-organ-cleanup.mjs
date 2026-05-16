import { reconcileLegacyStateMirrors, trimLegacyRuntimeResidue } from "./void-memory-organ-legacy-mirrors.mjs";
import {
  normalizeSemanticMemories,
  normalizeDreamMemories,
} from "./void-memory-organ-legacy-translation.mjs";
import {
  dedupeSemanticMemories,
  dedupeDreamMemories,
  pruneHistoricalSeamMemories,
  pruneDreamMemories,
  trimHistoricalMemoryResidue,
  trimRecentObjectRecords,
} from "./void-memory-organ-retention.mjs";

export { buildConciseThoughtSummary, buildDreamSummary } from "./void-memory-organ-legacy-translation.mjs";
export { trimHistoricalMemoryResidue, trimRecentObjectRecords } from "./void-memory-organ-retention.mjs";

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
