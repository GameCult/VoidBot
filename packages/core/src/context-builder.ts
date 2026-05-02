import {
  type Actor,
  type ContextBundle,
  type GuildContext,
  type InteractionMemoryProfile,
  type RetrievalResult,
  type SituationalSocialRead,
  type SourceGroundingHint,
  type SourceMessage,
  type StylePack,
} from "@voidbot/shared";

export interface BuildContextInput {
  prompt: string;
  actor: Actor;
  guildContext: GuildContext;
  recentMessages?: SourceMessage[];
  retrieval?: RetrievalResult[];
  interactionMemory?: InteractionMemoryProfile;
  situationalSocialRead?: SituationalSocialRead;
  sourceGrounding?: SourceGroundingHint;
  stylePack?: StylePack;
}

export class ContextBuilder {
  public build(input: BuildContextInput): ContextBundle {
    return {
      prompt: input.prompt,
      actor: input.actor,
      guildContext: input.guildContext,
      recentMessages: input.recentMessages ?? [],
      retrieval: input.retrieval ?? [],
      interactionMemory: input.interactionMemory,
      situationalSocialRead: input.situationalSocialRead,
      sourceGrounding: input.sourceGrounding,
      stylePack: input.stylePack,
      createdAt: new Date().toISOString(),
    };
  }
}
