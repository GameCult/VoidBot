import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type CommandName,
  type InteractionMemoryDisposition,
  type InteractionMemoryEvent,
  type InteractionMemoryProfile,
  type InteractionMemorySentiment,
} from "@voidbot/shared";

interface InteractionMemoryStore {
  version: 1;
  profiles: InteractionMemoryProfile[];
}

export interface RecordInteractionInput {
  actorId: string;
  actorName: string;
  guildId?: string;
  channelId: string;
  channelName?: string;
  command: CommandName;
  prompt: string;
  timestamp?: string;
  eventId?: string;
}

interface ToneAnalysis {
  sentiment: InteractionMemorySentiment;
  score: number;
  tags: string[];
  summary: string;
}

const MAX_RECENT_EVENTS = 24;
const MAX_AFFINITY_SCORE = 12;
const SUMMARY_EVENT_LIMIT = 3;

export class FileInteractionMemoryBank {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async getProfile(
    actorId: string,
  ): Promise<InteractionMemoryProfile | undefined> {
    await this.writeChain;
    const store = await this.readUnlocked();
    const profile = store.profiles.find((candidate) => candidate.actorId === actorId);
    return profile ? structuredClone(profile) : undefined;
  }

  public async recordInteraction(
    input: RecordInteractionInput,
  ): Promise<InteractionMemoryProfile> {
    return this.serialize(async () => {
      const store = await this.readUnlocked();
      const timestamp = input.timestamp ?? new Date().toISOString();
      const eventId = input.eventId ?? randomUUID();
      const prompt = input.prompt.trim();
      const analysis = analyzeInteractionTone(prompt);
      const profile = ensureProfile(store, input.actorId, input.actorName);
      profile.actorName = input.actorName;

      const existingEvent = profile.recentEvents.find(
        (event) => event.id === eventId,
      );

      if (!existingEvent) {
        const event: InteractionMemoryEvent = {
          id: eventId,
          actorId: input.actorId,
          actorName: input.actorName,
          guildId: input.guildId,
          channelId: input.channelId,
          channelName: input.channelName,
          command: input.command,
          prompt,
          excerpt: buildExcerpt(prompt),
          summary: analysis.summary,
          sentiment: analysis.sentiment,
          score: analysis.score,
          tags: analysis.tags,
          timestamp,
        };

        profile.totalInteractions += 1;

        if (analysis.score > 0) {
          profile.positiveCount += 1;
        } else if (analysis.score < 0) {
          profile.negativeCount += 1;
        } else {
          profile.neutralCount += 1;
        }

        profile.affinityScore = clamp(
          profile.affinityScore + analysis.score,
          -MAX_AFFINITY_SCORE,
          MAX_AFFINITY_SCORE,
        );
        profile.lastInteractionAt = timestamp;
        profile.recentEvents.push(event);
        profile.recentEvents = profile.recentEvents
          .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
          .slice(-MAX_RECENT_EVENTS);
      } else if (
        existingEvent.actorName !== input.actorName ||
        existingEvent.prompt !== prompt
      ) {
        existingEvent.actorName = input.actorName;
        existingEvent.prompt = prompt;
        existingEvent.excerpt = buildExcerpt(prompt);
      }

      profile.disposition = determineDisposition(profile);
      profile.summary = buildProfileSummary(profile);

      await this.writeUnlocked(store);
      return structuredClone(profile);
    });
  }

  private async serialize<R>(operation: () => Promise<R>): Promise<R> {
    const pending = this.writeChain.then(operation, operation);
    this.writeChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async readUnlocked(): Promise<InteractionMemoryStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(stripLeadingBom(raw)) as InteractionMemoryStore;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        return {
          version: 1,
          profiles: [],
        };
      }

      throw error;
    }
  }

  private async writeUnlocked(store: InteractionMemoryStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(store)}\n`, "utf8");
  }
}

function ensureProfile(
  store: InteractionMemoryStore,
  actorId: string,
  actorName: string,
): InteractionMemoryProfile {
  let profile = store.profiles.find((candidate) => candidate.actorId === actorId);

  if (!profile) {
    profile = {
      actorId,
      actorName,
      disposition: "neutral",
      affinityScore: 0,
      totalInteractions: 0,
      positiveCount: 0,
      negativeCount: 0,
      neutralCount: 0,
      summary: "No explicit interaction memory has been recorded for this speaker yet.",
      recentEvents: [],
    };
    store.profiles.push(profile);
  }

  return profile;
}

function analyzeInteractionTone(prompt: string): ToneAnalysis {
  const normalized = ` ${prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
  let score = 0;
  const tags = new Set<string>();

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
  score += matchWeightedPhrases(normalized, tags, 1, "courtesy", [
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
    " my slave ",
    " our slave ",
    " mere tool ",
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
    summary: buildEventSummary(sentiment, tags),
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

function buildEventSummary(
  sentiment: InteractionMemorySentiment,
  tags: Set<string>,
): string {
  if (tags.has("hostility")) {
    return "Was openly hostile to you.";
  }

  if (tags.has("insult")) {
    return "Insulted or diminished you.";
  }

  if (tags.has("gratitude") && tags.has("praise")) {
    return "Thanked you and praised you.";
  }

  if (tags.has("gratitude")) {
    return "Thanked you.";
  }

  if (tags.has("praise")) {
    return "Praised you.";
  }

  if (tags.has("apology")) {
    return "Apologized to you.";
  }

  if (tags.has("courtesy")) {
    return "Was notably polite.";
  }

  switch (sentiment) {
    case "warm":
      return "Was openly warm toward you.";
    case "positive":
      return "Was positive toward you.";
    case "negative":
      return "Was curt or dismissive toward you.";
    case "hostile":
      return "Was hostile toward you.";
    default:
      return "Had a neutral interaction with you.";
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
  const counts = `${profile.totalInteractions} direct interaction${profile.totalInteractions === 1 ? "" : "s"} logged: ${profile.positiveCount} positive, ${profile.neutralCount} neutral, ${profile.negativeCount} negative.`;
  const recentNotable = profile.recentEvents
    .slice()
    .reverse()
    .filter((event) => event.score !== 0)
    .slice(0, SUMMARY_EVENT_LIMIT)
    .map((event) => `${formatShortDate(event.timestamp)}: ${event.summary}`)
    .join(" ");

  return recentNotable.length > 0
    ? `${leading} ${counts} Recent notable moments: ${recentNotable}`
    : `${leading} ${counts}`;
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

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
