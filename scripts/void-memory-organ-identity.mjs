import {
  MAX_SEMANTIC_MEMORIES,
  MIN_DEEP_DIVES_FOR_IDENTITY_CRYSTALLIZATION,
  MIN_SUPPORT_FOR_IDENTITY_CRYSTALLIZATION,
} from "./void-memory-organ-constants.mjs";
import {
  appendClause,
  appendUniqueString,
  ensureArray,
  ensureObject,
  ensureStringArray,
  hashString,
  isObject,
  normalizeText,
  readNumber,
  readString,
} from "./void-memory-organ-utils.mjs";
import { trimCandidateInterventions } from "./void-memory-organ-interventions.mjs";
export function crystallizeIdentityThoughts({ state, memories, runtime, incubation, now }) {
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

  const summary = `Void may need to say this about ${crystallization.subjectLabel}`;
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
