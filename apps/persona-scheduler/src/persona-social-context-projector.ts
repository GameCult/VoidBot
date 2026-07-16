import type { RepoDiscordIdentity, VoidSelfStateTypedProjection } from "@voidbot/core";
import type { SourceMessage } from "@voidbot/shared";
import type { ChannelSnapshot } from "./turn-context-source.js";

export interface PersonaHumanPronounGuidance {
  actorId: string;
  actorName: string;
  guidance: string;
  resolvedPronounSet?: string;
  policy: string;
  confidence?: number;
  evidenceExcerpt?: string;
}

export function renderPersonaHumanPronounFacts(guidance: PersonaHumanPronounGuidance[]): string | undefined {
  if (guidance.length === 0) return undefined;
  return [
    "Known human pronoun guidance:",
    ...guidance.map((entry) => [
      `- ${entry.actorName}: ${entry.guidance}`,
      entry.resolvedPronounSet ? `Resolved set: ${entry.resolvedPronounSet}.` : "",
      entry.policy ? `Policy: ${entry.policy}.` : "",
      typeof entry.confidence === "number" ? `Confidence: ${entry.confidence.toFixed(2)}.` : "",
      entry.evidenceExcerpt ? `Evidence: "${entry.evidenceExcerpt.replace(/\s+/g, " ").trim().slice(0, 180)}"` : "",
    ].filter(Boolean).join(" ")),
    "Use this when referring to humans in social or relationship prose. If guidance is absent for someone, use their name or neutral phrasing rather than guessing.",
  ].join("\n");
}

export function renderPersonaRoomTexture(input: {
  identity: RepoDiscordIdentity;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  topicAttractorFacts?: string;
}): string | undefined {
  const stats = observePersonaRoomTexture(input);
  if (!stats) return undefined;
  const temporary = stats.texture === "heavy" || stats.agentShare >= 0.55 ? [
    "- Temporary affect pressure candidates: play, rest, and social_contact may be hungry because the room is carrying sustained work/agent weight.",
    "- These are not stored needs and not orders. Project whether this character gets mischievous, bored, sharp, withdrawn, socially hungry, status-testing, or still work-focused.",
  ] : [];
  return [
    "Room texture facts:",
    `- Observed messages: ${stats.total}; humans: ${stats.humanMessages}; agents/bots: ${stats.agentMessages}; distinct speakers: ${stats.speakerCount}.`,
    `- Long messages: ${stats.longMessages}; short messages: ${stats.shortMessages}; average length: ${stats.averageCharacters} characters.`,
    `- This Face's own recent messages in the attached window: ${stats.ownMessages}.`,
    `- Structural texture: ${stats.texture}. This is evidence about conversational weight, not a command to speak or joke.`,
    ...temporary,
    ...(input.topicAttractorFacts ? [input.topicAttractorFacts] : []),
  ].join("\n");
}

export function renderPersonaRoomWeather(input: {
  identity: RepoDiscordIdentity;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
}): string {
  const stats = observePersonaRoomTexture(input);
  if (!stats) return "- No current room weather was available.";
  const pressure = stats.texture === "heavy" || stats.agentShare >= 0.55
    ? "The room is currently structurally work-heavy or agent-heavy. Treat that as conversational weather: it may create boredom, play hunger, restlessness, social hunger, withdrawal, or sharper status-testing, depending on who you are. This is not an order to joke; it is permission to feel the weight instead of answering every opening with more work."
    : stats.texture === "light"
      ? "The room is currently light enough for compact social motion. You still need an actual reason to speak, but not a work ticket."
      : "The room is mixed. Use the transcript to decide whether the living pressure is social, practical, or private.";
  return [`- Messages observed: ${stats.total}; humans: ${stats.humanMessages}; agents/bots: ${stats.agentMessages}; distinct speakers: ${stats.speakerCount}.`, `- Texture: ${stats.texture}; your own recent messages in this window: ${stats.ownMessages}.`, `- ${pressure}`].join("\n");
}

export function renderPersonaRelationshipFreshness(input: {
  identityName: string;
  state: VoidSelfStateTypedProjection;
  registryIdentities: RepoDiscordIdentity[];
  observedAt: Date;
}): string | undefined {
  const peerKeys = peerSocialKeys(input.registryIdentities);
  const staleBonds = input.state.faceAffect.socialBonds
    .filter((bond) => bond.status === "active" && bond.target.kind === "person" && isPeerTarget(bond.target, peerKeys))
    .map((bond) => ({ target: targetLabel(bond.target), kind: bond.stance, intensity: bond.intensity, ageHours: ageHoursSince(bond.updatedAt, input.observedAt.getTime()), summary: bond.summary, action: bond.actionImplication }))
    .filter((entry) => entry.ageHours >= 48)
    .sort((left, right) => (right.ageHours * right.intensity) - (left.ageHours * left.intensity))
    .slice(0, 5);
  const staleReads = input.state.faceAffect.statusReads
    .filter((read) => !read.retiredAt && read.target.kind === "person" && isPeerTarget(read.target, peerKeys))
    .map((read) => ({ target: targetLabel(read.target), kind: read.status, intensity: read.intensity, ageHours: ageHoursSince(read.updatedAt, input.observedAt.getTime()), summary: read.summary, action: read.actionImplication }))
    .filter((entry) => entry.ageHours >= 72)
    .sort((left, right) => (right.ageHours * right.intensity) - (left.ageHours * left.intensity))
    .slice(0, 5);
  const entries = [
    ...staleBonds.map((entry) => `- ${entry.target}: ${entry.kind} bond has gone ${formatAgeHours(entry.ageHours)} without contact. ${sentence(entry.summary)} Touch-base pull: ${sentence(entry.action)}`),
    ...staleReads.map((entry) => `- ${entry.target}: ${entry.kind} status read has gone ${formatAgeHours(entry.ageHours)} without contact. ${sentence(entry.summary)} Touch-base pull: ${sentence(entry.action)}`),
  ].slice(0, 6);
  return entries.length === 0 ? undefined : [
    `Relationship freshness pressure for ${input.identityName}:`,
    ...entries,
    "These are not commands to dump feelings. They are swarm social graph itch. A compact tease, check-in, challenge, compliment, question, or repair with another Face can be a successful public turn.",
  ].join("\n");
}

function peerSocialKeys(identities: RepoDiscordIdentity[]): Set<string> { return new Set(identities.flatMap((identity) => [identity.id, identity.displayName, identity.repoName]).map(normalizeSocialLabel).filter(Boolean)); }
function isPeerTarget(target: { id: string; label?: string }, peerKeys: Set<string>): boolean { return [target.id, target.label].map(normalizeSocialLabel).some((key) => key.length > 0 && peerKeys.has(key)); }
function ageHoursSince(value: string | undefined, nowMs: number): number { const then = Date.parse(value ?? ""); return Number.isFinite(then) ? Math.max(0, (nowMs - then) / 3_600_000) : 999; }
function formatAgeHours(hours: number): string { return hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`; }
function targetLabel(target: { label?: string; id?: string; kind?: string } | undefined): string { return target?.label ?? target?.id ?? target?.kind ?? "an unnamed target"; }
function normalizeSocialLabel(value: string | undefined): string { return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function sentence(value: string | undefined): string { const clean = (value ?? "").replace(/\s+/g, " ").trim(); return !clean ? "" : /[.!?]$/.test(clean) ? clean : `${clean}.`; }

export interface PersonaRoomTextureObservation {
  total: number;
  agentMessages: number;
  humanMessages: number;
  ownMessages: number;
  longMessages: number;
  shortMessages: number;
  averageCharacters: number;
  speakerCount: number;
  texture: "heavy" | "light" | "mixed";
  agentShare: number;
}

export function observePersonaRoomTexture(input: { identity: RepoDiscordIdentity; recentMessages: SourceMessage[]; channelSnapshots: ChannelSnapshot[] }): PersonaRoomTextureObservation | undefined {
  const messages = [...input.recentMessages, ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages)];
  if (messages.length === 0) return undefined;
  const ownToken = normalizeSocialLabel(input.identity.displayName);
  const total = messages.length;
  const agentMessages = messages.filter((message) => message.isBot).length;
  const lengths = messages.map((message) => message.content.replace(/\s+/g, " ").trim().slice(0, 10_000).length);
  const longMessages = lengths.filter((length) => length >= 220).length;
  const shortMessages = lengths.filter((length) => length <= 90).length;
  const averageCharacters = Math.round(lengths.reduce((sum, length) => sum + length, 0) / total);
  return {
    total,
    agentMessages,
    humanMessages: total - agentMessages,
    ownMessages: messages.filter((message) => normalizeSocialLabel(message.authorName) === ownToken).length,
    longMessages,
    shortMessages,
    averageCharacters,
    speakerCount: new Set(messages.map((message) => normalizeSocialLabel(message.authorName || message.authorId)).filter(Boolean)).size,
    texture: (longMessages >= Math.ceil(total * 0.45) || averageCharacters >= 180 ? "heavy" : shortMessages >= Math.ceil(total * 0.55) ? "light" : "mixed") as "heavy" | "light" | "mixed",
    agentShare: agentMessages / total,
  };
}
