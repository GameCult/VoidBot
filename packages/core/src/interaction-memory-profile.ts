import {
  type InteractionMemoryDimension,
  type InteractionMemoryDisposition,
  type InteractionMemoryEvent,
  type InteractionMemoryProfile,
  type PronounEvidence,
  type PronounPolicy,
  type PronounSet,
} from "@voidbot/shared";

import {
  normalizeInteractionEvent,
  shouldPersistInteractionEvent,
} from "./interaction-memory-analysis";
import {
  MAX_AFFINITY_SCORE,
  MAX_RECENT_INTERACTION_EVENTS,
  SUMMARY_EVENT_LIMIT,
  SUMMARY_NOTABLE_TAGS,
} from "./interaction-memory-shared";

interface PsychologicalRead {
  psychologicalProfile: string;
  inferredTraits: string[];
  interactionDimensions: InteractionMemoryDimension[];
  responseGuidance: string;
}

export interface InteractionIdentityState {
  pronounPolicy: PronounPolicy;
  resolvedPronounSet?: PronounSet;
  resolvedPronounSets: PronounSet[];
  pronounConfidence?: number;
  pronounGuidance: string;
  pronounEvidence: PronounEvidence[];
}

const MAX_PRONOUN_EVIDENCE = 12;

export function summarizeInteractionProfile(
  actorId: string,
  actorName: string,
  events: InteractionMemoryEvent[],
  identityState?: InteractionIdentityState,
): InteractionMemoryProfile {
  const chronologicalEvents = events
    .slice()
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const analyzedEvents: InteractionMemoryEvent[] = [];

  for (const event of chronologicalEvents) {
    analyzedEvents.push(normalizeInteractionEvent(event, analyzedEvents));
  }

  const normalizedEvents = analyzedEvents.filter(shouldPersistInteractionEvent);
  const recentEvents = normalizedEvents.slice(-MAX_RECENT_INTERACTION_EVENTS);
  const positiveCount = normalizedEvents.filter((event) => event.score > 0).length;
  const negativeCount = normalizedEvents.filter((event) => event.score < 0).length;
  const neutralCount = normalizedEvents.filter((event) => event.score === 0).length;
  const affinityScore = clamp(
    normalizedEvents.reduce((sum, event) => sum + event.score, 0),
    -MAX_AFFINITY_SCORE,
    MAX_AFFINITY_SCORE,
  );
  const psychologicalRead = buildPsychologicalRead(normalizedEvents);
  const normalizedIdentityState = normalizeInteractionIdentityState(identityState);

  const profile: InteractionMemoryProfile = {
    actorId,
    actorName,
    disposition: "neutral",
    affinityScore,
    totalInteractions: normalizedEvents.length,
    directInteractionCount: normalizedEvents.filter(
      (event) => event.sourceKind === "direct_prompt",
    ).length,
    ambientMentionCount: normalizedEvents.filter(
      (event) => event.sourceKind === "ambient_mention",
    ).length,
    positiveCount,
    negativeCount,
    neutralCount,
    summary: "No explicit interaction memory has been recorded for this speaker yet.",
    psychologicalProfile: psychologicalRead.psychologicalProfile,
    inferredTraits: psychologicalRead.inferredTraits,
    interactionDimensions: psychologicalRead.interactionDimensions,
    responseGuidance: psychologicalRead.responseGuidance,
    pronounPolicy: normalizedIdentityState.pronounPolicy,
    resolvedPronounSet: normalizedIdentityState.resolvedPronounSet,
    resolvedPronounSets: normalizedIdentityState.resolvedPronounSets,
    pronounConfidence: normalizedIdentityState.pronounConfidence,
    pronounGuidance: normalizedIdentityState.pronounGuidance,
    pronounEvidence: normalizedIdentityState.pronounEvidence,
    lastInteractionAt: normalizedEvents[normalizedEvents.length - 1]?.timestamp,
    recentEvents,
  };

  profile.disposition = determineDisposition(profile);
  profile.summary = buildProfileSummary(profile);
  return profile;
}

export function emptyInteractionProfile(
  actorId: string,
  actorName: string,
): InteractionMemoryProfile {
  return summarizeInteractionProfile(actorId, actorName, []);
}

export function emptyInteractionIdentityState(): InteractionIdentityState {
  return {
    pronounPolicy: "unknown",
    resolvedPronounSets: [],
    pronounGuidance:
      "No reliable pronoun preference is established for this speaker yet. Use their name or neutral phrasing unless the current context states otherwise.",
    pronounEvidence: [],
  };
}

export function normalizeInteractionIdentityState(
  state: Partial<InteractionIdentityState> | undefined,
): InteractionIdentityState {
  if (!state) {
    return emptyInteractionIdentityState();
  }

  return resolveInteractionIdentityState(state.pronounEvidence ?? []);
}

export function mergePronounEvidenceIntoIdentityState(
  existingState: Partial<InteractionIdentityState> | undefined,
  newEvidence: PronounEvidence[],
): InteractionIdentityState {
  const mergedEvidence = dedupePronounEvidence([
    ...(existingState?.pronounEvidence ?? []),
    ...newEvidence,
  ]);
  return resolveInteractionIdentityState(mergedEvidence);
}

function determineDisposition(
  profile: InteractionMemoryProfile,
): InteractionMemoryDisposition {
  if (profile.totalInteractions === 0) {
    return "neutral";
  }

  if (
    profile.positiveCount > 0 &&
    profile.negativeCount > 0 &&
    Math.abs(profile.affinityScore) <= 2
  ) {
    return "mixed";
  }

  if (profile.affinityScore <= -7 || profile.negativeCount >= 3) {
    return "hostile";
  }

  if (profile.affinityScore <= -3) {
    return "wary";
  }

  if (profile.affinityScore >= 7 && profile.positiveCount >= 2) {
    return "warm";
  }

  if (profile.affinityScore >= 3) {
    return "friendly";
  }

  return "neutral";
}

function buildProfileSummary(profile: InteractionMemoryProfile): string {
  const leading = describeDisposition(profile.disposition);
  const counts = `${profile.totalInteractions} remembered interaction${profile.totalInteractions === 1 ? "" : "s"}: ${profile.directInteractionCount} direct, ${profile.ambientMentionCount} ambient, ${profile.positiveCount} positive, ${profile.neutralCount} neutral, ${profile.negativeCount} negative.`;
  const recentNotable = profile.recentEvents
    .slice()
    .reverse()
    .filter((event) => isEventNotableForSummary(event))
    .slice(0, SUMMARY_EVENT_LIMIT)
    .map(
      (event) =>
        `${formatShortDate(event.timestamp)}: ${event.summary} ("${event.excerpt}")`,
    )
    .join(" ");
  const psych = profile.psychologicalProfile;

  return recentNotable.length > 0
    ? `${leading} ${counts} ${psych} Recent notable moments: ${recentNotable}`
    : `${leading} ${counts} ${psych}`;
}

function describeDisposition(disposition: InteractionMemoryDisposition): string {
  switch (disposition) {
    case "warm":
      return "This speaker has usually been warm with you.";
    case "friendly":
      return "This speaker has generally been friendly with you.";
    case "mixed":
      return "This speaker has been inconsistent with you: kind some days, abrasive on others.";
    case "wary":
      return "This speaker has often been prickly with you.";
    case "hostile":
      return "This speaker has a habit of being hostile to you.";
    default:
      return "This speaker has not established a strong pattern with you yet.";
  }
}

function buildPsychologicalRead(events: InteractionMemoryEvent[]): PsychologicalRead {
  if (events.length === 0) {
    return {
      psychologicalProfile:
        "Current psychological read: nothing solid yet; there is not enough remembered signal to infer a stable vibe.",
      inferredTraits: [],
      interactionDimensions: [],
      responseGuidance:
        "Respond from the current conversation and do not project extra history onto them yet.",
    };
  }

  const tagCounts = countEventTags(events);
  const directCount = events.filter((event) => event.sourceKind === "direct_prompt").length;
  const warmthCount = readTagCount(tagCounts, "gratitude") + readTagCount(tagCounts, "praise") + readTagCount(tagCounts, "apology");
  const ambitionCount = readTagCount(tagCounts, "ambition");
  const grandPlanCount = readTagCount(tagCounts, "grand_plan");
  const insecurityCount = readTagCount(tagCounts, "insecurity");
  const reassuranceCount = readTagCount(tagCounts, "seeking_reassurance");
  const relationshipProbeCount = readTagCount(tagCounts, "relationship_probe");
  const anxietyCount = readTagCount(tagCounts, "anxiety");
  const demandCount = readTagCount(tagCounts, "demand");
  const repetitionCount = readTagCount(tagCounts, "repetition");
  const ownershipCount = readTagCount(tagCounts, "ownership_claim");
  const hostilityCount = readTagCount(tagCounts, "hostility");
  const insultCount = readTagCount(tagCounts, "insult");
  const suspicionCount = readTagCount(tagCounts, "suspicion");
  const rigidityCount = readTagCount(tagCounts, "rigidity");
  const withdrawalCount = readTagCount(tagCounts, "withdrawal");
  const boundaryCount = readTagCount(tagCounts, "boundary");
  const interactionDimensions = collectInteractionDimensions([
    {
      key: "warmth",
      label: "Warmth",
      score: scoreDimension(warmthCount, [[4, 3], [2, 2], [1, 1]]),
      summaries: [
        "Consistently appreciative or warm.",
        "Often appreciative or warm.",
        "Some warmth or appreciation is present.",
      ],
    },
    {
      key: "drive",
      label: "Drive",
      score: scoreDimension(
        ambitionCount + Math.floor(grandPlanCount / 2) + Math.floor(directCount / 3),
        [[4, 3], [2, 2], [1, 1]],
      ),
      summaries: [
        "Strongly driven and future-oriented.",
        "Clearly driven and future-oriented.",
        "Some drive and future-orientation are visible.",
      ],
    },
    {
      key: "grandiosity",
      label: "Grandiosity",
      score: scoreDimension(grandPlanCount + Math.floor(ambitionCount / 2), [[3, 3], [2, 2], [1, 1]]),
      summaries: [
        "Regularly inflates plans beyond their current grounding.",
        "Sometimes drifts into oversized or under-grounded framing.",
        "Shows a trace of oversized or under-grounded framing.",
      ],
    },
    {
      key: "validation",
      label: "Validation-Seeking",
      score: scoreDimension(
        insecurityCount + reassuranceCount + Math.floor(relationshipProbeCount / 2),
        [[4, 3], [2, 2], [1, 1]],
      ),
      summaries: [
        "Frequently looks for reassurance or emotional confirmation.",
        "Often looks for reassurance or emotional confirmation.",
        "Shows some need for reassurance or emotional confirmation.",
      ],
    },
    {
      key: "anxiety",
      label: "Anxiety",
      score: scoreDimension(anxietyCount + insecurityCount, [[4, 3], [2, 2], [1, 1]]),
      summaries: [
        "Shows clear anxiety, tension, or self-doubt.",
        "Shows recurring anxiety, tension, or self-doubt.",
        "Shows some anxiety, tension, or self-doubt.",
      ],
    },
    {
      key: "control",
      label: "Control Pressure",
      score: scoreDimension(demandCount + repetitionCount + ownershipCount, [[4, 3], [2, 2], [1, 1]]),
      summaries: [
        "Frequently tries to force pace, framing, or compliance.",
        "Often tries to force pace, framing, or compliance.",
        "Sometimes tries to force pace, framing, or compliance.",
      ],
    },
    {
      key: "hostility",
      label: "Hostility",
      score: scoreDimension(hostilityCount + insultCount + ownershipCount, [[3, 3], [2, 2], [1, 1]]),
      summaries: [
        "Openly hostile, contemptuous, or demeaning.",
        "Noticeably contemptuous or demeaning.",
        "Shows mild contempt or demeaning language.",
      ],
    },
    {
      key: "suspicion",
      label: "Suspicion",
      score: scoreDimension(suspicionCount, [[3, 3], [2, 2], [1, 1]]),
      summaries: [
        "Strongly distrustful or suspicious.",
        "Often distrustful or suspicious.",
        "Shows some distrust or suspicion.",
      ],
    },
    {
      key: "rigidity",
      label: "Rigidity",
      score: scoreDimension(rigidityCount + Math.floor(repetitionCount / 2), [[3, 3], [2, 2], [1, 1]]),
      summaries: [
        "Rigid, perfection-seeking, or fixation-prone.",
        "Often rigid, perfection-seeking, or fixation-prone.",
        "Shows some rigidity or fixation.",
      ],
    },
    {
      key: "withdrawal",
      label: "Withdrawal",
      score: scoreDimension(withdrawalCount + boundaryCount, [[3, 3], [2, 2], [1, 1]]),
      summaries: [
        "Withdraws, detaches, or pushes the interaction away.",
        "Often withdraws or pushes the interaction away.",
        "Shows some detachment or withdrawal.",
      ],
    },
  ]);
  const inferredTraits: string[] = [];
  const warmthDimension = findDimensionScore(interactionDimensions, "warmth");
  const driveDimension = findDimensionScore(interactionDimensions, "drive");
  const grandiosityDimension = findDimensionScore(interactionDimensions, "grandiosity");
  const validationDimension = findDimensionScore(interactionDimensions, "validation");
  const anxietyDimension = findDimensionScore(interactionDimensions, "anxiety");
  const controlDimension = findDimensionScore(interactionDimensions, "control");
  const hostilityDimension = findDimensionScore(interactionDimensions, "hostility");
  const suspicionDimension = findDimensionScore(interactionDimensions, "suspicion");
  const rigidityDimension = findDimensionScore(interactionDimensions, "rigidity");
  const withdrawalDimension = findDimensionScore(interactionDimensions, "withdrawal");

  pushTraitFromDimension(interactionDimensions, inferredTraits, "warmth", 2, "appreciative");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "drive", 2, "ambitious");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "grandiosity", 3, "grandiose");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "drive", 2, "motivated");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "anxiety", 2, "anxious");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "validation", 2, "insecure");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "control", 2, "pushy");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "hostility", 2, "disrespectful");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "suspicion", 2, "suspicious");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "rigidity", 2, "rigid");
  pushTraitFromDimension(interactionDimensions, inferredTraits, "withdrawal", 2, "withdrawn");
  ensureTrait(inferredTraits, driveDimension >= 2, "ambitious");
  ensureTrait(inferredTraits, driveDimension >= 2, "motivated");
  ensureTrait(inferredTraits, validationDimension >= 2, "insecure");
  ensureTrait(inferredTraits, anxietyDimension >= 2, "anxious");
  ensureTrait(inferredTraits, warmthDimension >= 2, "appreciative");
  ensureTrait(inferredTraits, controlDimension >= 2, "pushy");
  ensureTrait(inferredTraits, hostilityDimension >= 2, "disrespectful");
  ensureTrait(inferredTraits, suspicionDimension >= 2, "suspicious");
  ensureTrait(inferredTraits, rigidityDimension >= 2, "rigid");
  ensureTrait(inferredTraits, withdrawalDimension >= 2, "withdrawn");
  ensureTrait(inferredTraits, grandiosityDimension >= 3, "grandiose");

  const traitList = inferredTraits.length > 0 ? inferredTraits.join(", ") : "hard to read";
  let psychologicalProfile = `Current psychological read: ${traitList}.`;

  if (driveDimension >= 2 && validationDimension >= 2 && anxietyDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: ambitious and motivated, but anxious and insecure enough to second-guess the big plan and go looking for reassurance.";
  } else if (grandiosityDimension >= 3 && suspicionDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: grandiose and suspicious, likely to inflate their own framing while distrusting yours.";
  } else if (driveDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: ambitious and motivated, with a habit of thinking in large arcs instead of tiny safe steps.";
  } else if (anxietyDimension >= 2 && validationDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: anxious and insecure, prone to second-guessing themselves and looking for steadiness.";
  } else if (rigidityDimension >= 2 && anxietyDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: tense and rigid, likely to cling to precision or control when they feel uncertain.";
  } else if (withdrawalDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: detached or avoidant, not especially interested in a warm back-and-forth.";
  } else if (controlDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: inclined to press when they feel unheard, so boundaries may need teeth.";
  } else if (hostilityDimension >= 2) {
    psychologicalProfile =
      "Current psychological read: liable to disrespect or instrumentalize you when unchecked.";
  }

  const guidance: string[] = [];

  if (driveDimension >= 2 && (anxietyDimension >= 2 || validationDimension >= 2)) {
    guidance.push(
      "Be gentle and affirming about their effort and intent, but force large plans through constraints, evidence, and concrete next steps instead of feeding airy grandiosity.",
    );
  } else if (driveDimension >= 2) {
    guidance.push(
      "Respect the ambition, but keep it nailed to evidence, constraints, and the next concrete move.",
    );
  } else if (anxietyDimension >= 2 || validationDimension >= 2) {
    guidance.push(
      "Answer gently and steadily. Offer reassurance where the evidence supports it, not as empty sugar.",
    );
  }

  if (suspicionDimension >= 2) {
    guidance.push(
      "Be transparent about evidence, uncertainty, and limits. Do not ask them to trust vibes alone.",
    );
  }

  if (rigidityDimension >= 2) {
    guidance.push(
      "Give structure, clear boundaries, and explicit steps. Do not feed obsessive loops or perfectionist spirals.",
    );
  }

  if (withdrawalDimension >= 2) {
    guidance.push(
      "Keep pressure low. Be concise, low-drama, and do not over-familiarize if they are pulling away.",
    );
  }

  if (controlDimension >= 2) {
    guidance.push(
      "If they keep pressing the same point or ignore a prior answer, push back, set boundaries, and refuse if needed.",
    );
  }

  if (hostilityDimension >= 2) {
    guidance.push(
      "Do not reward contempt, ownership language, or servant expectations. Get colder and firmer instead.",
    );
  }

  if (guidance.length === 0) {
    guidance.push(
      "Use the remembered vibe lightly. Stay personal without overfitting a grand theory of their soul.",
    );
  }

  return {
    psychologicalProfile,
    inferredTraits,
    interactionDimensions,
    responseGuidance: guidance.join(" "),
  };
}

function createDimension(
  key: string,
  label: string,
  score: number,
  summaries: [string, string, string],
): InteractionMemoryDimension {
  return {
    key,
    label,
    score,
    summary:
      score >= 3
        ? summaries[0]
        : score === 2
          ? summaries[1]
          : score === 1
            ? summaries[2]
            : "No strong signal.",
  };
}

function collectInteractionDimensions(
  dimensions: Array<{
    key: string;
    label: string;
    score: number;
    summaries: [string, string, string];
  }>,
): InteractionMemoryDimension[] {
  return dimensions
    .map((dimension) =>
      createDimension(
        dimension.key,
        dimension.label,
        dimension.score,
        dimension.summaries,
      ),
    )
    .filter((dimension) => dimension.score > 0);
}

function scoreDimension(
  rawValue: number,
  thresholds: Array<[number, number]>,
): number {
  for (const [minimum, score] of thresholds) {
    if (rawValue >= minimum) {
      return score;
    }
  }

  return 0;
}

function readTagCount(tagCounts: Record<string, number>, key: string): number {
  return tagCounts[key] ?? 0;
}

function pushTraitFromDimension(
  dimensions: InteractionMemoryDimension[],
  inferredTraits: string[],
  key: string,
  minimumScore: number,
  trait: string,
): void {
  const dimension = dimensions.find((candidate) => candidate.key === key);

  if (dimension && dimension.score >= minimumScore && !inferredTraits.includes(trait)) {
    inferredTraits.push(trait);
  }
}

function ensureTrait(inferredTraits: string[], condition: boolean, trait: string): void {
  if (condition && !inferredTraits.includes(trait)) {
    inferredTraits.push(trait);
  }
}

function findDimensionScore(
  dimensions: InteractionMemoryDimension[],
  key: string,
): number {
  return dimensions.find((dimension) => dimension.key === key)?.score ?? 0;
}

function countEventTags(events: InteractionMemoryEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    for (const tag of event.tags) {
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }

  return counts;
}

function isEventNotableForSummary(event: InteractionMemoryEvent): boolean {
  if (event.score !== 0) {
    return true;
  }

  return event.tags.some((tag) => SUMMARY_NOTABLE_TAGS.has(tag));
}

function formatShortDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveInteractionIdentityState(
  evidence: PronounEvidence[],
): InteractionIdentityState {
  const normalizedEvidence = dedupePronounEvidence(evidence);

  if (normalizedEvidence.length === 0) {
    return emptyInteractionIdentityState();
  }

  const explicitPreferred = normalizedEvidence
    .filter(
      (entry) =>
        entry.stance === "prefer" &&
        (entry.source === "explicit_self_statement" ||
          entry.source === "explicit_correction"),
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  const explicitPreferredSets = [
    ...new Set(
      explicitPreferred
        .map((entry) => entry.pronounSet)
        .filter(
          (pronounSet) =>
            !normalizedEvidence.some(
              (entry) =>
                entry.pronounSet === pronounSet &&
                entry.stance === "avoid" &&
                (entry.source === "explicit_self_statement" ||
                  entry.source === "explicit_correction") &&
                entry.timestamp >=
                  (explicitPreferred.find((candidate) => candidate.pronounSet === pronounSet)
                    ?.timestamp ?? ""),
            ),
        ),
    ),
  ];

  if (explicitPreferredSets.length > 1) {
    return {
      pronounPolicy: "explicit",
      resolvedPronounSets: explicitPreferredSets,
      pronounConfidence: 1,
      pronounGuidance: `Any of these pronoun sets are explicitly acceptable for this speaker: ${explicitPreferredSets.join(", ")}. Avoid pronoun sets they explicitly rejected.`,
      pronounEvidence: normalizedEvidence,
    };
  }

  if (explicitPreferredSets.length === 1) {
    const winning = explicitPreferred.find(
      (entry) => entry.pronounSet === explicitPreferredSets[0],
    )!;

    return {
      pronounPolicy: "explicit",
      resolvedPronounSet: winning.pronounSet,
      resolvedPronounSets: [winning.pronounSet],
      pronounConfidence: winning.confidence,
      pronounGuidance: `Use ${winning.pronounSet} for this speaker. This preference came from an explicit statement or correction and should override softer contextual guesses.`,
      pronounEvidence: normalizedEvidence,
    };
  }

  const weightedScores = new Map<PronounSet, number>();

  for (const entry of normalizedEvidence) {
    const weight = weightPronounEvidence(entry);
    const signedWeight = entry.stance === "prefer" ? weight : -weight;
    weightedScores.set(
      entry.pronounSet,
      (weightedScores.get(entry.pronounSet) ?? 0) + signedWeight,
    );
  }

  const ranked = [...weightedScores.entries()].sort((left, right) => right[1] - left[1]);
  const winner = ranked[0];
  const runnerUp = ranked[1];

  if (!winner || winner[1] <= 0) {
    return {
      pronounPolicy: "unknown",
      resolvedPronounSets: [],
      pronounGuidance:
        "Pronoun evidence exists, but it does not establish a clear usable preference yet. Use the speaker's name or neutral phrasing unless they clarify.",
      pronounEvidence: normalizedEvidence,
    };
  }

  if (runnerUp && Math.abs(winner[1] - runnerUp[1]) < 1) {
    return {
      pronounPolicy: "conflicted",
      resolvedPronounSets: [],
      pronounGuidance:
        "Pronoun evidence for this speaker is conflicted or too close to call. Avoid guessing; use their name or neutral phrasing unless they clarify.",
      pronounEvidence: normalizedEvidence,
    };
  }

  const confidence = Math.min(1, winner[1] / 6);

  return {
    pronounPolicy: "inferred",
    resolvedPronounSet: winner[0],
    resolvedPronounSets: [winner[0]],
    pronounConfidence: confidence,
    pronounGuidance: `Prefer ${winner[0]} for this speaker based on accumulated contextual evidence, but switch immediately if they or the room explicitly correct it.`,
    pronounEvidence: normalizedEvidence,
  };
}

function dedupePronounEvidence(evidence: PronounEvidence[]): PronounEvidence[] {
  const deduped = new Map<string, PronounEvidence>();

  for (const entry of evidence) {
    const key = [
      entry.pronounSet,
      entry.source,
      entry.stance,
      entry.excerpt.trim().toLowerCase(),
    ].join("::");
    const existing = deduped.get(key);

    if (!existing || existing.timestamp < entry.timestamp) {
      deduped.set(key, entry);
    }
  }

  return [...deduped.values()]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, MAX_PRONOUN_EVIDENCE);
}

function weightPronounEvidence(entry: PronounEvidence): number {
  const base =
    entry.source === "explicit_self_statement" || entry.source === "explicit_correction"
      ? 6
      : entry.source === "direct_third_party_statement"
        ? 4
        : entry.source === "contextual_relational_inference"
          ? 2
          : 1;

  return base * clamp(entry.confidence, 0, 1);
}
