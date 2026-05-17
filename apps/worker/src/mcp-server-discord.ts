import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PERSONA_WEBHOOK_NAME = "VoidBot Persona Pipe";
const PERSONA_WEBHOOK_CACHE_PATH = resolve(
  __dirname,
  "../../../.voidbot/private/discord-webhook-cache.json",
);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

export interface DiscordPersonaOptions {
  personaName?: string;
  personaAvatarUrl?: string;
}

interface NormalizedDiscordPersonaOptions {
  personaName: string;
  personaAvatarUrl?: string;
}

interface CachedWebhookRecord {
  id: string;
  token: string;
  channelId: string;
  name: string;
  createdAt: string;
  configured?: boolean;
}

export async function openOwnerDmChannel(
  botToken: string,
  recipientId: string,
): Promise<string> {
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

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord DM channel creation returned no channel id.");
  }

  return payload.id;
}

export async function postDiscordMessage(
  botToken: string,
  channelId: string,
  content: string,
  replyToMessageId?: string,
  persona?: DiscordPersonaOptions,
): Promise<{ id: string; transport: "bot" | "webhook" }> {
  const normalizedPersona = normalizePersonaOptions(persona);

  if (normalizedPersona) {
    return postDiscordPersonaMessage(
      botToken,
      channelId,
      content,
      normalizedPersona,
      replyToMessageId,
    );
  }

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

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord message post returned no message id.");
  }

  return { id: payload.id, transport: "bot" };
}

async function postDiscordPersonaMessage(
  botToken: string,
  channelId: string,
  content: string,
  persona: NormalizedDiscordPersonaOptions,
  replyToMessageId?: string,
): Promise<{ id: string; transport: "webhook" }> {
  const target = await resolveWebhookTarget(botToken, channelId);
  const configuredWebhook = await getConfiguredPersonaWebhook(target.webhookChannelId);
  let webhook = configuredWebhook ?? getCachedPersonaWebhook(target.webhookChannelId);

  if (!webhook) {
    webhook = await createPersonaWebhook(botToken, target.webhookChannelId);
    writeCachedPersonaWebhook(target.webhookChannelId, webhook);
  }

  try {
    return await executePersonaWebhook(webhook, {
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

    if (configuredWebhook) {
      throw new Error(
        `Configured persona webhook for channel ${target.webhookChannelId} is no longer executable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    clearCachedPersonaWebhook(target.webhookChannelId);
    const refreshedWebhook = await createPersonaWebhook(botToken, target.webhookChannelId);
    writeCachedPersonaWebhook(target.webhookChannelId, refreshedWebhook);
    return executePersonaWebhook(refreshedWebhook, {
      threadId: target.threadId,
      content,
      replyToMessageId,
      username: persona.personaName,
      avatarUrl: persona.personaAvatarUrl,
    });
  }
}

async function resolveWebhookTarget(botToken: string, channelId: string): Promise<{
  webhookChannelId: string;
  threadId?: string;
}> {
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

async function getDiscordChannel(
  botToken: string,
  channelId: string,
): Promise<{ id: string; type: number; parent_id?: string }> {
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

  const payload = (await response.json()) as { id?: string; type?: number; parent_id?: string };

  if (!payload.id || typeof payload.type !== "number") {
    throw new Error(`Discord channel lookup for ${channelId} returned malformed data.`);
  }

  return {
    id: payload.id,
    type: payload.type,
    parent_id: payload.parent_id,
  };
}

async function createPersonaWebhook(
  botToken: string,
  channelId: string,
): Promise<CachedWebhookRecord> {
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
    const detail = await response.text();
    throw new Error(
      `Failed to create Discord webhook for channel ${channelId}: ${response.status} ${detail}. ` +
        `Grant the bot Manage Webhooks there or configure DISCORD_PERSONA_WEBHOOK_URL_${channelId}.`,
    );
  }

  const payload = (await response.json()) as { id?: string; token?: string };

  if (!payload.id || !payload.token) {
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

async function getConfiguredPersonaWebhook(channelId: string): Promise<CachedWebhookRecord | undefined> {
  const channelSpecificKey = `DISCORD_PERSONA_WEBHOOK_URL_${channelId}`;
  const rawUrl = trimOptionalString(process.env[channelSpecificKey]) ?? trimOptionalString(process.env.DISCORD_PERSONA_WEBHOOK_URL);

  if (!rawUrl) {
    return undefined;
  }

  const webhook = parseDiscordWebhookUrl(rawUrl, channelId);
  await assertConfiguredWebhookTargetsChannel(webhook, channelId);
  return webhook;
}

function parseDiscordWebhookUrl(rawUrl: string, expectedChannelId: string): CachedWebhookRecord {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Configured persona webhook for channel ${expectedChannelId} is not a valid URL.`);
  }

  const match = url.pathname.match(/\/api(?:\/v\d+)?\/webhooks\/([^/]+)\/([^/?#]+)/) ??
    url.pathname.match(/\/webhooks\/([^/]+)\/([^/?#]+)/);

  if (!match) {
    throw new Error(
      `Configured persona webhook for channel ${expectedChannelId} must look like https://discord.com/api/webhooks/<id>/<token>.`,
    );
  }

  return {
    id: match[1],
    token: match[2],
    channelId: expectedChannelId,
    name: "configured",
    createdAt: "configured",
    configured: true,
  };
}

async function assertConfiguredWebhookTargetsChannel(
  webhook: CachedWebhookRecord,
  expectedChannelId: string,
): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/webhooks/${webhook.id}/${webhook.token}`);

  if (!response.ok) {
    throw new Error(`Configured persona webhook lookup failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { channel_id?: string };
  if (payload.channel_id !== expectedChannelId) {
    throw new Error(
      `Configured persona webhook targets channel ${payload.channel_id}, not required channel ${expectedChannelId}.`,
    );
  }
}

async function executePersonaWebhook(
  webhook: CachedWebhookRecord,
  {
    threadId,
    content,
    replyToMessageId,
    username,
    avatarUrl,
  }: {
    threadId?: string;
    content: string;
    replyToMessageId?: string;
    username: string;
    avatarUrl?: string;
  },
): Promise<{ id: string; transport: "webhook" }> {
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

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord webhook execution returned no message id.");
  }

  return { id: payload.id, transport: "webhook" };
}

function normalizePersonaOptions(
  options?: DiscordPersonaOptions,
): NormalizedDiscordPersonaOptions | undefined {
  const personaName = trimOptionalString(options?.personaName);
  const personaAvatarUrl = trimOptionalString(options?.personaAvatarUrl);

  if (!personaName && !personaAvatarUrl) {
    return undefined;
  }

  if (!personaName) {
    throw new Error("personaName is required when posting through the shared persona webhook pipe.");
  }

  return {
    personaName: personaName.slice(0, 80),
    personaAvatarUrl,
  };
}

function trimOptionalString(value?: string): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getCachedPersonaWebhook(channelId: string): CachedWebhookRecord | undefined {
  const cache = readPersonaWebhookCache();
  return cache[channelId];
}

function writeCachedPersonaWebhook(channelId: string, webhook: CachedWebhookRecord): void {
  const cache = readPersonaWebhookCache();
  cache[channelId] = webhook;
  writePersonaWebhookCache(cache);
}

function clearCachedPersonaWebhook(channelId: string): void {
  const cache = readPersonaWebhookCache();
  if (cache[channelId]) {
    delete cache[channelId];
    writePersonaWebhookCache(cache);
  }
}

function readPersonaWebhookCache(): Record<string, CachedWebhookRecord> {
  try {
    const raw = stripLeadingBom(readFileSync(PERSONA_WEBHOOK_CACHE_PATH, "utf8"));
    const parsed = JSON.parse(raw) as Record<string, CachedWebhookRecord> | null;
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

function writePersonaWebhookCache(cache: Record<string, CachedWebhookRecord>): void {
  mkdirSync(dirname(PERSONA_WEBHOOK_CACHE_PATH), { recursive: true });
  writeFileSync(PERSONA_WEBHOOK_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function isStaleWebhookError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Failed to execute Discord webhook: 401") ||
    error.message.includes("Failed to execute Discord webhook: 404")
  );
}
