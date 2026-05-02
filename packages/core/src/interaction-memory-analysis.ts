import { randomUUID } from "node:crypto";

import {
  type CommandName,
  type InteractionMemoryEvent,
  type InteractionMemorySentiment,
  type InteractionMemorySourceKind,
} from "@voidbot/shared";

import {
  PROMPT_SIGNATURE_STOPWORDS,
  REPETITION_LOOKBACK_EVENTS,
  REPETITION_LOOKBACK_HOURS,
  SIGNIFICANT_INTERACTION_TAGS,
} from "./interaction-memory-shared";
import { extractDirectPromptPronounEvidence } from "./pronoun-evidence";

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
  matchTagPhrases(normalized, tags, "suspicion", [
    " i dont trust ",
    " i don't trust ",
    " can i trust ",
    " are you lying ",
    " youre lying ",
    " you're lying ",
    " prove it ",
    " how do i know ",
    " how do we know ",
    " what are you hiding ",
    " suspicious ",
    " conspiracy ",
    " paranoid ",
  ]);
  matchTagPhrases(normalized, tags, "rigidity", [
    " exactly ",
    " precise ",
    " precisely ",
    " perfect ",
    " perfection ",
    " obsessive ",
    " obsession ",
    " obsessed ",
    " fixated ",
    " must be ",
    " has to be ",
    " every detail ",
    " strictly ",
  ]);
  matchTagPhrases(normalized, tags, "withdrawal", [
    " whatever ",
    " forget it ",
    " never mind ",
    " doesnt matter ",
    " doesn't matter ",
    " leave me alone ",
    " stop talking ",
    " stop replying ",
    " fine ",
  ]);
  matchTagPhrases(normalized, tags, "boundary", [
    " leave me alone ",
    " stop talking ",
    " stop replying ",
  ]);

  const pronounEvidence = extractDirectPromptPronounEvidence(prompt, timestamp);

  if (pronounEvidence.some((entry) => entry.stance === "prefer")) {
    tags.add("pronoun_preference");
  }

  if (pronounEvidence.some((entry) => entry.stance === "avoid")) {
    tags.add("pronoun_correction");
  }

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

  if (tags.has("suspicion")) {
    return ambient
      ? "Talked about you with distrust or suspicion."
      : "Approached you with distrust or suspicion.";
  }

  if (tags.has("rigidity")) {
    return ambient
      ? "Talked in a rigid, perfection-seeking, or fixation-prone way."
      : "Sounded rigid, perfection-seeking, or fixation-prone.";
  }

  if (tags.has("withdrawal")) {
    return ambient
      ? "Talked about you with a detached or pushing-away tone."
      : "Pulled away or tried to shut the interaction down.";
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

  if (tags.has("pronoun_correction") && tags.has("pronoun_preference")) {
    return ambient
      ? "Clarified someone else's pronoun preference while talking about identity."
      : "Explicitly corrected how they want to be referred to.";
  }

  if (tags.has("pronoun_correction")) {
    return ambient
      ? "Corrected pronoun usage while talking about identity."
      : "Explicitly rejected a pronoun they do not want used for them.";
  }

  if (tags.has("pronoun_preference")) {
    return ambient
      ? "Named a pronoun preference while talking about identity."
      : "Explicitly stated how they prefer to be referred to.";
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

function buildExcerpt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
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
