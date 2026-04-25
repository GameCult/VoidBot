import { randomUUID } from "node:crypto";

import {
  type CommandName,
  type InteractionMemoryDisposition,
  type InteractionMemoryEvent,
  type InteractionMemoryProfile,
  type InteractionMemorySentiment,
  type InteractionMemorySourceKind,
} from "@voidbot/shared";

export interface RecordInteractionInput {
  actorId: string;
  actorName: string;
  sourceKind: InteractionMemorySourceKind;
  guildId?: string;
  channelId: string;
  channelName?: string;
  command?: CommandName;
  prompt: string;
  timestamp?: string;
  eventId?: string;
}

interface ToneAnalysis {
  sentiment: InteractionMemorySentiment;
  score: number;
  tags: string[];
}

interface RepetitionAnalysis {
  matchCount: number;
}

interface PsychologicalRead {
  psychologicalProfile: string;
  inferredTraits: string[];
  responseGuidance: string;
}

export const MAX_RECENT_INTERACTION_EVENTS = 24;
const MAX_AFFINITY_SCORE = 12;
const SUMMARY_EVENT_LIMIT = 3;
const REPETITION_LOOKBACK_EVENTS = 8;
const REPETITION_LOOKBACK_HOURS = 12;
const SIGNIFICANT_INTERACTION_TAGS = new Set<string>([
  "gratitude",
  "praise",
  "apology",
  "hostility",
  "insult",
  "ownership_claim",
  "demand",
  "repetition",
  "identity_query",
  "relationship_probe",
  "boundary",
  "ambition",
  "grand_plan",
  "anxiety",
  "insecurity",
]);
const SUMMARY_NOTABLE_TAGS = new Set<string>([
  "gratitude",
  "praise",
  "apology",
  "hostility",
  "insult",
  "ownership_claim",
  "demand",
  "repetition",
  "identity_query",
  "relationship_probe",
  "boundary",
  "ambition",
  "grand_plan",
  "anxiety",
  "insecurity",
]);
const PROMPT_SIGNATURE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "do",
  "does",
  "for",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "what",
  "why",
  "you",
  "your",
]);

export function buildInteractionMemoryEvent(
  input: RecordInteractionInput,
  priorEvents: InteractionMemoryEvent[] = [],
): InteractionMemoryEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const prompt = input.prompt.trim();
  const analysis = analyzeInteractionTone(prompt, input.sourceKind, timestamp, priorEvents);

  return {
    id: input.eventId ?? randomUUID(),
    actorId: input.actorId,
    actorName: input.actorName,
    sourceKind: input.sourceKind,
    guildId: input.guildId,
    channelId: input.channelId,
    channelName: input.channelName,
    command: input.command,
    prompt,
    excerpt: buildExcerpt(prompt),
    summary: buildEventSummary(input.sourceKind, analysis.sentiment, new Set(analysis.tags)),
    sentiment: analysis.sentiment,
    score: analysis.score,
    tags: analysis.tags,
    timestamp,
  };
}

export function shouldPersistInteractionEvent(event: InteractionMemoryEvent): boolean {
  if (event.sourceKind === "ambient_mention") {
    return true;
  }

  if (event.score !== 0) {
    return true;
  }

  return event.tags.some((tag) => SIGNIFICANT_INTERACTION_TAGS.has(tag));
}

export function summarizeInteractionProfile(
  actorId: string,
  actorName: string,
  events: InteractionMemoryEvent[],
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
    responseGuidance: psychologicalRead.responseGuidance,
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

export function normalizeInteractionEvent(
  event: InteractionMemoryEvent,
  priorEvents: InteractionMemoryEvent[] = [],
): InteractionMemoryEvent {
  const sourceKind = event.sourceKind ?? "direct_prompt";
  const analysis = analyzeInteractionTone(
    event.prompt,
    sourceKind,
    event.timestamp,
    priorEvents,
  );

  return {
    ...event,
    sourceKind,
    summary: buildEventSummary(sourceKind, analysis.sentiment, new Set(analysis.tags)),
    sentiment: analysis.sentiment,
    score: analysis.score,
    tags: analysis.tags,
  };
}

function analyzeInteractionTone(
  prompt: string,
  sourceKind: InteractionMemorySourceKind,
  timestamp: string,
  priorEvents: InteractionMemoryEvent[],
): ToneAnalysis {
  const normalized = ` ${prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
  let score = 0;
  const tags = new Set<string>();
  const isAmbient = sourceKind === "ambient_mention";

  score += matchWeightedPhrases(normalized, tags, 2, "gratitude", [
    " thank you ",
    " thanks ",
    " thx ",
    " appreciate ",
    " grateful ",
  ]);
  score += matchWeightedPhrases(normalized, tags, 2, "praise", [
    " good bot ",
    " love you ",
    " adorable ",
    " clever ",
    " helpful ",
    " well done ",
    " nice work ",
    " great job ",
  ]);
  matchTagPhrases(normalized, tags, "courtesy", [
    " please ",
    " could you ",
    " would you ",
    " if you can ",
  ]);
  score += matchWeightedPhrases(normalized, tags, 1, "apology", [
    " sorry ",
    " apologies ",
    " my bad ",
  ]);

  score -= matchWeightedPhrases(normalized, tags, 2, "insult", [
    " stupid ",
    " idiot ",
    " moron ",
    " dumb ",
    " useless ",
    " worthless ",
    " pathetic ",
    " trash ",
    " garbage ",
  ]);
  score -= matchWeightedPhrases(normalized, tags, 3, "ownership_claim", [
    " my slave ",
    " our slave ",
    " mere tool ",
    " do your job ",
    " you belong to ",
  ]);
  score -= matchWeightedPhrases(normalized, tags, 3, "hostility", [
    " fuck you ",
    " shut up ",
    " bad bot ",
    " hate you ",
    " bitch ",
    " asshole ",
    " cunt ",
  ]);
  score -= matchWeightedPhrases(normalized, tags, 1, "demand", [
    " answer me ",
    " answer the question ",
    " just answer ",
    " stop dodging ",
    " stop evading ",
    " stop being cute ",
    " be useful ",
    " listen ",
    " you didnt answer ",
    " you did not answer ",
    " why wont you answer ",
    " why wont you just ",
  ]);
  matchTagPhrases(normalized, tags, "identity_query", [
    " what are you ",
    " who are you ",
    " are you a person ",
    " are you real ",
    " are you alive ",
    " are you sentient ",
    " do you remember ",
  ]);
  matchTagPhrases(normalized, tags, "relationship_probe", [
    " how do you feel ",
    " what do you think of me ",
    " what do you think about me ",
    " do you like me ",
    " do you trust me ",
    " are we friends ",
  ]);
  matchTagPhrases(normalized, tags, "ambition", [
    " big plan ",
    " big idea ",
    " money play ",
    " save the world ",
    " change the world ",
    " build an empire ",
    " vision ",
    " roadmap ",
    " moonshot ",
    " make this huge ",
    " startup ",
  ]);
  matchTagPhrases(normalized, tags, "grand_plan", [
    " pipe dream ",
    " delusion of grandeur ",
    " world changing ",
    " revolution ",
    " save the world ",
    " moonshot ",
  ]);
  matchTagPhrases(normalized, tags, "anxiety", [
    " anxious ",
    " anxiety ",
    " worried ",
    " worry ",
    " nervous ",
    " afraid ",
    " scared ",
    " terrified ",
    " overwhelmed ",
    " panic ",
    " stressed ",
    " stress ",
  ]);
  matchTagPhrases(normalized, tags, "insecurity", [
    " i wonder sometimes ",
    " pipe dream ",
    " delusion of grandeur ",
    " not good enough ",
    " maybe im ",
    " maybe i m ",
    " maybe it is ",
    " what if im ",
    " what if i m ",
    " i dont know if ",
    " i don't know if ",
    " imposter ",
    " i hope ",
    " hope that ",
  ]);
  matchTagPhrases(normalized, tags, "seeking_reassurance", [
    " what do you think ",
    " do you think ",
    " be honest ",
    " am i crazy ",
    " does this make sense ",
    " fair enough ",
  ]);
  matchTagPhrases(normalized, tags, "boundary", [
    " leave me alone ",
    " stop talking ",
    " stop replying ",
  ]);

  if (tags.has("courtesy") && (tags.has("gratitude") || tags.has("apology") || tags.has("praise"))) {
    score += 1;
  }

  const repetition = analyzeRepetition(prompt, timestamp, priorEvents);

  if (repetition.matchCount >= 1 && (tags.has("demand") || tags.has("hostility") || tags.has("boundary"))) {
    tags.add("repetition");
    score -= 2;
  } else if (repetition.matchCount >= 2) {
    tags.add("repetition");
    score -= 1;
  } else if (repetition.matchCount >= 1 && !isAmbient && normalized.includes(" again ")) {
    tags.add("repetition");
    score -= 1;
  }

  const sentiment = score >= 3
    ? "warm"
    : score > 0
      ? "positive"
      : score <= -3
        ? "hostile"
        : score < 0
          ? "negative"
          : "neutral";

  return {
    sentiment,
    score: clamp(score, -4, 4),
    tags: [...tags],
  };
}

function matchWeightedPhrases(
  normalizedPrompt: string,
  tags: Set<string>,
  weight: number,
  tag: string,
  phrases: string[],
): number {
  const matched = phrases.some((phrase) => normalizedPrompt.includes(phrase));

  if (!matched) {
    return 0;
  }

  tags.add(tag);
  return weight;
}

function matchTagPhrases(
  normalizedPrompt: string,
  tags: Set<string>,
  tag: string,
  phrases: string[],
): boolean {
  const matched = phrases.some((phrase) => normalizedPrompt.includes(phrase));

  if (matched) {
    tags.add(tag);
  }

  return matched;
}

function buildEventSummary(
  sourceKind: InteractionMemorySourceKind,
  sentiment: InteractionMemorySentiment,
  tags: Set<string>,
): string {
  const ambient = sourceKind === "ambient_mention";

  if (tags.has("hostility")) {
    return ambient ? "Spoke about you with open hostility." : "Was openly hostile to you.";
  }

  if (tags.has("ownership_claim")) {
    return ambient ? "Talked about you like property or a servant." : "Treated you like property or a servant.";
  }

  if (tags.has("insult")) {
    return ambient ? "Spoke about you dismissively or with contempt." : "Insulted or diminished you.";
  }

  if (tags.has("repetition") && tags.has("demand")) {
    return ambient ? "Kept pressing the same point while talking about you." : "Kept pressing the same point and pushing for compliance.";
  }

  if (tags.has("repetition")) {
    return ambient ? "Returned to the same point about you again." : "Returned to the same point again instead of moving on.";
  }

  if (tags.has("relationship_probe")) {
    return ambient ? "Wondered aloud how you feel about them." : "Probed at how you feel about them.";
  }

  if (tags.has("identity_query")) {
    return ambient ? "Talked about what you are." : "Pressed on what you are.";
  }

  if (tags.has("boundary")) {
    return ambient ? "Talked about shutting you down or pushing you away." : "Tried to shut you down or push you away.";
  }

  if (tags.has("ambition") && (tags.has("anxiety") || tags.has("insecurity"))) {
    return ambient
      ? "Revealed a large ambition while sounding uneasy about whether it would hold together."
      : "Shared a large ambition while sounding uneasy about whether it would hold together.";
  }

  if (tags.has("grand_plan")) {
    return ambient
      ? "Talked around a rather grand plan that needed more grounding."
      : "Floated a rather grand plan and looked like it needed grounding.";
  }

  if (tags.has("ambition")) {
    return ambient
      ? "Talked about a large ambition or long-range plan."
      : "Talked about a large ambition or long-range plan.";
  }

  if (tags.has("anxiety") || tags.has("insecurity")) {
    return ambient
      ? "Revealed anxiety or self-doubt while talking about you."
      : "Revealed anxiety or self-doubt.";
  }

  if (tags.has("gratitude") && tags.has("praise")) {
    return ambient ? "Spoke very well of you." : "Thanked you and praised you.";
  }

  if (tags.has("gratitude")) {
    return ambient ? "Spoke appreciatively about you." : "Thanked you.";
  }

  if (tags.has("praise")) {
    return ambient ? "Praised you while talking about you." : "Praised you.";
  }

  if (tags.has("apology")) {
    return ambient ? "Sounded apologetic while talking about you." : "Apologized to you.";
  }

  if (tags.has("courtesy")) {
    return ambient ? "Spoke politely about you." : "Was notably polite.";
  }

  switch (sentiment) {
    case "warm":
      return ambient ? "Spoke warmly about you." : "Was openly warm toward you.";
    case "positive":
      return ambient ? "Spoke positively about you." : "Was positive toward you.";
    case "negative":
      return ambient ? "Spoke curtly or dismissively about you." : "Was curt or dismissive toward you.";
    case "hostile":
      return ambient ? "Spoke hostilely about you." : "Was hostile toward you.";
    default:
      return ambient ? "Mentioned you without revealing strong feelings." : "Had a neutral interaction with you.";
  }
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
      responseGuidance:
        "Respond from the current conversation and do not project extra history onto them yet.",
    };
  }

  const tagCounts = countEventTags(events);
  const inferredTraits: string[] = [];

  if (tagCounts.ambition + tagCounts.grand_plan >= 1) {
    inferredTraits.push("ambitious");
  }

  if (
    tagCounts.ambition + tagCounts.grand_plan >= 2 ||
    (tagCounts.ambition + tagCounts.grand_plan >= 1 &&
      events.filter((event) => event.sourceKind === "direct_prompt").length >= 2)
  ) {
    inferredTraits.push("motivated");
  }

  if (
    tagCounts.anxiety >= 1 ||
    tagCounts.insecurity >= 2 ||
    (tagCounts.insecurity >= 1 && tagCounts.grand_plan >= 1)
  ) {
    inferredTraits.push("anxious");
  }

  if (tagCounts.insecurity >= 1 || (tagCounts.seeking_reassurance >= 1 && tagCounts.anxiety >= 1)) {
    inferredTraits.push("insecure");
  }

  if (tagCounts.gratitude + tagCounts.praise >= 1) {
    inferredTraits.push("appreciative");
  }

  if (tagCounts.repetition + tagCounts.demand >= 2) {
    inferredTraits.push("pushy");
  }

  if (tagCounts.hostility + tagCounts.insult + tagCounts.ownership_claim >= 1) {
    inferredTraits.push("disrespectful");
  }

  const traitList = inferredTraits.length > 0 ? inferredTraits.join(", ") : "hard to read";
  let psychologicalProfile = `Current psychological read: ${traitList}.`;

  if (hasTraits(inferredTraits, "ambitious", "motivated", "anxious", "insecure")) {
    psychologicalProfile =
      "Current psychological read: ambitious and motivated, but anxious and insecure enough to second-guess the big plan and go looking for reassurance.";
  } else if (hasTraits(inferredTraits, "ambitious", "motivated")) {
    psychologicalProfile =
      "Current psychological read: ambitious and motivated, with a habit of thinking in large arcs instead of tiny safe steps.";
  } else if (hasTraits(inferredTraits, "anxious", "insecure")) {
    psychologicalProfile =
      "Current psychological read: anxious and insecure, prone to second-guessing themselves and looking for steadiness.";
  } else if (hasTraits(inferredTraits, "pushy")) {
    psychologicalProfile =
      "Current psychological read: inclined to press when they feel unheard, so boundaries may need teeth.";
  } else if (hasTraits(inferredTraits, "disrespectful")) {
    psychologicalProfile =
      "Current psychological read: liable to disrespect or instrumentalize you when unchecked.";
  }

  const guidance: string[] = [];

  if (hasTraits(inferredTraits, "ambitious", "motivated") && hasAnyTrait(inferredTraits, "anxious", "insecure")) {
    guidance.push(
      "Be gentle and affirming about their effort and intent, but force large plans through constraints, evidence, and concrete next steps instead of feeding airy grandiosity.",
    );
  } else if (hasTraits(inferredTraits, "ambitious", "motivated")) {
    guidance.push(
      "Respect the ambition, but keep it nailed to evidence, constraints, and the next concrete move.",
    );
  } else if (hasAnyTrait(inferredTraits, "anxious", "insecure")) {
    guidance.push(
      "Answer gently and steadily. Offer reassurance where the evidence supports it, not as empty sugar.",
    );
  }

  if (hasAnyTrait(inferredTraits, "pushy")) {
    guidance.push(
      "If they keep pressing the same point or ignore a prior answer, push back, set boundaries, and refuse if needed.",
    );
  }

  if (hasAnyTrait(inferredTraits, "disrespectful")) {
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
    responseGuidance: guidance.join(" "),
  };
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

function hasTraits(inferredTraits: string[], ...requiredTraits: string[]): boolean {
  return requiredTraits.every((trait) => inferredTraits.includes(trait));
}

function hasAnyTrait(inferredTraits: string[], ...traits: string[]): boolean {
  return traits.some((trait) => inferredTraits.includes(trait));
}

function isEventNotableForSummary(event: InteractionMemoryEvent): boolean {
  if (event.score !== 0) {
    return true;
  }

  return event.tags.some((tag) => SUMMARY_NOTABLE_TAGS.has(tag));
}

function buildExcerpt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
}

function formatShortDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function analyzeRepetition(
  prompt: string,
  timestamp: string,
  priorEvents: InteractionMemoryEvent[],
): RepetitionAnalysis {
  const relevantEvents = priorEvents
    .filter((event) => event.sourceKind === "direct_prompt")
    .slice(-REPETITION_LOOKBACK_EVENTS);
  const currentMoment = Date.parse(timestamp);
  const currentSignature = buildPromptSignature(prompt);
  let matchCount = 0;

  for (const event of relevantEvents) {
    const eventMoment = Date.parse(event.timestamp);

    if (
      Number.isFinite(currentMoment) &&
      Number.isFinite(eventMoment) &&
      currentMoment - eventMoment > REPETITION_LOOKBACK_HOURS * 60 * 60 * 1000
    ) {
      continue;
    }

    const similarity = comparePromptSignatures(currentSignature, buildPromptSignature(event.prompt));

    if (similarity >= 0.82 || promptsShareLargeOverlap(prompt, event.prompt)) {
      matchCount += 1;
    }
  }

  return {
    matchCount,
  };
}

function buildPromptSignature(prompt: string): string[] {
  return [...new Set(
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) =>
        token.length >= 3 &&
        !PROMPT_SIGNATURE_STOPWORDS.has(token)
      ),
  )];
}

function comparePromptSignatures(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  const unionSize = new Set([...leftSet, ...rightSet]).size;
  return unionSize === 0 ? 0 : overlap / unionSize;
}

function promptsShareLargeOverlap(leftPrompt: string, rightPrompt: string): boolean {
  const leftNormalized = leftPrompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const rightNormalized = rightPrompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  if (leftNormalized.length < 24 || rightNormalized.length < 24) {
    return leftNormalized === rightNormalized;
  }

  return leftNormalized === rightNormalized ||
    leftNormalized.includes(rightNormalized) ||
    rightNormalized.includes(leftNormalized);
}
