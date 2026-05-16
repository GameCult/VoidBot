import {
  MAX_POST_NAP_CANDIDATE_INTERVENTIONS,
  TOPIC_MATCH_THRESHOLD,
} from "./void-memory-organ-constants.mjs";
import {
  ensureArray,
  ensureStringArray,
  isObject,
  readNumber,
  readString,
  round3,
} from "./void-memory-organ-utils.mjs";
export function queueRipeThoughtInterventions({ runtime, incubation, now }) {
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

export function upsertAdvocacyIntervention({ candidateInterventions, request, now }) {
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

export function trimCandidateInterventions(entries) {
  const interventions = ensureArray(entries).filter(isObject);
  const sticky = interventions.filter((entry) => entry.mustEventuallyShare === true);
  const ordinary = interventions.filter((entry) => entry.mustEventuallyShare !== true);
  const keepOrdinary = Math.max(0, MAX_POST_NAP_CANDIDATE_INTERVENTIONS - sticky.length);
  return [...sticky.slice(-MAX_POST_NAP_CANDIDATE_INTERVENTIONS), ...ordinary.slice(-keepOrdinary)].slice(
    -MAX_POST_NAP_CANDIDATE_INTERVENTIONS,
  );
}
