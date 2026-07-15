import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { SourceMessage, SourceMessageAttachment } from "@voidbot/shared";

const MAX_FACE_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export interface ChannelSnapshot {
  channelId: string;
  messages: SourceMessage[];
}

interface DiscordApiMessage {
  id: string;
  content: string;
  timestamp: string;
  attachments?: DiscordApiAttachment[];
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: { nick?: string | null };
}

interface DiscordApiAttachment {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
  proxy_url?: string;
  width?: number | null;
  height?: number | null;
}

export async function fetchRecentDiscordMessages(input: {
  botToken?: string;
  channelId: string;
  limit: number;
  ignoreBotMessages?: boolean;
  fetchImpl?: typeof fetch;
  mediaCacheRoot?: string;
}): Promise<SourceMessage[]> {
  if (!input.botToken) return [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(`https://discord.com/api/v10/channels/${input.channelId}/messages`);
  url.searchParams.set("limit", String(Math.max(1, Math.min(input.limit, 25))));
  const response = await fetchImpl(url, { headers: { Authorization: `Bot ${input.botToken}` } });
  if (!response.ok) {
    throw new Error(`Discord recent message fetch failed with ${response.status}: ${await response.text()}`);
  }

  const messages = await response.json() as DiscordApiMessage[];
  const sourceMessages = await Promise.all(messages
    .filter((message) => !(input.ignoreBotMessages && message.author.bot === true))
    .map(async (message) => {
      const attachments = await materializeDiscordAttachments({
        channelId: input.channelId,
        message,
        fetchImpl,
        mediaCacheRoot: input.mediaCacheRoot,
      });
      return {
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.global_name ?? message.member?.nick ?? message.author.username,
        content: message.content,
        timestamp: message.timestamp,
        isBot: message.author.bot === true,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    }));
  return sourceMessages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export async function fetchChannelSnapshots(input: {
  botToken?: string;
  channelIds: string[];
  primaryChannelId: string;
  limit: number;
  bifrostDiscordChannelId?: string;
  fetchImpl?: typeof fetch;
  mediaCacheRoot?: string;
  now?: Date;
}): Promise<ChannelSnapshot[]> {
  const snapshots: ChannelSnapshot[] = [];
  for (const channelId of input.channelIds.filter((entry) => entry !== input.primaryChannelId).slice(0, 5)) {
    try {
      snapshots.push({
        channelId,
        messages: await fetchRecentDiscordMessages({
          botToken: input.botToken,
          channelId,
          limit: input.limit,
          ignoreBotMessages: channelId === input.bifrostDiscordChannelId,
          fetchImpl: input.fetchImpl,
          mediaCacheRoot: input.mediaCacheRoot,
        }),
      });
    } catch (error) {
      snapshots.push({
        channelId,
        messages: [{
          id: `snapshot-error:${channelId}`,
          authorId: "voidbot",
          authorName: "VoidBot",
          content: `Could not read recent channel context: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: (input.now ?? new Date()).toISOString(),
          isBot: true,
        }],
      });
    }
  }
  return snapshots;
}

async function materializeDiscordAttachments(input: {
  channelId: string;
  message: DiscordApiMessage;
  fetchImpl: typeof fetch;
  mediaCacheRoot?: string;
}): Promise<SourceMessageAttachment[]> {
  const materialized: SourceMessageAttachment[] = [];
  for (const attachment of (input.message.attachments ?? []).slice(0, 4)) {
    const kind = isDiscordImageAttachment(attachment) ? "image" : "other";
    const localPath = kind === "image" && isWithinFaceImageSizeLimit(attachment)
      ? await cacheDiscordImageAttachment({ ...input, messageId: input.message.id, attachment })
      : undefined;
    materialized.push({
      kind,
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      url: attachment.url,
      proxyUrl: attachment.proxy_url,
      size: typeof attachment.size === "number" ? attachment.size : undefined,
      width: typeof attachment.width === "number" ? attachment.width : undefined,
      height: typeof attachment.height === "number" ? attachment.height : undefined,
      localPath,
    });
  }
  return materialized;
}

async function cacheDiscordImageAttachment(input: {
  channelId: string;
  messageId: string;
  attachment: DiscordApiAttachment;
  fetchImpl: typeof fetch;
  mediaCacheRoot?: string;
}): Promise<string | undefined> {
  const sourceUrl = input.attachment.url ?? input.attachment.proxy_url;
  if (!sourceUrl) return undefined;
  const fileStem = [
    input.messageId,
    input.attachment.id ?? createHash("sha256").update(sourceUrl).digest("hex").slice(0, 12),
  ].join("-");
  const directory = resolve(input.mediaCacheRoot ?? resolve(".voidbot", "media", "discord-images"), input.channelId);
  const localPath = resolve(directory, `${fileStem}${normalizedImageExtension(input.attachment)}`);
  try {
    await stat(localPath);
    return localPath;
  } catch {
    // Cache miss.
  }
  try {
    const response = await input.fetchImpl(sourceUrl);
    if (!response.ok) return undefined;
    await mkdir(directory, { recursive: true });
    await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    return localPath;
  } catch {
    return undefined;
  }
}

function isWithinFaceImageSizeLimit(attachment: DiscordApiAttachment): boolean {
  return typeof attachment.size !== "number" || attachment.size <= MAX_FACE_IMAGE_ATTACHMENT_BYTES;
}

function isDiscordImageAttachment(attachment: DiscordApiAttachment): boolean {
  const contentType = attachment.content_type?.toLowerCase() ?? "";
  return contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(attachment.filename ?? attachment.url ?? "");
}

function normalizedImageExtension(attachment: DiscordApiAttachment): string {
  const fromName = extname(attachment.filename ?? "").toLowerCase();
  if (/^\.(png|jpe?g|gif|webp)$/.test(fromName)) return fromName;
  switch (attachment.content_type?.toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    default: return ".png";
  }
}
