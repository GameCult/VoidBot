import type { loadConfig } from "@voidbot/config";
import {
  createStateStorage,
  getRepoDiscordIdentityAllowedChannelIds,
  type RepoDiscordIdentity,
  type RepoFacePendingMention,
} from "@voidbot/core";

import type { InitiativeParticipant, ParticipantSpec as SchedulerParticipantSpec } from "./initiative-engine.js";
import type { PersonaStateObservation } from "./persona-state-source.js";
import { fetchChannelSnapshots, fetchRecentDiscordMessages } from "./turn-context-source.js";
import { readBifrostGovernanceDigest } from "./bifrost-governance-source.js";
import { coordinatePersonaMemoryTurn } from "./persona-memory-turn-coordinator.js";
import { readStoredPersonaHumanPronounGuidance } from "./persona-social-context-source.js";
import { projectNativePersonaBody } from "./persona-standard-state-projector.js";
import { readGlobalAgentDoctrine } from "./global-agent-doctrine-source.js";
import { assemblePersonaTurn } from "./persona-turn-assembler.js";
import { submitPersonaTurn } from "./turn-actuator.js";
import { launchVoidModerationTurn } from "./void-moderation-turn-actuator.js";
import { readRepoActivity } from "./repo-activity-source.js";
import { projectRepoActivityObservation } from "./repo-activity-projector.js";
import { buildPersonaChannelPlan, newestPendingMentionChannel, personaChannelSpeedMultiplier } from "./turn-routing.js";

export interface PersonaParticipantSpec extends SchedulerParticipantSpec {
  identity?: RepoDiscordIdentity;
}

export interface PersonaTurnStartReceipt {
  created: boolean;
  activeJobId?: string;
  requestMessageId?: string;
  failureReason?: string;
}

export function buildPersonaParticipantSpecs(identities: RepoDiscordIdentity[], includeVoid: boolean): PersonaParticipantSpec[] {
  return [
    ...(includeVoid ? [{ id: "void", participantKind: "system_agent" as const, turnKind: "void_moderation" as const, repoName: "VoidBot", displayName: "Void", allowedChannelIds: [], channelSpeedMultiplier: 1 }] : []),
    ...identities.map((identity) => ({
      id: identity.id,
      participantKind: identity.identityKind === "native_persona" ? "native_persona" as const : "repo_face" as const,
      turnKind: "repo_face_rumination" as const,
      repoName: identity.repoName,
      displayName: identity.displayName,
      allowedChannelIds: getRepoDiscordIdentityAllowedChannelIds(identity),
      channelSpeedMultiplier: personaChannelSpeedMultiplier(identity),
      identity,
    })),
  ];
}

export function pendingMentionsForPersona(state: { pendingMentions: RepoFacePendingMention[] }, identityId: string): RepoFacePendingMention[] {
  return state.pendingMentions.filter((mention) => mention.identityId === identityId).sort((left, right) => Date.parse(left.queuedAt) - Date.parse(right.queuedAt));
}

export function renderPersonaInitiativeAffinity(spec: PersonaParticipantSpec): string {
  return [
    `${spec.displayName} is the Persona steward of ${spec.repoName}.`,
    spec.identity?.description,
    ...(spec.identity?.channelPermissions ?? []).flatMap((permission) => [permission.topic, permission.label, permission.posture]),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
}

export async function dispatchPersonaParticipantTurn(input: {
  participant: InitiativeParticipant;
  pendingMentions: RepoFacePendingMention[];
  registryIdentities: RepoDiscordIdentity[];
  config: ReturnType<typeof loadConfig>;
  storage: Awaited<ReturnType<typeof createStateStorage>>;
  queuedAt: string;
  personaStateObservation?: PersonaStateObservation;
}): Promise<PersonaTurnStartReceipt> {
  if (input.participant.turnKind === "void_moderation") return launchVoidModerationTurn({ queuedAt: input.queuedAt, storageRoot: input.config.storageRoot, pendingMentions: input.pendingMentions });
  const identity = input.registryIdentities.find((entry) => entry.id === input.participant.identityId);
  if (!identity) return { created: false, failureReason: `No registered Persona identity exists for ${input.participant.identityId}.` };
  const channelPlan = buildPersonaChannelPlan(identity, input.config.repoFaceHeartbeats.defaultChannelId, newestPendingMentionChannel(input.pendingMentions));
  const channelId = channelPlan.primaryChannelId;
  if (!channelId) return { created: false, failureReason: "No CTB turn channel is configured for this Persona." };
  const [recentMessages, channelSnapshots, bifrostDigest] = await Promise.all([
    fetchRecentDiscordMessages({ botToken: input.config.botToken, channelId, limit: 15, ignoreBotMessages: channelId === input.config.bifrostDiscordChannelId }),
    fetchChannelSnapshots({ botToken: input.config.botToken, channelIds: channelPlan.snapshotChannelIds, primaryChannelId: channelId, limit: 6, bifrostDiscordChannelId: input.config.bifrostDiscordChannelId }),
    input.config.repoFaceBifrostEnabled && identity.identityKind !== "native_persona"
      ? readBifrostGovernanceDigest({ bifrostRoot: input.config.bifrostRoot, repoName: identity.repoName, agentIdentity: identity.id })
      : Promise.resolve(undefined),
  ]);
  const roomContext = { recentMessages, channelSnapshots };
  const humanPronounGuidance = await readStoredPersonaHumanPronounGuidance({ config: input.config, ...roomContext });
  const memoryContext = await coordinatePersonaMemoryTurn({ identity, config: input.config, registryIdentities: input.registryIdentities, ...roomContext, humanPronounGuidance, stateObservation: input.personaStateObservation });
  const repoActivitySurface = identity.identityKind === "native_persona"
    ? projectNativePersonaBody(identity)
    : projectRepoActivityObservation(readRepoActivity({ identity, storageRoot: input.config.storageRoot }));
  const globalAgentDoctrine = await readGlobalAgentDoctrine({ codexHome: process.env.CODEX_HOME, userProfile: process.env.USERPROFILE });
  const assembly = assemblePersonaTurn({
    identity, channelId, channelPlan, recentMessages, channelSnapshots, participant: input.participant,
    pendingMentions: input.pendingMentions, memorySurface: memoryContext.memorySurface,
    semanticMemoryRecallSurface: memoryContext.semanticMemoryRecallSurface, repoActivitySurface,
    humanPronounGuidance, bifrostDigest, githubActionsEnabled: input.config.repoFaceGithubActionsEnabled, globalAgentDoctrine,
  });
  return submitPersonaTurn({
    jobQueue: input.storage.jobQueue, provider: input.config.repoFaceHeartbeats.provider, identityId: identity.id,
    queuedAt: input.queuedAt, channelId, prompt: assembly.prompt, recentMessages,
    conversationFocus: assembly.conversation.focus, conversationThreads: assembly.conversation.threads,
    imageAttachments: assembly.imageAttachments,
  });
}
