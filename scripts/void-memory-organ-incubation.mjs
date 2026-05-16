import {
  MAX_INCUBATING_THOUGHTS,
  MAX_INCUBATION_SOURCE_IDS,
  MAX_TOPIC_SATURATION_COUNT,
  MAX_REFRACTORY_TOPIC_COUNT,
  TOPIC_MATCH_THRESHOLD,
  REFRACTORY_MATCH_THRESHOLD,
  ensureArray,
  ensureObject,
  ensureStringArray,
  readString,
  readNumber,
  sanitizePreferredThoughtLabel,
  overlapRatio,
  topicSimilarity,
  getValueObjects,
  mapCountEntries,
  round3,
  clamp,
  isObject,
} from "./void-memory-organ-shared.mjs";
import { extractYear } from "./void-memory-organ-records.mjs";

export function reconcileIncubation({ previous, bridge, clusters, runtime, sourceCoverage, identitySurface, now }) {
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

export function buildSourceCoverage({ runtime, now }) {
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

export function reconcileBridgeState({ previous, activeThoughts, sourceCoverage, now }) {
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

export function buildIdentitySurface({ state, memories }) {
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
