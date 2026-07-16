import { postDiscordViaBifrostCultMesh, type BifrostDiscordCommandConfig } from "@voidbot/core";

export interface VoidBifrostDeliveryConfig extends BifrostDiscordCommandConfig {}

export async function deliverVoidCandidateViaBifrost(input: {
  candidateId: string;
  channelId: string;
  replyToMessageId?: string;
  content: string;
  personaName: string;
  personaAvatarUrl?: string;
}, config: VoidBifrostDeliveryConfig): Promise<{ messageId: string; transport: string }> {
  const receipt = await postDiscordViaBifrostCultMesh({
    idempotencyKey: JSON.stringify({
      candidateId: input.candidateId,
      channelId: input.channelId,
      replyToMessageId: input.replyToMessageId ?? "",
      content: input.content,
    }),
    source: { kind: "voidbot.void.candidate", id: input.candidateId },
    actor: { id: "void", displayName: input.personaName },
    channelId: input.channelId,
    content: input.content,
    replyToMessageId: input.replyToMessageId,
    personaAvatarUrl: input.personaAvatarUrl,
  }, config);
  return { messageId: receipt.messageId, transport: receipt.transport };
}
