import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PERSONA_WEBHOOK_NAME = "VoidBot Persona Pipe";
const PERSONA_WEBHOOK_CACHE_PATH = resolve(
  repoRoot,
  ".voidbot/private/discord-webhook-cache.json",
);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = readLocalEnv();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const persona = normalizePersonaOptions(options);

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
    await postChunkedDiscordMessage(botToken, channelId, content, undefined, undefined);
    writeLastSpeechStatus({
      sentAt: new Date().toISOString(),
      mode: "owner_dm",
      transport: "bot",
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
    persona,
  );
  writeLastSpeechStatus({
    sentAt: new Date().toISOString(),
    mode: "channel",
    transport: persona ? "webhook" : "bot",
    channelId: options.channelId,
    replyToMessageId: options.replyToMessageId ?? null,
    personaName: persona?.personaName ?? null,
    personaAvatarUrl: persona?.personaAvatarUrl ?? null,
    contentLength: content.length,
    chunkCount: splitDiscordContent(content).length,
    preview: content.slice(0, 280),
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mode: "channel",
      transport: persona ? "webhook" : "bot",
      channelId: options.channelId,
      replyToMessageId: options.replyToMessageId ?? null,
      personaName: persona?.personaName ?? null,
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
    personaName: undefined,
    personaAvatarUrl: undefined,
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
      case "--persona-name":
        options.personaName = args[index + 1];
        index += 1;
        break;
      case "--persona-avatar-url":
        options.personaAvatarUrl = args[index + 1];
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
    const raw = stripLeadingBom(readTextFileFlexible(envPath));
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
    return stripLeadingBom(readTextFileFlexible(resolve(repoRoot, options.contentFile)));
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

async function postChunkedDiscordMessage(
  botToken,
  channelId,
  content,
  replyToMessageId,
  persona,
) {
  const chunks = splitDiscordContent(content);

  for (let index = 0; index < chunks.length; index += 1) {
    const replyTarget = index === 0 ? replyToMessageId : undefined;
    if (persona) {
      await postDiscordWebhookMessage(botToken, channelId, chunks[index], replyTarget, persona);
    } else {
      await postDiscordMessage(
        botToken,
        channelId,
        chunks[index],
        replyTarget,
      );
    }
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

async function postDiscordWebhookMessage(
  botToken,
  channelId,
  content,
  replyToMessageId,
  persona,
) {
  const target = await resolveWebhookTarget(botToken, channelId);
  let webhook = await getCachedPersonaWebhook(target.webhookChannelId);

  if (!webhook) {
    webhook = await createPersonaWebhook(botToken, target.webhookChannelId);
    writeCachedPersonaWebhook(target.webhookChannelId, webhook);
  }

  try {
    await executePersonaWebhook(webhook, {
      threadId: target.threadId,
      content,
      replyToMessageId,
      username: persona.personaName,
      avatarUrl: persona.personaAvatarUrl,
    });
  } catch (error) {
    if (!isStaleWebhookError(error)) {
      throw error;
    }

    clearCachedPersonaWebhook(target.webhookChannelId);
    const refreshedWebhook = await createPersonaWebhook(botToken, target.webhookChannelId);
    writeCachedPersonaWebhook(target.webhookChannelId, refreshedWebhook);
    await executePersonaWebhook(refreshedWebhook, {
      threadId: target.threadId,
      content,
      replyToMessageId,
      username: persona.personaName,
      avatarUrl: persona.personaAvatarUrl,
    });
  }
}

async function resolveWebhookTarget(botToken, channelId) {
  const channel = await getDiscordChannel(botToken, channelId);

  if (THREAD_CHANNEL_TYPES.has(channel.type)) {
    if (!channel.parent_id) {
      throw new Error(`Discord thread ${channelId} has no parent channel for webhook routing.`);
    }

    return {
      webhookChannelId: channel.parent_id,
      threadId: channel.id,
    };
  }

  return {
    webhookChannelId: channel.id,
    threadId: undefined,
  };
}

async function getDiscordChannel(botToken, channelId) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
    method: "GET",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Discord channel: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();

  if (!payload?.id || typeof payload.type !== "number") {
    throw new Error(`Discord channel lookup for ${channelId} returned malformed data.`);
  }

  return payload;
}

async function createPersonaWebhook(botToken, channelId) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: PERSONA_WEBHOOK_NAME,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create Discord webhook: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();

  if (!payload?.id || !payload?.token) {
    throw new Error(`Discord webhook creation for channel ${channelId} returned no executable token.`);
  }

  return {
    id: payload.id,
    token: payload.token,
    channelId,
    name: PERSONA_WEBHOOK_NAME,
    createdAt: new Date().toISOString(),
  };
}

async function executePersonaWebhook(
  webhook,
  { threadId, content, replyToMessageId, username, avatarUrl },
) {
  const url = new URL(`https://discord.com/api/v10/webhooks/${webhook.id}/${webhook.token}`);
  url.searchParams.set("wait", "true");

  if (threadId) {
    url.searchParams.set("thread_id", threadId);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      username,
      avatar_url: avatarUrl,
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
    throw new Error(`Failed to execute Discord webhook: ${response.status} ${await response.text()}`);
  }
}

function normalizePersonaOptions(options) {
  const personaName = trimOptionalString(options.personaName);
  const personaAvatarUrl = trimOptionalString(options.personaAvatarUrl);

  if (!personaName && !personaAvatarUrl) {
    return undefined;
  }

  if (!personaName) {
    throw new Error("personaName is required when using the shared persona webhook pipe.");
  }

  return {
    personaName: personaName.slice(0, 80),
    personaAvatarUrl,
  };
}

function trimOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getCachedPersonaWebhook(channelId) {
  const cache = readPersonaWebhookCache();
  return cache[channelId];
}

function writeCachedPersonaWebhook(channelId, webhook) {
  const cache = readPersonaWebhookCache();
  cache[channelId] = webhook;
  writePersonaWebhookCache(cache);
}

function clearCachedPersonaWebhook(channelId) {
  const cache = readPersonaWebhookCache();
  if (cache[channelId]) {
    delete cache[channelId];
    writePersonaWebhookCache(cache);
  }
}

function readPersonaWebhookCache() {
  try {
    const raw = stripLeadingBom(readTextFileFlexible(PERSONA_WEBHOOK_CACHE_PATH));
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }

    if (error instanceof SyntaxError) {
      return {};
    }

    throw error;
  }
}

function writePersonaWebhookCache(cache) {
  mkdirSync(dirname(PERSONA_WEBHOOK_CACHE_PATH), { recursive: true });
  writeFileSync(PERSONA_WEBHOOK_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function isStaleWebhookError(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Failed to execute Discord webhook: 401") ||
    error.message.includes("Failed to execute Discord webhook: 404")
  );
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

function readTextFileFlexible(path) {
  const buffer = readFileSync(path);

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buffer.subarray(3));
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }

  return new TextDecoder("utf-8").decode(buffer);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
