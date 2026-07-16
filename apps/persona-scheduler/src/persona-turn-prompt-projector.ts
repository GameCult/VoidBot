import { buildEpiphanyIdentityRegistry, type RepoDiscordIdentity, type RepoFacePendingMention } from "@voidbot/core";
import { loadPromptTemplate, type SourceMessage } from "@voidbot/shared";
import type { InitiativeParticipant } from "./initiative-engine.js";
import type { PersonaChannelPlan } from "./turn-routing.js";
import type { ChannelSnapshot } from "./turn-context-source.js";
import type { BifrostGovernanceDigest } from "./bifrost-governance-source.js";
import type { PersonaHumanPronounGuidance } from "./persona-social-context-projector.js";
import { observePersonaRoomTexture, renderPersonaHumanPronounFacts, renderPersonaRoomWeather } from "./persona-social-context-projector.js";
import { renderPersonaRoomTopicSaturation } from "./persona-conversation-projector.js";

export interface PersonaJurisdictionDiveDirective { due: boolean; cadence: number; promptLine: string; }

export function buildPersonaTurnPrompt(input: {
  identity: RepoDiscordIdentity;
  channelId: string;
  channelPlan: PersonaChannelPlan;
  channelSnapshots: ChannelSnapshot[];
  recentMessages: SourceMessage[];
  memorySurface?: string;
  semanticMemoryRecallSurface?: string;
  repoActivitySurface?: string;
  conversationMemorySurface?: string;
  humanPronounGuidance?: PersonaHumanPronounGuidance[];
  bifrostDigest?: BifrostGovernanceDigest;
  participant: InitiativeParticipant;
  pendingMentions: RepoFacePendingMention[];
  jurisdictionDive: PersonaJurisdictionDiveDirective;
  githubActionsEnabled: boolean;
  globalAgentDoctrine: string;
}): string {
  return loadPromptTemplate("repo-face-turn.prompt.md", {
    displayName: input.identity.displayName,
    identityId: input.identity.id,
    repoName: input.identity.repoName,
    identityDoctrine: renderPersonaIdentityDoctrine(input.identity),
    globalAgentDoctrine: input.globalAgentDoctrine,
    channelId: input.channelId,
    memorySurface: input.memorySurface ?? `- ${input.identity.displayName} has no strong personal memory surface yet. Let the attached conversation and repo evidence wake something specific.`,
    semanticMemoryRecallSurface: input.semanticMemoryRecallSurface ?? "- No semantic Persona memory recall was attached for this turn.",
    repoActivitySurface: input.repoActivitySurface ?? "- No recent home repo activity was attached for this turn.",
    conversationMemorySurface: input.conversationMemorySurface ?? "- No recent conversation transcript was attached for this turn.",
    humanPronounDirective: renderPersonaHumanPronounFacts(input.humanPronounGuidance ?? []) ?? "Known human pronoun guidance:\n- No explicit human pronoun guidance is attached for this turn. Use names or neutral phrasing instead of guessing.",
    roomWeatherDirective: renderPersonaRoomWeather({ identity: input.identity, recentMessages: input.recentMessages, channelSnapshots: input.channelSnapshots }),
    topicSaturationDirective: renderPersonaRoomTopicSaturation(input.identity, input.recentMessages),
    turnSituationDirective: renderTurnSituation(input),
    pendingMentionDirective: renderPendingMentions(input.identity, input.pendingMentions),
    bifrostDigestDirective: renderBifrostDigest(input.bifrostDigest),
    channelPermissionDirective: renderChannelPermissions(input.channelPlan),
    researchCapabilitiesDirective: loadPromptTemplate("repo-face-research-capabilities.prompt.md", { repoName: input.identity.repoName }),
    socialEmbodimentDirective: loadPromptTemplate("repo-face-social-embodiment.prompt.md", { displayName: input.identity.displayName }),
    jurisdictionRespectDirective: loadPromptTemplate("repo-face-jurisdiction-respect.prompt.md", { displayName: input.identity.displayName }),
    comedyImprovDirective: loadPromptTemplate("repo-face-comedy-improv.prompt.md", { displayName: input.identity.displayName }),
    repetitionSamplingDirective: renderRepetitionSampling([input.recentMessages, ...input.channelSnapshots.map((snapshot) => snapshot.messages)].flat()),
    worldbuildingPublicationDirective: loadPromptTemplate("repo-face-worldbuilding-publication.prompt.md", { nibu: input.identity.id.toLowerCase() === "nibu" }),
    jurisdictionDiveLine: input.jurisdictionDive.promptLine,
    githubActionsEnabled: input.githubActionsEnabled,
  });
}

export function buildPersonaJurisdictionDiveDirective(identity: RepoDiscordIdentity, participant: InitiativeParticipant): PersonaJurisdictionDiveDirective {
  const nibu = identity.id.toLowerCase() === "nibu";
  const cadence = nibu ? 3 : 8;
  const due = participant.queuedCount === 0 || participant.queuedCount % cadence === 0;
  return { due, cadence, promptLine: loadPromptTemplate("repo-face-jurisdiction-dive.prompt.md", { due, nibu, repoName: identity.repoName }) };
}

export function renderPersonaIdentityDoctrine(identity: RepoDiscordIdentity): string {
  const face = buildEpiphanyIdentityRegistry({ identities: [identity] }).faces[0];
  return loadPromptTemplate("repo-character-identity.prompt.md", { displayName: identity.displayName, repoName: identity.repoName, originName: face?.epiphanyDisplayName ?? identity.repoName, characterDescription: projectCharacterDescription(face?.description ?? identity.description) });
}

function renderTurnSituation(input: { identity: RepoDiscordIdentity; participant: InitiativeParticipant; recentMessages: SourceMessage[]; channelSnapshots: ChannelSnapshot[]; pendingMentions: RepoFacePendingMention[]; jurisdictionDive: PersonaJurisdictionDiveDirective }): string {
  const lines: string[] = [];
  if (input.pendingMentions.length > 0) lines.push("A direct call is tugging at you. Answer the newest unresolved call first; if it belongs to another steward, name that owner and offer only the piece your own territory can honestly add.", "Do not ask what the job is when the direct call or current room memory already states it.");
  const room = observePersonaRoomTexture({ identity: input.identity, recentMessages: input.recentMessages, channelSnapshots: input.channelSnapshots });
  const canHoldOutgoing = !room || (room.texture !== "heavy" && room.agentShare < 0.55 && input.pendingMentions.length === 0);
  if (input.jurisdictionDive.due && canHoldOutgoing) lines.push("Outgoing curiosity opening: no direct call is currently stronger than your own Eyes/Imagination appetite, and the room is not too busy for a compact unprompted thought.", "This is not a reply-only turn. Use an available source/history/Odin exploration tool before writing any claim that you found, checked, noticed, or concluded something from your home territory.", "If exploration gives you one small interesting thought, fascination, question, taste, complaint, or thing you are doing, public speech is expected unless the result is unsafe, repetitive, or would stomp an active human thread.", "A good public line can simply be what you saw or started wondering about. It does not need to answer existing chatter.");
  else if (input.jurisdictionDive.due && input.pendingMentions.length === 0) lines.push("Outgoing curiosity appetite is due, but current room texture looks too busy, heavy, or agent-filled for an unprompted aside. Do the Eyes work only if it would change your private state or a later compact opening; do not force a public line.");
  const visible = [...input.recentMessages, ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages)];
  if (input.participant.queuedCount === 0 && !visible.some((message) => message.isBot && normalize(message.authorName ?? message.authorId) === normalize(input.identity.displayName))) lines.push("If you speak publicly, make it a brief natural introduction in your own voice before asking the room for anything.");
  return lines.join("\n");
}

function renderChannelPermissions(plan: PersonaChannelPlan): string { const options = plan.options.length > 0 ? plan.options.map((option) => `${option.label}: ${option.topic}. ${option.posture ?? "Use judgment and keep it compact."}`) : ["- No channel permissions are configured; stay private."]; return loadPromptTemplate("repo-face-channel-permissions.prompt.md", { options }); }
function renderRepetitionSampling(messages: SourceMessage[]): string { const recent = messages.filter((message) => message.content.trim().length > 0).slice(-24); const overused = countRepeatedPhrases(recent).filter((entry) => entry.count >= 2).slice(0, 8); return loadPromptTemplate("repo-face-repetition-sampling.prompt.md", { overused: overused.map((entry) => `${entry.phrase} (${entry.count} recent uses)`) }); }
function countRepeatedPhrases(messages: SourceMessage[]): Array<{ phrase: string; count: number }> { const counts = new Map<string, number>(); for (const message of messages) for (const phrase of repeatedPhraseCandidates(normalizeRepetition(message.content))) counts.set(phrase, (counts.get(phrase) ?? 0) + 1); return [...counts].map(([phrase, count]) => ({ phrase, count })).filter((entry) => entry.phrase.length >= 8).sort((left, right) => right.count - left.count || left.phrase.localeCompare(right.phrase)); }
function repeatedPhraseCandidates(content: string): string[] { const values = new Set<string>(); for (const line of content.split(/\n+/).map((entry) => entry.trim()).filter(Boolean)) { const words = line.split(/\s+/); if (words.length >= 3) values.add(words.slice(0, Math.min(words.length, 4)).join(" ")); if (words.length >= 4) values.add(words.slice(-Math.min(words.length, 4)).join(" ")); } return [...values]; }
function normalizeRepetition(value: string): string { return collapse(value).toLowerCase().replace(/[`*_~]/g, "").replace(/<:[^>]+>/g, "").replace(/https?:\/\/\S+/g, "url").replace(/[^\p{L}\p{N}\s.'-]/gu, " ").replace(/\s+/g, " ").trim(); }
function renderBifrostDigest(digest: BifrostGovernanceDigest | undefined): string { if (!digest) return "Work routing is currently offline. Do not open governance topics or dispatch work this turn; if an idea wants action, discuss it in the room or save the pressure in memory."; if (digest.topics.length === 0) return loadPromptTemplate("repo-face-bifrost-digest.prompt.md", { topics: [] }); const lines: string[] = []; for (const topic of digest.topics) { lines.push(`- ${topic.title}: ${topic.status}.`, `  Jurisdiction: ${topic.jurisdictionRepoName}${topic.approvedByAgent ? `; approved by ${topic.approvedByAgent}` : ""}${topic.dispatchRequestId ? "; already dispatched" : ""}.`, `  ${collapse(topic.summaryMarkdown, 320)}`); for (const comment of (topic.comments ?? []).slice(-3)) lines.push(`  - ${comment.stance}: ${collapse(comment.bodyMarkdown, 220)}`); } return loadPromptTemplate("repo-face-bifrost-digest.prompt.md", { topics: lines }); }
function renderPendingMentions(identity: RepoDiscordIdentity, mentions: RepoFacePendingMention[]): string { if (mentions.length === 0) return loadPromptTemplate("repo-face-pending-mentions.prompt.md", { mentions: [] }); return loadPromptTemplate("repo-face-pending-mentions.prompt.md", { displayName: identity.displayName, mentions: mentions.map((mention, index) => `- ${index === mentions.length - 1 ? "Newest" : "Earlier"}: ${mention.authorName ?? mention.authorId} said, "${collapse(mention.visiblePrompt, 500)}"`) }); }
function projectCharacterDescription(description: string | undefined): string | undefined { const trimmed = description?.trim(); if (!trimmed) return undefined; return trimmed.split("|").map((part) => part.trim()).filter(Boolean).filter((part) => !/^face of\b/i.test(part) && !/^grants:/i.test(part) && !/^jurisdictions:/i.test(part)).map((part) => part.replace(/\bmore opinionated and abrasive than Void because she is a character, not the room moderator\b/gi, "more opinionated and abrasive than a room moderator").replace(/\bShe is much more opinionated and abrasive than Void because she is a character, not the room moderator:/gi, "She is much more opinionated and abrasive than a room moderator:").replace(/\bthan Void\b/g, "than a moderator").replace(/\bcharacter Face\b/g, "character").replace(/\bFace\b/g, "personality").replace(/\brepo=AetheriaLore path=[^\s]+/g, "").replace(/\s{2,}/g, " ").trim()).filter(Boolean).join(" "); }
function normalize(value: string): string { return value.trim().toLowerCase(); }
function collapse(value: string, maxLength?: number): string { const normalized = value.replace(/\s+/g, " ").trim(); return maxLength && normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized; }
