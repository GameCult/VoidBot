import { ContextBuilder, type JobQueue } from "@voidbot/core";
import type {
  PromptImageAttachment,
  ProviderName,
  RepoFaceConversationFocus,
  SourceMessage,
} from "@voidbot/shared";

const PERSONA_TURN_COMMAND = "repo-face-rumination" as const;

export interface PersonaTurnReceipt {
  created: boolean;
  activeJobId: string;
  requestMessageId: string;
}

export async function submitPersonaTurn(input: {
  jobQueue: Pick<JobQueue, "createJob">;
  provider: ProviderName;
  identityId: string;
  queuedAt: string;
  channelId: string;
  prompt: string;
  recentMessages: SourceMessage[];
  conversationFocus?: RepoFaceConversationFocus;
  conversationThreads: RepoFaceConversationFocus[];
  imageAttachments: PromptImageAttachment[];
}): Promise<PersonaTurnReceipt> {
  const actor = {
    id: "voidbot-agent-turn",
    displayName: "VoidBot Agent Turn",
    isAdmin: true,
    isBot: true,
  };
  const guildContext = { channelId: input.channelId };
  const contextBundle = new ContextBuilder().build({
    prompt: input.prompt,
    actor,
    guildContext,
    recentMessages: input.recentMessages,
    repoFaceConversationFocus: input.conversationFocus,
    repoFaceConversationThreads: input.conversationThreads,
    imageAttachments: input.imageAttachments,
    retrieval: [],
    voidSelfState: undefined,
  });
  const requestMessageId = `agent-turn:${input.identityId}:${input.queuedAt}`;
  const result = await input.jobQueue.createJob({
    command: PERSONA_TURN_COMMAND,
    provider: input.provider,
    runApprovalRequired: false,
    postApprovalRequired: false,
    requester: actor,
    guildContext,
    prompt: input.prompt,
    contextBundle,
    outputChannelId: input.channelId,
    requestMessageId,
    initialState: "approved",
  });
  return {
    created: result.created,
    activeJobId: result.job.id,
    requestMessageId,
  };
}
