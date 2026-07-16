import type { RepoDiscordIdentity, VoidSelfStateTypedProjection } from "@voidbot/core";
import type { SourceMessage } from "@voidbot/shared";

import { renderPersonaTopicAttractor } from "./persona-conversation-projector.js";
import { composePersonaMemoryPacket, renderPersonaPressureSections, renderPersonaTypedStateSections } from "./persona-memory-projector.js";
import { projectPersonaSocialContext, type PersonaHumanPronounGuidance } from "./persona-social-context-projector.js";
import type { ChannelSnapshot } from "./turn-context-source.js";

export interface PersonaStatePacketInput {
  identity: RepoDiscordIdentity;
  state: VoidSelfStateTypedProjection;
  registryIdentities?: RepoDiscordIdentity[];
  roomContext?: { recentMessages: SourceMessage[]; channelSnapshots: ChannelSnapshot[] };
  humanPronounGuidance?: PersonaHumanPronounGuidance[];
  curiosityGraphFacts?: string;
  observedAt: Date;
}

export function projectPersonaStatePacket(input: PersonaStatePacketInput): string {
  const identityName = input.identity.displayName;
  const typed = renderPersonaTypedStateSections({ identityName, state: input.state });
  const social = projectPersonaSocialContext({
    identity: input.identity,
    registryIdentities: input.registryIdentities ?? [],
    state: input.state,
    recentMessages: input.roomContext?.recentMessages ?? [],
    channelSnapshots: input.roomContext?.channelSnapshots ?? [],
    pronounGuidance: input.humanPronounGuidance ?? [],
    observedAt: input.observedAt,
    topicAttractorFacts: input.roomContext
      ? renderPersonaTopicAttractor(input.identity, input.roomContext.recentMessages)
      : undefined,
  });
  return composePersonaMemoryPacket({
    identityName,
    typed,
    relationshipFreshness: social.relationshipFreshness,
    socialGraph: social.socialGraph,
    peerOpening: social.peerOpening,
    socialPressure: social.socialPressure,
    pronouns: social.pronouns,
    roomTexture: social.roomTexture,
    curiosity: input.curiosityGraphFacts,
    pressureSections: renderPersonaPressureSections({ identityName, state: input.state, clarityPressureActive: Boolean(social.humanClarity) }),
    humanClarity: social.humanClarity,
  });
}
