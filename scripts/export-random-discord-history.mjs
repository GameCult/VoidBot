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

  if (filtered.length === 0) {
    process.stdout.write(
      `${JSON.stringify(
        {
          archivePath,
          before: options.before ?? null,
          after: options.after ?? null,
          channelId: options.channelId ?? null,
          includeBotPrompts: options.includeBotPrompts,
          totalCandidateMessages: 0,
          anchor: null,
          messages: [],
          transcript: "",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const rng = createRandom(options.seed);
  const anchor = filtered[Math.floor(rng() * filtered.length)];
  const sameChannelMessages = filterMessages(store.messages ?? [], {
    ...options,
    channelId: anchor.channelId,
    minContentLength: 0,
  });
  const anchorIndex = sameChannelMessages.findIndex((message) => message.id === anchor.id);
  const startIndex = Math.max(0, anchorIndex - options.window);
  const endIndex = Math.min(sameChannelMessages.length, anchorIndex + options.window + 1);
  const surrounding = sameChannelMessages.slice(startIndex, endIndex).map(toOutputMessage);
  const transcript = surrounding.map(formatTranscriptLine).join("\n");

  process.stdout.write(
    `${JSON.stringify(
      {
        archivePath,
        before: options.before ?? null,
        after: options.after ?? null,
        channelId: options.channelId ?? null,
        includeBotPrompts: options.includeBotPrompts,
        totalCandidateMessages: filtered.length,
        window: options.window,
        seed: options.seed ?? null,
        anchor: toOutputMessage(anchor),
        messages: surrounding,
        transcript,
      },
      null,
      2,
    )}\n`,
  );
}

function parseArgs(args) {
  const options = {
    window: 6,
    minContentLength: 20,
    includeBotPrompts: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--before":
        options.before = args[index + 1];
        index += 1;
        break;
      case "--after":
        options.after = args[index + 1];
        index += 1;
        break;
      case "--window":
        options.window = Number.parseInt(args[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--channel-id":
        options.channelId = args[index + 1];
        index += 1;
        break;
      case "--min-content-length":
        options.minContentLength = Number.parseInt(args[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--seed":
        options.seed = args[index + 1];
        index += 1;
        break;
      case "--include-bot-prompts":
        options.includeBotPrompts = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.before) {
    validateIsoTimestamp(options.before, "--before");
  }

  if (options.after) {
    validateIsoTimestamp(options.after, "--after");
  }

  if (!Number.isInteger(options.window) || options.window < 0) {
    throw new Error("--window must be a non-negative integer.");
  }

  if (!Number.isInteger(options.minContentLength) || options.minContentLength < 0) {
    throw new Error("--min-content-length must be a non-negative integer.");
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
  const beforeMs = options.before !== undefined ? parseTimestampToMs(options.before) : undefined;
  const afterMs = options.after !== undefined ? parseTimestampToMs(options.after) : undefined;

  return messages
    .filter((message) => !message.deletedAt)
    .filter((message) =>
      options.includeBotPrompts ? true : readMessageKind(message) !== "bot_prompt",
    )
    .filter((message) => (options.channelId ? message.channelId === options.channelId : true))
    .filter((message) => {
      if (beforeMs === undefined) {
        return true;
      }

      const messageMs = parseTimestampToMs(message.timestamp);
      return messageMs !== undefined && messageMs < beforeMs;
    })
    .filter((message) => {
      if (afterMs === undefined) {
        return true;
      }

      const messageMs = parseTimestampToMs(message.timestamp);
      return messageMs !== undefined && messageMs > afterMs;
    })
    .filter((message) => normalizeContent(message.content).length >= (options.minContentLength ?? 0))
    .sort(compareMessagesByTimestamp);
}

function normalizeContent(content) {
  return typeof content === "string" ? content.trim() : "";
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

function createRandom(seed) {
  if (!seed) {
    return Math.random;
  }

  let value = hashSeed(seed);
  return () => {
    value += 0x6d2b79f5;
    let intermediate = Math.imul(value ^ (value >>> 15), 1 | value);
    intermediate ^= intermediate + Math.imul(intermediate ^ (intermediate >>> 7), 61 | intermediate);
    return ((intermediate ^ (intermediate >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  let hash = 2166136261;

  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function compareMessagesByTimestamp(left, right) {
  const leftMs = parseTimestampToMs(left.timestamp);
  const rightMs = parseTimestampToMs(right.timestamp);

  if (leftMs !== undefined && rightMs !== undefined && leftMs !== rightMs) {
    return leftMs - rightMs;
  }

  if (left.timestamp !== right.timestamp) {
    return left.timestamp.localeCompare(right.timestamp);
  }

  return String(left.id ?? "").localeCompare(String(right.id ?? ""));
}

function parseTimestampToMs(value) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
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
