import {
  ChannelType,
  Client,
  PermissionsBitField,
  type CacheType,
  type ChatInputCommandInteraction,
  type Message,
  type PartialMessage,
  type TextBasedChannel,
} from "discord.js";

import {
  type InteractionMemoryBank,
  type SystemMessageCatalog,
  type VoidUsageRateLimiter,
} from "@voidbot/core";
import type { ProviderRegistry } from "@voidbot/providers";
import {
  RagPipeline,
  RetrievalService,
  type ArchivedMessageRecord,
} from "@voidbot/rag";
import {
  type Actor,
  type ArchivedMessage,
  type ChannelIndexingPolicy,
  type ChannelIndexingTarget,
  type GuildContext,
  type SourceGroundingHint,
  type SourceMessage,
  shouldIndexChannel,
} from "@voidbot/shared";

export function buildActorFromMessage(message: Message): Actor {
  return {
    id: message.author.id,
    displayName: message.author.displayName ?? message.author.username,
    isAdmin: message.member?.permissions.has(PermissionsBitField.Flags.Administrator) ?? false,
    isBot: message.author.bot,
  };
}

export function buildActorFromInteraction(
  interaction: ChatInputCommandInteraction<CacheType>,
): Actor {
  return {
    id: interaction.user.id,
    displayName: interaction.user.displayName ?? interaction.user.username,
    isAdmin:
      interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false,
    isBot: interaction.user.bot,
  };
}

export function getRoleIdsFromMessage(message: Message): string[] {
  return message.member ? [...message.member.roles.cache.keys()] : [];
}

export function getRoleIdsFromInteraction(
  interaction: ChatInputCommandInteraction<CacheType>,
): string[] {
  const member = interaction.member;

  if (!member || !("roles" in member)) {
    return [];
  }

  const { roles } = member;

  if (Array.isArray(roles)) {
    return roles.filter((roleId): roleId is string => typeof roleId === "string");
  }

  if (roles && typeof roles === "object" && "cache" in roles) {
    return [...roles.cache.keys()];
  }

  return [];
}

export function buildGuildContextFromMessage(message: Message): GuildContext {
  return {
    guildId: message.guildId ?? undefined,
    guildName: message.guild?.name,
    channelId: message.channelId,
    channelName: "name" in message.channel ? message.channel.name ?? undefined : undefined,
    threadId: message.channel.type === ChannelType.PublicThread ? message.channel.id : undefined,
  };
}

export function buildGuildContextFromInteraction(
  interaction: ChatInputCommandInteraction<CacheType>,
): GuildContext {
  return {
    guildId: interaction.guildId ?? undefined,
    guildName: interaction.guild?.name,
    channelId: interaction.channelId,
    channelName:
      interaction.channel && "name" in interaction.channel ? interaction.channel.name ?? undefined : undefined,
    threadId:
      interaction.channel?.type === ChannelType.PublicThread ? interaction.channel.id : undefined,
  };
}

export async function ingestIfIndexed(
  message: Message,
  channelIndexing: ChannelIndexingPolicy,
  ragPipeline: RagPipeline,
): Promise<void> {
  if (!shouldIndexChannel(channelIndexing, buildChannelIndexingTarget(message.channel))) {
    return;
  }

  await ragPipeline.upsertMessages([convertDiscordMessageToArchive(message)]);
}

export async function rememberAmbientVoidReference(
  message: Message,
  botUserId: string | undefined,
  interactionMemory: InteractionMemoryBank,
): Promise<void> {
  if (!isAmbientVoidReference(message, botUserId)) {
    return;
  }

  await interactionMemory.recordInteraction({
    actorId: message.author.id,
    actorName: message.author.displayName ?? message.author.username,
    sourceKind: "ambient_mention",
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    channelName: "name" in message.channel ? message.channel.name ?? undefined : undefined,
    prompt: message.content,
    eventId: message.id,
    timestamp: (message.editedAt ?? message.createdAt).toISOString(),
  });
}

export function buildChannelIndexingTarget(
  channel: TextBasedChannel | null | undefined,
): ChannelIndexingTarget {
  if (!channel) {
    return {};
  }

  const target: ChannelIndexingTarget = {
    channelId: channel.id,
    channelName: "name" in channel ? channel.name ?? undefined : undefined,
  };

  if (channel.isThread()) {
    target.parentChannelId = channel.parentId ?? undefined;
    target.parentChannelName =
      channel.parent && "name" in channel.parent ? channel.parent.name ?? undefined : undefined;
  }

  return target;
}

export function convertDiscordMessageToArchive(message: Message): ArchivedMessage {
  const metadata: Record<string, string> = {
    jumpUrl: message.url,
  };

  if ("name" in message.channel && message.channel.name) {
    metadata.channelName = message.channel.name;
  }

  if (message.channel.isThread()) {
    if (message.channel.parentId) {
      metadata.parentChannelId = message.channel.parentId;
    }

    if (message.channel.parent && "name" in message.channel.parent && message.channel.parent.name) {
      metadata.parentChannelName = message.channel.parent.name;
    }
  }

  return {
    id: message.id,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.author.displayName ?? message.author.username,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString(),
    threadId: message.channel.isThread() ? message.channel.id : undefined,
    attachments:
      message.attachments.size > 0
        ? [...message.attachments.values()].map(
            (attachment) => attachment.url ?? attachment.proxyURL ?? attachment.name,
          )
        : undefined,
    metadata,
  };
}

export function convertDiscordMessageToSource(message: Message): SourceMessage {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.author.displayName ?? message.author.username,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
  };
}

export async function getRecentMessages(
  channel: TextBasedChannel | null,
  limit: number,
): Promise<SourceMessage[]> {
  if (!channel || !("messages" in channel)) {
    return [];
  }

  const fetched = await channel.messages.fetch({ limit });

  return [...fetched.values()]
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(convertDiscordMessageToSource);
}

export async function materializeMessage(
  message: Message | PartialMessage,
): Promise<Message | undefined> {
  if (!message.partial) {
    return message;
  }

  try {
    return await message.fetch();
  } catch {
    return undefined;
  }
}

export function stripBotMention(content: string): string {
  return content.replace(/<@!?(\d+)>/g, "").trim();
}

export function inferSourceGroundingHint(
  prompt: string,
  repoSummaries: Array<{ repoName: string }>,
): SourceGroundingHint {
  const normalized = ` ${normalizeForMatching(prompt)} `;
  const reasons = new Set<string>();
  const matchedRepoNames = new Set<string>();

  for (const repo of repoSummaries) {
    for (const alias of buildRepoAliases(repo.repoName)) {
      if (alias.length < 4) {
        continue;
      }

      if (normalized.includes(` ${alias} `)) {
        matchedRepoNames.add(repo.repoName);
      }
    }
  }

  if (matchedRepoNames.size > 0) {
    reasons.add("matched indexed repo/project name");
  }

  const genericSourceCues = [
    " repo ",
    " repository ",
    " repositories ",
    " codebase ",
    " source ",
    " sources ",
    " lore ",
    " vault ",
    " canon ",
    " file ",
    " files ",
    " docs ",
    " documentation ",
    " module ",
    " implementation ",
    " project ",
    " projects ",
  ];

  if (genericSourceCues.some((cue) => normalized.includes(cue))) {
    reasons.add("contains source/lore cue");
  }

  return {
    required: reasons.size > 0,
    reasons: [...reasons],
    matchedRepoNames: [...matchedRepoNames].sort(),
  };
}

export function formatProviderStatuses(
  statuses: ReturnType<ProviderRegistry["listStatuses"]>,
  systemMessages: SystemMessageCatalog,
): string {
  return [
    renderSystemMessage(systemMessages, "provider_status.intro"),
    statuses
      .map((status) => {
        const state = status.enabled ? "enabled" : "disabled";
        const access = status.allowed ? "allowed" : "blocked";
        return `${status.name}: ${state}, ${access}, capabilities=${status.capabilities.join(", ")}`;
      })
      .join("\n"),
  ].join("\n");
}

export function renderSystemMessage(
  systemMessages: SystemMessageCatalog,
  key: string,
  variables: Record<string, string | number | boolean | null | undefined> = {},
): string {
  return systemMessages.render(key, variables);
}

export function renderRateLimitMessage(
  systemMessages: SystemMessageCatalog,
  decision: Awaited<ReturnType<VoidUsageRateLimiter["consume"]>>,
): string {
  if (decision.reason === "daily_limit") {
    return renderSystemMessage(systemMessages, "rate_limit.daily_limit", {
      dailyLimit: decision.policy.dailyLimit ?? decision.dailyCount,
      resetsAt: decision.resetsAt ? formatUtcTimestamp(decision.resetsAt) : "the next UTC midnight",
    });
  }

  return renderSystemMessage(systemMessages, "rate_limit.cooldown", {
    retryAfter: formatDurationSeconds(decision.retryAfterSeconds ?? 1),
  });
}

export function formatHistoryResults(
  results: Awaited<ReturnType<RetrievalService["searchHistory"]>>,
): Array<Record<string, unknown>> {
  return results.map((result) => ({
    score: Number(result.score.toFixed(4)),
    text: result.text,
    sourceId: result.sourceId,
    channelId: result.metadata.channelId,
    channelName: result.metadata.channelName,
    authorId: result.metadata.authorId,
    authorName: result.metadata.authorName,
    timestamp: result.metadata.timestamp,
    jumpUrl: result.metadata.jumpUrl,
    threadId: result.metadata.threadId,
  }));
}

export function formatSourceResults(
  results: Awaited<ReturnType<RetrievalService["searchRepositorySources"]>>,
): Array<Record<string, unknown>> {
  return results.map((result) => ({
    score: Number(result.score.toFixed(4)),
    text: result.text,
    sourceId: result.sourceId,
    repoName: result.metadata.repoName,
    path: result.metadata.path,
    language: result.metadata.language,
    title: result.metadata.title,
    chunkIndex: Number(result.metadata.chunkIndex ?? 0),
    lineStart: Number(result.metadata.lineStart ?? 1),
    lineEnd: Number(result.metadata.lineEnd ?? 1),
    lastModifiedAt: result.metadata.lastModifiedAt,
  }));
}

export function formatArchivedMessageContext(
  message: ArchivedMessageRecord,
  anchorMessageId: string,
): Record<string, unknown> {
  return {
    id: message.id,
    isAnchor: message.id === anchorMessageId,
    timestamp: message.timestamp,
    authorId: message.authorId,
    authorName: message.authorName,
    channelId: message.channelId,
    channelName: message.metadata?.channelName,
    threadId: message.threadId,
    content: message.content,
    jumpUrl: message.metadata?.jumpUrl,
    editedAt: message.editedAt,
  };
}

export async function notifyOwnerOfBotIssue(
  client: Client,
  ownerDiscordId: string,
  content: string,
): Promise<void> {
  try {
    const owner = await client.users.fetch(ownerDiscordId);
    await owner.send(truncate(content, 1900));
  } catch (error) {
    console.error(
      `Failed to DM owner about bot-side issue: ${
        error instanceof Error ? error.message : "Unexpected notification failure."
      }`,
    );
  }
}

export function truncate(input: string, limit: number): string {
  if (input.length <= limit) {
    return input;
  }

  return `${input.slice(0, limit - 3)}...`;
}

export function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(totalSeconds));

  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;

  if (minutes < 60) {
    return remainderSeconds === 0
      ? `${minutes} minute${minutes === 1 ? "" : "s"}`
      : `${minutes}m ${remainderSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;

  return remainderMinutes === 0
    ? `${hours} hour${hours === 1 ? "" : "s"}`
    : `${hours}h ${remainderMinutes}m`;
}

export function formatUtcTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

export function canSendMessages(
  channel: Awaited<ReturnType<Client["channels"]["fetch"]>>,
): channel is TextBasedChannel & { send: (content: string) => Promise<unknown> } {
  return (
    channel !== null &&
    channel.isTextBased() &&
    "send" in channel &&
    typeof channel.send === "function"
  );
}

function buildRepoAliases(repoName: string): string[] {
  const normalizedRepo = repoName.replace(/[_-]+/g, " ").trim();
  const lower = normalizeForMatching(normalizedRepo);
  const compact = normalizeForMatching(repoName);
  const words = splitPascalCase(normalizedRepo)
    .flatMap((part) => part.split(/\s+/))
    .map((part) => normalizeForMatching(part))
    .filter((part) => part.length > 0);
  const aliases = new Set<string>([lower, compact, words.join(" ")]);

  for (const word of words) {
    if (word.length >= 4) {
      aliases.add(word);
    }
  }

  return [...aliases].filter((alias) => alias.length > 0);
}

function splitPascalCase(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAmbientVoidReference(
  message: Message,
  botUserId: string | undefined,
): boolean {
  const content = message.content.trim();

  if (content.length === 0) {
    return false;
  }

  if (botUserId && message.mentions.users.has(botUserId)) {
    return false;
  }

  if (/\bvoidbot\b/i.test(content)) {
    return true;
  }

  if (!/\bvoid\b/i.test(content)) {
    return false;
  }

  const normalized = ` ${content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

  if (
    normalized.includes(" the void ") ||
    normalized.includes(" into the void ") ||
    normalized.includes(" return void ") ||
    normalized.includes(" void function ") ||
    normalized.includes(" void pointer ") ||
    normalized.includes(" non void ")
  ) {
    return false;
  }

  return true;
}
