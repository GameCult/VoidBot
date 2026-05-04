import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const archivePath = resolve(
    repoRoot,
    readConfiguredArchivePath() ?? ".voidbot/rag/messages.json",
  );
  const store = readArchiveStore(archivePath);
  const filtered = filterMessages(store.messages ?? [], options);
  const selected = filtered.slice(-options.limit);
  const outputMessages = selected.map(toOutputMessage);
  const transcript = outputMessages.map(formatTranscriptLine).join("\n");

  process.stdout.write(
    `${JSON.stringify(
      {
        after: options.after ?? null,
        hours: options.hours ?? null,
        channelId: options.channelId ?? null,
        includeBotPrompts: options.includeBotPrompts,
        archivePath,
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

function parseArgs(args) {
  const options = {
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

function validateIsoTimestamp(value, flagName) {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${flagName} must be a valid ISO timestamp.`);
  }
}

function readConfiguredArchivePath() {
  if (process.env.RAG_ARCHIVE_PATH?.trim()) {
    return process.env.RAG_ARCHIVE_PATH.trim();
  }

  const envPath = resolve(repoRoot, ".env");

  try {
    const raw = stripLeadingBom(readFileSync(envPath, "utf8"));
    const parsed = parseDotEnv(raw);
    return parsed.RAG_ARCHIVE_PATH?.trim() || undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function parseDotEnv(raw) {
  const result = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function readArchiveStore(archivePath) {
  const raw = stripLeadingBom(readFileSync(archivePath, "utf8"));
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
    throw new Error(`Archive at ${archivePath} does not have a messages array.`);
  }

  return parsed;
}

function filterMessages(messages, options) {
  const lowerBound =
    options.after ??
    (options.hours !== undefined
      ? new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString()
      : undefined);

  return messages
    .filter((message) => !message.deletedAt)
    .filter((message) =>
      options.includeBotPrompts ? true : readMessageKind(message) !== "bot_prompt",
    )
    .filter((message) => (options.channelId ? message.channelId === options.channelId : true))
    .filter((message) => (lowerBound ? message.timestamp > lowerBound : true))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function readMessageKind(message) {
  return message?.metadata?.messageKind === "bot_prompt" ? "bot_prompt" : "default";
}

function toOutputMessage(message) {
  return {
    id: message.id,
    timestamp: message.timestamp,
    channelId: message.channelId,
    threadId: message.threadId,
    authorId: message.authorId,
    authorName: message.authorName,
    content: message.content,
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    messageKind: readMessageKind(message),
  };
}

function formatTranscriptLine(message) {
  const threadSuffix = message.threadId ? ` thread=${message.threadId}` : "";
  const attachmentSuffix =
    message.attachments.length > 0
      ? ` [attachments: ${message.attachments.join(", ")}]`
      : "";
  return `[${message.timestamp}] ${message.authorName} (${message.authorId}) channel=${message.channelId}${threadSuffix}: ${message.content}${attachmentSuffix}`;
}

function stripLeadingBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
