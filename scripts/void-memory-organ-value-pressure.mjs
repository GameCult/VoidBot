import {
  MAX_ACTIVE_TENSION_COUNT,
  MAX_ADVOCACY_REQUEST_COUNT,
  MAX_DISCOMFORT_COUNT,
  TOPIC_MATCH_THRESHOLD,
} from "./void-memory-organ-constants.mjs";
import {
  appendUniqueString,
  clamp,
  ensureArray,
  ensureObject,
  getValueObjects,
  hashString,
  isObject,
  readNumber,
  readString,
  round3,
  topicSimilarity,
} from "./void-memory-organ-utils.mjs";
import { trimCandidateInterventions, upsertAdvocacyIntervention } from "./void-memory-organ-interventions.mjs";
export function reconcileAgencyState({ state, runtime, incubation, now }) {
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
