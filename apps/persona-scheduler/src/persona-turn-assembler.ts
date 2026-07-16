import type { RepoDiscordIdentity, RepoFacePendingMention } from "@voidbot/core";
import type { PromptImageAttachment, SourceMessage } from "@voidbot/shared";

import type { BifrostGovernanceDigest } from "./bifrost-governance-source.js";
import type { GlobalAgentDoctrineObservation } from "./global-agent-doctrine-source.js";
import type { InitiativeParticipant } from "./initiative-engine.js";
import { projectPersonaConversation, type PersonaConversationProjection } from "./persona-conversation-projector.js";
import type { PersonaHumanPronounGuidance } from "./persona-social-context-projector.js";
import { buildPersonaJurisdictionDiveDirective, buildPersonaTurnPrompt } from "./persona-turn-prompt-projector.js";
import type { ChannelSnapshot } from "./turn-context-source.js";
import type { PersonaChannelPlan } from "./turn-routing.js";

export interface PersonaTurnAssemblyInput {
  identity: RepoDiscordIdentity;
  channelId: string;
  channelPlan: PersonaChannelPlan;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  participant: InitiativeParticipant;
  pendingMentions: RepoFacePendingMention[];
  memorySurface?: string;
  semanticMemoryRecallSurface?: string;
  repoActivitySurface?: string;
  conversationMemorySurface?: string;
  humanPronounGuidance?: PersonaHumanPronounGuidance[];
  bifrostDigest?: BifrostGovernanceDigest;
  githubActionsEnabled: boolean;
  globalAgentDoctrine: GlobalAgentDoctrineObservation;
}

export interface PersonaTurnAssembly {
  prompt: string;
  conversation: PersonaConversationProjection;
  imageAttachments: PromptImageAttachment[];
}

export function assemblePersonaTurn(input: PersonaTurnAssemblyInput): PersonaTurnAssembly {
  const conversation = projectPersonaConversation({
    identity: input.identity,
    recentMessages: input.recentMessages,
    channelSnapshots: input.channelSnapshots,
    pendingMentions: input.pendingMentions,
    channelPlan: input.channelPlan,
  });
  const prompt = buildPersonaTurnPrompt({
    identity: input.identity,
    channelId: input.channelId,
    channelPlan: input.channelPlan,
    channelSnapshots: input.channelSnapshots,
    recentMessages: input.recentMessages,
    memorySurface: input.memorySurface,
    semanticMemoryRecallSurface: input.semanticMemoryRecallSurface,
    repoActivitySurface: input.repoActivitySurface,
    conversationMemorySurface: input.conversationMemorySurface ?? conversation.transcript,
    humanPronounGuidance: input.humanPronounGuidance,
    bifrostDigest: input.bifrostDigest,
    participant: input.participant,
    pendingMentions: input.pendingMentions,
    jurisdictionDive: buildPersonaJurisdictionDiveDirective(input.identity, input.participant),
    githubActionsEnabled: input.githubActionsEnabled,
    globalAgentDoctrine: renderGlobalAgentDoctrine(input.globalAgentDoctrine),
  });
  return {
    prompt,
    conversation,
    imageAttachments: collectPromptImages([input.recentMessages, ...input.channelSnapshots.map((snapshot) => snapshot.messages)].flat()),
  };
}

function renderGlobalAgentDoctrine(observation: GlobalAgentDoctrineObservation): string {
  if (observation.status === "ok") return observation.doctrine;
  return [
    "# Global Agent Instructions Unavailable",
    "",
    "The global Codex AGENTS.md source returned no readable doctrine.",
    "This is an inspection failure, not replacement guidance. Do not claim global guidance was available for this turn.",
    "",
    "Attempted paths:",
    ...observation.errors.map((error) => `- ${error}`),
  ].join("\n");
}

function collectPromptImages(messages: SourceMessage[]): PromptImageAttachment[] {
  const seen = new Set<string>();
  const images: PromptImageAttachment[] = [];
  for (const message of messages) for (const attachment of message.attachments ?? []) {
    if (attachment.kind !== "image" || !attachment.localPath || seen.has(attachment.localPath)) continue;
    seen.add(attachment.localPath);
    images.push({ messageId: message.id, authorName: message.authorName, filename: attachment.filename, contentType: attachment.contentType, localPath: attachment.localPath });
  }
  return images.slice(0, 8);
}
