import {
  type Actor,
  type ContextBundle,
  type GuildContext,
  type InteractionMemoryProfile,
  type PromptImageAttachment,
  type RetrievalResult,
  type SituationalSocialRead,
  type SourceGroundingHint,
  type SourceMessage,
  type StylePack,
  type VoidSelfStateContext,
} from "@voidbot/shared";

export interface BuildContextInput {
  prompt: string;
  actor: Actor;
  guildContext: GuildContext;
  recentMessages?: SourceMessage[];
  imageAttachments?: PromptImageAttachment[];
  retrieval?: RetrievalResult[];
  interactionMemory?: InteractionMemoryProfile;
  situationalSocialRead?: SituationalSocialRead;
  sourceGrounding?: SourceGroundingHint;
  stylePack?: StylePack;
  voidSelfState?: VoidSelfStateContext;
}

export class ContextBuilder {
  public build(input: BuildContextInput): ContextBundle {
    return {
      prompt: input.prompt,
      actor: input.actor,
      guildContext: input.guildContext,
      recentMessages: input.recentMessages ?? [],
      imageAttachments: input.imageAttachments,
      retrieval: input.retrieval ?? [],
      interactionMemory: input.interactionMemory,
      situationalSocialRead: input.situationalSocialRead,
      sourceGrounding: input.sourceGrounding,
      stylePack: input.stylePack,
      voidSelfState: input.voidSelfState,
      createdAt: new Date().toISOString(),
    };
  }
}
