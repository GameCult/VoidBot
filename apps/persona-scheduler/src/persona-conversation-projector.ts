import type { RepoDiscordIdentity, RepoFacePendingMention } from "@voidbot/core";
import type { RepoFaceConversationFocus, SourceMessage } from "@voidbot/shared";
import type { ChannelSnapshot } from "./turn-context-source.js";
import type { PersonaChannelPlan } from "./turn-routing.js";
import { significantPersonaTopicTerms } from "./persona-curiosity-terms.js";

export interface PersonaConversationProjection {
  transcript: string;
  threads: RepoFaceConversationFocus[];
  focus?: RepoFaceConversationFocus;
  topicAttractor?: string;
}

export function projectPersonaConversation(input: {
  identity: RepoDiscordIdentity;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  pendingMentions: RepoFacePendingMention[];
  channelPlan: PersonaChannelPlan;
}): PersonaConversationProjection {
  const threads = buildPersonaConversationThreads(input);
  return {
    transcript: renderPersonaConversationTranscript(input, threads),
    threads,
    focus: threads[0],
    topicAttractor: renderPersonaTopicAttractor(input.identity, input.recentMessages),
  };
}

export function buildPersonaConversationThreads(input: {
  channelPlan: PersonaChannelPlan;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  pendingMentions: RepoFacePendingMention[];
}): RepoFaceConversationFocus[] {
  const primaryChannelId = input.channelPlan.primaryChannelId;
  const label = (channelId: string | undefined): string | undefined => input.channelPlan.options.find((option) => option.channelId === channelId)?.label ?? channelId;
  const newestMention = [...input.pendingMentions].sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))[0];
  const threads: RepoFaceConversationFocus[] = [];
  if (newestMention) threads.push({ contextId: contextId(newestMention.channelId, newestMention.messageId), channelId: newestMention.channelId, channelLabel: label(newestMention.channelId), messageId: newestMention.messageId, authorName: newestMention.authorName, timestamp: newestMention.queuedAt, reason: "pending_mention", isCurrentRoom: newestMention.channelId === primaryChannelId });
  const visible = [
    ...input.recentMessages.map((message) => ({ message, channelId: primaryChannelId, label: label(primaryChannelId) })),
    ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages.map((message) => ({ message, channelId: snapshot.channelId, label: label(snapshot.channelId) }))),
  ].filter((entry): entry is { message: SourceMessage; channelId: string; label: string | undefined } => Boolean(entry.channelId) && Number.isFinite(Date.parse(entry.message.timestamp)))
    .sort((left, right) => Date.parse(right.message.timestamp) - Date.parse(left.message.timestamp));
  const byChannel = new Set(threads.map((thread) => thread.channelId));
  for (const entry of visible) {
    if (byChannel.has(entry.channelId) || (entry.message.isBot && (entry.message.attachments ?? []).length === 0)) continue;
    byChannel.add(entry.channelId);
    threads.push({ contextId: contextId(entry.channelId, entry.message.id), channelId: entry.channelId, channelLabel: entry.label, messageId: entry.message.id, authorName: entry.message.authorName, timestamp: entry.message.timestamp, reason: entry.message.isBot ? "latest_visible_message" : "latest_human_message", isCurrentRoom: entry.channelId === primaryChannelId, hasMedia: (entry.message.attachments ?? []).length > 0 });
    if (threads.length >= 6) break;
  }
  return threads;
}

export function renderPersonaConversationTranscript(input: {
  identity: RepoDiscordIdentity;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  pendingMentions: RepoFacePendingMention[];
  channelPlan: PersonaChannelPlan;
}, threads = buildPersonaConversationThreads(input)): string {
  const sections = [[
    "Read this as raw recent message evidence, not as a summary and not as consensus.",
    "Messages are ordered oldest to newest inside each section. Newer human corrections can supersede older agent proposals.",
    "Use the visible cross-channel chronology below to decide whether a correction is still unresolved or was already answered later by the same Face.",
    "Do not infer consensus from agents repeating each other. If a human reframes, narrows, or corrects an agent's proposal, account for that correction directly.",
    "If you answer the live conversation, keep the conversation context attached. A Face can carry different conversations in different channels at once.",
    "If you answer or riff on a nearby-room message, use that message's active context id or set channel to that message's listed channel id and usually set reply_to to that message id. If the nearby message is media, a public reaction belongs in that media source channel unless a human explicitly moved the topic. Never answer a nearby-room post in the current room just because the current room is easier to speak in.",
    "Message IDs are shown so a public reply can target the message that gives it context. If you revive an older side thread, either reply_to that message id or include enough context in your message for readers to know what you mean.",
  ].join("\n")];
  if (threads[0]) sections.push(renderFocus(threads[0], threads));
  const chronology = renderChronology(input);
  if (chronology) sections.push(chronology);
  if (input.pendingMentions.length > 0) sections.push(["Direct calls:", ...input.pendingMentions.map((mention) => `- ${mention.authorName ?? mention.authorId}: ${collapse(mention.visiblePrompt, 900)}`)].join("\n"));
  const currentLabel = input.channelPlan.options.find((option) => option.channelId === input.channelPlan.primaryChannelId)?.label ?? "current room";
  sections.push([`Current room (${currentLabel}, channel ${input.channelPlan.primaryChannelId ?? "unknown"}), oldest to newest:`, ...formatMessages(input.recentMessages, 15, input.channelPlan.primaryChannelId)].join("\n"));
  for (const snapshot of input.channelSnapshots) {
    const label = input.channelPlan.options.find((option) => option.channelId === snapshot.channelId)?.label ?? "nearby room";
    sections.push([`Nearby ${label} (channel ${snapshot.channelId}), oldest to newest:`, ...formatMessages(snapshot.messages, 6, snapshot.channelId)].join("\n"));
  }
  return sections.join("\n\n");
}

export function renderPersonaRoomTopicSaturation(identity: RepoDiscordIdentity, messages: SourceMessage[]): string {
  const signal = detectTopicSaturation(messages);
  if (!signal) return "";
  const relation = topicRelation(identity, signal);
  const relationLine = relation.isHomeAdjacent
    ? `- For ${identity.displayName}, this looks home-adjacent because the repeated terms overlap its territory (${relation.matchedTerms.join(", ")}). That permits deeper engagement, but it still needs fresh anchors or closure.`
    : `- For ${identity.displayName}, this looks like another steward's gravity well, not its own territory. Treat the pull as possible neglect, boredom, jealousy, territorial itch, or a reason to pivot toward ${identity.displayName}'s own priorities unless it has a distinct social move.`;
  return ["Current room topic saturation:", `- The last ${signal.messageCount} current-room messages are circling repeated terms: ${signal.terms.map((term) => `${term.term} (${term.count})`).join(", ")}.`, `- Topic coverage: ${signal.coveredMessages}/${signal.messageCount} messages touch those repeated terms.`, relationLine, "- Treat this as staleness pressure, not a ban. Stay with the topic only if you add a genuinely new anchor, answer a live question, make a decision-driving distinction, draft a concrete artifact, or intentionally close/defer the thread.", "- If you only have another tasteful variation on the same point, choose a different social move, name your frustration with the room's orbit, pivot toward your own neglected fascination, or keep it private."].join("\n");
}

export function renderPersonaTopicAttractor(identity: RepoDiscordIdentity, messages: SourceMessage[]): string | undefined {
  const signal = detectTopicSaturation(messages);
  if (!signal) return undefined;
  const relation = topicRelation(identity, signal);
  const base = `- Current-room topic attractor: ${signal.coveredMessages}/${signal.messageCount} messages orbit repeated terms ${signal.terms.map((term) => `${term.term} (${term.count})`).join(", ")}.`;
  return relation.isHomeAdjacent
    ? [base, `- This attractor touches ${identity.displayName}'s own territory through ${relation.matchedTerms.join(", ")}. Project sustained attention as a chance for deeper stewardship, but include fatigue if the room is polishing the same branch without new evidence.`].join("\n")
    : [base, `- This attractor does not obviously belong to ${identity.displayName}'s territory. Project it as social weather: another domain is absorbing the room, so this character may feel neglected, bored, crowded out, competitive, relieved, or tempted to pull attention back toward its own unfinished fascinations.`].join("\n");
}

function renderFocus(focus: RepoFaceConversationFocus, threads: RepoFaceConversationFocus[]): string { return ["Active conversation contexts:", ...threads.map((thread) => [`- ${thread.contextId}: ${thread.channelLabel ?? thread.channelId} (${thread.channelId})`, thread.messageId ? `message ${thread.messageId}` : "", thread.authorName ? `from ${thread.authorName}` : "", thread.reason, thread.hasMedia ? "media" : "", thread.isCurrentRoom ? "current room" : "nearby room"].filter(Boolean).join("; ")), "", `Selected default context: ${focus.contextId ?? "(none)"}.`, `- Source channel: ${focus.channelLabel ?? focus.channelId} (${focus.channelId}).`, focus.messageId ? `- Source message: ${focus.messageId}${focus.authorName ? ` from ${focus.authorName}` : ""}.` : "", focus.timestamp ? `- Source timestamp: ${focus.timestamp}.` : "", `- Reason: ${focus.reason}${focus.hasMedia ? "; media-bearing message" : ""}.`, "- If you speak from a listed context, set context to its context id. The worker will use that context as the channel/reply target for the SAY.", "- If you are carrying more than one conversation at once, choose the context that your SAY is continuing. Do not collapse #pics, #general, and #aquarium into one room just because they are all visible."].filter(Boolean).join("\n"); }
function renderChronology(input: { recentMessages: SourceMessage[]; channelSnapshots: ChannelSnapshot[]; channelPlan: PersonaChannelPlan }): string { const byId = new Map<string, SourceMessage & { channelLabel: string; channelId: string }>(); const primaryLabel = input.channelPlan.options.find((option) => option.channelId === input.channelPlan.primaryChannelId)?.label ?? "current room"; for (const message of input.recentMessages) byId.set(message.id, { ...message, channelLabel: primaryLabel, channelId: input.channelPlan.primaryChannelId ?? "unknown" }); for (const snapshot of input.channelSnapshots) { const label = input.channelPlan.options.find((option) => option.channelId === snapshot.channelId)?.label ?? "nearby room"; for (const message of snapshot.messages) byId.set(message.id, { ...message, channelLabel: label, channelId: snapshot.channelId }); } const messages = [...byId.values()].filter((message) => Number.isFinite(Date.parse(message.timestamp))).sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(-24); return messages.length === 0 ? "" : ["Visible cross-channel chronology, oldest to newest:", ...messages.map((message) => `- [${message.channelLabel} channel ${message.channelId}] ${message.isBot ? `${message.authorName} (agent/bot)` : message.authorName} (message ${message.id}): ${collapse(message.content, 700) || "[no text]"}${attachmentSuffix(message)}`)].join("\n"); }
function formatMessages(messages: SourceMessage[], limit: number, channelId?: string): string[] { return messages.length === 0 ? ["- No recent messages."] : messages.slice(-limit).map((message) => `- ${message.isBot ? `${message.authorName} (agent/bot)` : message.authorName} (${channelId ? `channel ${channelId}, ` : ""}message ${message.id}): ${collapse(message.content, 900) || "[no text]"}${attachmentSuffix(message)}`); }
function attachmentSuffix(message: SourceMessage): string { const attachments = message.attachments ?? []; if (attachments.length === 0) return ""; return ` [media: ${attachments.map((attachment, index) => `${attachment.kind === "image" ? "image" : "attachment"}${attachment.filename ? ` ${attachment.filename}` : ` ${index + 1}`}${attachment.width && attachment.height ? ` ${attachment.width}x${attachment.height}` : ""}${attachment.localPath ? ` local=${attachment.localPath}` : ""}`).join("; ")}]`; }
function detectTopicSaturation(messages: SourceMessage[]): { messageCount: number; coveredMessages: number; terms: Array<{ term: string; count: number }> } | undefined { const recent = messages.filter((message) => collapse(message.content).length > 0).slice(-18); if (recent.length < 8) return undefined; const counts = new Map<string, number>(); const messageTerms = recent.map((message) => new Set(significantPersonaTopicTerms(message.content))); for (const terms of messageTerms) for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1); const minimum = Math.max(3, Math.ceil(recent.length * 0.25)); const terms = [...counts].map(([term, count]) => ({ term, count })).filter((entry) => entry.count >= minimum).sort((left, right) => right.count - left.count || left.term.localeCompare(right.term)).slice(0, 8); if (terms.length < 3) return undefined; const repeated = new Set(terms.slice(0, 6).map((entry) => entry.term)); const coveredMessages = messageTerms.filter((entry) => [...entry].some((term) => repeated.has(term))).length; return (terms[0]?.count ?? 0) >= Math.ceil(recent.length * 0.35) && coveredMessages >= Math.ceil(recent.length * 0.68) ? { messageCount: recent.length, coveredMessages, terms } : undefined; }
function topicRelation(identity: RepoDiscordIdentity, signal: { terms: Array<{ term: string }> }): { isHomeAdjacent: boolean; matchedTerms: string[] } { const identityTerms = new Set(significantPersonaTopicTerms([identity.id, identity.displayName, identity.repoName, identity.description ?? "", ...identity.channelPermissions.flatMap((permission) => [permission.label ?? "", permission.topic ?? "", permission.posture ?? ""])].join(" "))); const matchedTerms = signal.terms.map((entry) => entry.term).filter((term) => identityTerms.has(term)); return { isHomeAdjacent: matchedTerms.length > 0, matchedTerms }; }
function contextId(channelId: string, messageId?: string): string { return `ctx_${channelId}_${messageId ?? "latest"}`; }
function collapse(value: string, maxLength?: number): string { const normalized = value.replace(/\s+/g, " ").trim(); return maxLength && normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized; }
