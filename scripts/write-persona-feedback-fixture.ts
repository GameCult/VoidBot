import { exportPersonaFeedbackObservation } from "../packages/core/src/persona-feedback-observation";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const eventId = await exportPersonaFeedbackObservation(
    {
      guildId: arg("--guild-id"),
      channelId: arg("--channel-id"),
      messageId: arg("--message-id"),
      authorId: arg("--author-id"),
      authorName: "fixture-human",
      observedAt: "2026-07-18T00:00:00Z",
      addressingMode: "role",
      content: arg("--content"),
      targetPersonaId: "epiphany",
      targetRepoName: "GameCult/Epiphany",
      targetRuntimeId: "epiphany-yggdrasil",
    },
    {
      storePath: arg("--store"),
      bifrostRoot: arg("--bifrost-root"),
      producerRuntimeId: "voidbot-yggdrasil",
    },
  );

  process.stdout.write(`${JSON.stringify({ eventId })}\n`);
}

void main();
