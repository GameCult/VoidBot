import {
  type Actor,
  type ContextBundle,
  type GuildContext,
  type InteractionMemoryProfile,
  type RetrievalResult,
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
      stylePack: input.stylePack,
      createdAt: new Date().toISOString(),
    };
  }
}
