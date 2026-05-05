import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = readLocalEnv();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();

  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required.");
  }

  const content = await readContent(options);

  if (content.trim().length === 0) {
    throw new Error("Message content is empty.");
  }

  if (options.ownerDm) {
    const ownerId = env.DISCORD_OWNER_ID?.trim();

    if (!ownerId) {
      throw new Error("DISCORD_OWNER_ID is required for --owner-dm.");
    }

    const channelId = await openOwnerDmChannel(botToken, ownerId);
    await postChunkedDiscordMessage(botToken, channelId, content);
    writeLastSpeechStatus({
      sentAt: new Date().toISOString(),
      mode: "owner_dm",
      channelId,
      contentLength: content.length,
      chunkCount: splitDiscordContent(content).length,
      preview: content.slice(0, 280),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "owner_dm", channelId })}\n`);
    return;
  }

  if (!options.channelId) {
    throw new Error("Provide --owner-dm or --channel-id.");
  }

  await postChunkedDiscordMessage(
    botToken,
    options.channelId,
    content,
    options.replyToMessageId,
  );
  writeLastSpeechStatus({
    sentAt: new Date().toISOString(),
    mode: "channel",
    channelId: options.channelId,
    replyToMessageId: options.replyToMessageId ?? null,
    contentLength: content.length,
    chunkCount: splitDiscordContent(content).length,
    preview: content.slice(0, 280),
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mode: "channel",
      channelId: options.channelId,
      replyToMessageId: options.replyToMessageId ?? null,
    })}\n`,
  );
}

function parseArgs(args) {
  const options = {
    ownerDm: false,
    channelId: undefined,
    replyToMessageId: undefined,
    content: undefined,
    contentFile: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--owner-dm":
        options.ownerDm = true;
        break;
      case "--channel-id":
        options.channelId = args[index + 1];
        index += 1;
        break;
      case "--reply-to":
        options.replyToMessageId = args[index + 1];
        index += 1;
        break;
      case "--content":
        options.content = args[index + 1];
        index += 1;
        break;
      case "--content-file":
        options.contentFile = args[index + 1];
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.ownerDm && options.channelId) {
    throw new Error("Use either --owner-dm or --channel-id, not both.");
  }

  return options;
}

function readLocalEnv() {
  const envPath = resolve(repoRoot, ".env");
  const parsed = { ...process.env };

  try {
    const raw = stripLeadingBom(readFileSync(envPath, "utf8"));
    Object.assign(parsed, parseDotEnv(raw));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return parsed;
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

async function readContent(options) {
  if (typeof options.content === "string") {
    return options.content;
  }

  if (typeof options.contentFile === "string") {
    return stripLeadingBom(readFileSync(resolve(repoRoot, options.contentFile), "utf8"));
  }

  return new Promise((resolveContent, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolveContent(input));
    process.stdin.on("error", reject);
  });
}

async function openOwnerDmChannel(botToken, recipientId) {
  const response = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient_id: recipientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to open Discord DM channel: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();

  if (!payload?.id) {
    throw new Error("Discord DM channel creation returned no channel id.");
  }

  return payload.id;
}

async function postChunkedDiscordMessage(botToken, channelId, content, replyToMessageId) {
  const chunks = splitDiscordContent(content);

  for (let index = 0; index < chunks.length; index += 1) {
    await postDiscordMessage(
      botToken,
      channelId,
      chunks[index],
      index === 0 ? replyToMessageId : undefined,
    );
  }
}

async function postDiscordMessage(botToken, channelId, content, replyToMessageId) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      message_reference: replyToMessageId
        ? {
            message_id: replyToMessageId,
            fail_if_not_exists: false,
          }
        : undefined,
      allowed_mentions: {
        parse: [],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post Discord message: ${response.status} ${await response.text()}`);
  }
}

function splitDiscordContent(input, limit = 1900) {
  const normalized = input.replace(/\r\n/g, "\n").trim();

  if (normalized.length === 0) {
    return ["(empty response)"];
  }

  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > limit) {
    const splitIndex = findSplitIndex(remaining, limit);
    const nextChunk = remaining.slice(0, splitIndex).trim();
    chunks.push(nextChunk.length > 0 ? nextChunk : remaining.slice(0, limit));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitIndex(input, limit) {
  const doubleNewline = input.lastIndexOf("\n\n", limit);

  if (doubleNewline >= Math.floor(limit * 0.6)) {
    return doubleNewline + 2;
  }

  const newline = input.lastIndexOf("\n", limit);

  if (newline >= Math.floor(limit * 0.6)) {
    return newline + 1;
  }

  const space = input.lastIndexOf(" ", limit);

  if (space >= Math.floor(limit * 0.6)) {
    return space + 1;
  }

  return limit;
}

function writeLastSpeechStatus(payload) {
  const statusPath = resolve(repoRoot, ".voidbot/status/void-last-speech.json");
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function stripLeadingBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
