import "dotenv/config";

import { loadConfig } from "@voidbot/config";
import { FileMessageArchiveRepository } from "@voidbot/rag";
import { readArchivedMessageKind, type ArchivedMessage } from "@voidbot/shared";

interface CliOptions {
  after?: string;
  hours?: number;
  limit: number;
  channelId?: string;
  includeBotPrompts: boolean;
}

interface OutputMessage {
  id: string;
  timestamp: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  content: string;
  attachments: string[];
  messageKind: string;
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__moderation_recent_history__";
  }

  const config = loadConfig();
  const options = parseArgs(process.argv.slice(2));
  const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
  const messages = await archiveRepository.listAllActive();
  const filtered = filterMessages(messages, options);
  const selected = filtered.slice(-options.limit);
  const outputMessages = selected.map(toOutputMessage);
  const transcript = outputMessages
    .map((message) => formatTranscriptLine(message))
    .join("\n");

  process.stdout.write(
    `${JSON.stringify(
      {
        after: options.after ?? null,
        hours: options.hours ?? null,
        channelId: options.channelId ?? null,
        includeBotPrompts: options.includeBotPrompts,
        totalMatchingMessages: filtered.length,
        returnedMessages: outputMessages.length,
        oldestReturnedTimestamp: outputMessages[0]?.timestamp ?? null,
        newestReturnedTimestamp:
          outputMessages[outputMessages.length - 1]?.timestamp ?? null,
        messages: outputMessages,
        transcript,
      },
      null,
      2,
    )}\n`,
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    limit: 80,
    includeBotPrompts: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--after":
        options.after = args[index + 1];
        index += 1;
        break;
      case "--hours":
        options.hours = Number.parseFloat(args[index + 1] ?? "");
        index += 1;
        break;
      case "--limit":
        options.limit = Number.parseInt(args[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--channel-id":
        options.channelId = args[index + 1];
        index += 1;
        break;
      case "--include-bot-prompts":
        options.includeBotPrompts = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.after) {
    validateIsoTimestamp(options.after, "--after");
  }

  if (options.hours !== undefined && (!Number.isFinite(options.hours) || options.hours <= 0)) {
    throw new Error("--hours must be a positive number.");
  }

  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("--limit must be a positive integer.");
  }

  return options;
}

function validateIsoTimestamp(value: string, flagName: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${flagName} must be a valid ISO timestamp.`);
  }
}

function filterMessages(messages: ArchivedMessage[], options: CliOptions): ArchivedMessage[] {
  const lowerBound =
    options.after ??
    (options.hours !== undefined
      ? new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString()
      : undefined);

  return messages
    .filter((message) => !message.deletedAt)
    .filter((message) => (options.includeBotPrompts ? true : readArchivedMessageKind(message) !== "bot_prompt"))
    .filter((message) => (options.channelId ? message.channelId === options.channelId : true))
    .filter((message) => (lowerBound ? message.timestamp > lowerBound : true))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function toOutputMessage(message: ArchivedMessage): OutputMessage {
  return {
    id: message.id,
    timestamp: message.timestamp,
    channelId: message.channelId,
    threadId: message.threadId,
    authorId: message.authorId,
    authorName: message.authorName,
    content: message.content,
    attachments: message.attachments ?? [],
    messageKind: readArchivedMessageKind(message),
  };
}

function formatTranscriptLine(message: OutputMessage): string {
  const threadSuffix = message.threadId ? ` thread=${message.threadId}` : "";
  const attachmentSuffix =
    message.attachments.length > 0
      ? ` [attachments: ${message.attachments.join(", ")}]`
      : "";
  return `[${message.timestamp}] ${message.authorName} (${message.authorId}) channel=${message.channelId}${threadSuffix}: ${message.content}${attachmentSuffix}`;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
