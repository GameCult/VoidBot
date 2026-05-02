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
  type InteractionMemoryProfile,
  type SourceGroundingHint,
  type SourceMessage,
  type SituationalSocialRead,
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
    isBot: message.author.bot,
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
      if (alias.length < 6) {
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
    required: false,
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
    timeContext: formatTimeContext(result.metadata.timestamp),
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
    timeContext: formatTimeContext(message.timestamp),
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

export async function sendDirectMessage(
  target: { send: (content: string) => Promise<unknown> },
  content: string,
): Promise<void> {
  for (const chunk of splitDiscordContent(content)) {
    await target.send(chunk);
  }
}

export function renderInteractionProfileDisclosure(
  actorName: string,
  profile: InteractionMemoryProfile | undefined,
  situationalSocialRead?: SituationalSocialRead,
): string {
  if (!profile) {
    return [
      `Void's current read on ${actorName}:`,
      "",
      "There is not enough durable interaction memory yet to form a meaningful long-horizon profile.",
      situationalSocialRead
        ? [
            "",
            "Ephemeral room read for this moment:",
            `- Summary: ${situationalSocialRead.summary}`,
            `- Room tone: ${situationalSocialRead.roomTone}`,
            `- Speaker read: ${situationalSocialRead.speakerCurrentRead}`,
            `- Social frame: ${situationalSocialRead.socialFrame}`,
            `- Response guidance: ${situationalSocialRead.responseGuidance}`,
          ].join("\n")
        : "",
    ]
      .filter((section) => section.length > 0)
      .join("\n");
  }

  const dimensions =
    profile.interactionDimensions.length > 0
      ? profile.interactionDimensions
          .map(
            (dimension) =>
              `- ${dimension.label} (${dimension.score}/3): ${dimension.summary}`,
          )
          .join("\n")
      : "- No strong interaction dimensions yet.";
  const traits =
    profile.inferredTraits.length > 0
      ? profile.inferredTraits.join(", ")
      : "No stable inferred traits yet.";
  const recentEvents =
    profile.recentEvents.length > 0
      ? profile.recentEvents
          .slice()
          .reverse()
          .slice(0, 8)
          .map(
            (event) =>
              `- [${event.timestamp}] ${event.sourceKind === "ambient_mention" ? "ambient" : "direct"} ${event.sentiment} score=${event.score}: ${event.summary} Quote: "${event.excerpt}"`,
          )
          .join("\n")
      : "- No retained recent incidents.";
  const pronounEvidence =
    profile.pronounEvidence.length > 0
      ? profile.pronounEvidence
          .map(
            (entry) =>
              `- [${entry.timestamp}] ${entry.stance} ${entry.pronounSet} via ${entry.source} (${Math.round(entry.confidence * 100)}%): "${entry.excerpt}"`,
          )
          .join("\n")
      : "- No stored pronoun evidence yet.";
  const situationalSection = situationalSocialRead
    ? [
        "",
        "Ephemeral room read for this moment:",
        `- Summary: ${situationalSocialRead.summary}`,
        `- Room tone: ${situationalSocialRead.roomTone}`,
        `- Speaker read: ${situationalSocialRead.speakerCurrentRead}`,
        `- Social frame: ${situationalSocialRead.socialFrame}`,
        `- Response guidance: ${situationalSocialRead.responseGuidance}`,
      ].join("\n")
    : "";

  return [
    `Void's current profile on ${actorName}:`,
    "",
    `Summary: ${profile.summary}`,
    `Disposition: ${profile.disposition}`,
    `Affinity score: ${profile.affinityScore}`,
    `Interaction counts: total=${profile.totalInteractions}, direct=${profile.directInteractionCount}, ambient=${profile.ambientMentionCount}, positive=${profile.positiveCount}, neutral=${profile.neutralCount}, negative=${profile.negativeCount}`,
    `Last interaction: ${profile.lastInteractionAt ?? "unknown"}`,
    "",
    `Psychological read: ${profile.psychologicalProfile}`,
    `Inferred traits: ${traits}`,
    "",
    "Interaction dimensions:",
    dimensions,
    "",
    "Pronoun handling:",
    `- Policy: ${profile.pronounPolicy}`,
    `- Resolved sets: ${profile.resolvedPronounSets.length > 0 ? profile.resolvedPronounSets.join(", ") : profile.resolvedPronounSet ?? "none"}`,
    `- Confidence: ${profile.pronounConfidence !== undefined ? `${Math.round(profile.pronounConfidence * 100)}%` : "n/a"}`,
    `- Guidance: ${profile.pronounGuidance}`,
    "- Evidence:",
    pronounEvidence,
    "",
    `Private response guidance: ${profile.responseGuidance}`,
    "",
    "Recent remembered incidents:",
    recentEvents,
    situationalSection,
  ]
    .filter((section) => section.length > 0)
    .join("\n");
}

export function truncate(input: string, limit: number): string {
  if (input.length <= limit) {
    return input;
  }

  return `${input.slice(0, limit - 3)}...`;
}

export function splitDiscordContent(input: string, limit = 1900): string[] {
  const normalized = input.replace(/\r\n/g, "\n").trim();

  if (normalized.length === 0) {
    return ["(empty response)"];
  }

  if (normalized.length <= limit) {
    return [normalized];
  }

  const chunks: string[] = [];
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

export async function replyToMessage(message: Message, content: string): Promise<void> {
  const chunks = splitDiscordContent(content);

  await message.reply(chunks[0]);

  if (!canSendMessages(message.channel)) {
    return;
  }

  for (const chunk of chunks.slice(1)) {
    await message.channel.send(chunk);
  }
}

export async function sendChunkedChannelMessage(
  channel: TextBasedChannel & { send: (content: string) => Promise<unknown> },
  content: string,
): Promise<void> {
  for (const chunk of splitDiscordContent(content)) {
    await channel.send(chunk);
  }
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

function findSplitIndex(input: string, limit: number): number {
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

function formatTimeContext(timestamp: string | undefined): string | undefined {
  if (!timestamp) {
    return undefined;
  }

  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  const absolute = formatUtcTimestamp(timestamp);
  const now = new Date();
  const deltaMs = now.getTime() - parsed.getTime();
  const absDeltaMs = Math.abs(deltaMs);
  const suffix = deltaMs >= 0 ? "ago" : "from now";

  if (absDeltaMs < 60_000) {
    return `${absolute} (just now)`;
  }

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const yearMs = 365 * dayMs;

  if (absDeltaMs < hourMs) {
    const minutes = Math.round(absDeltaMs / minuteMs);
    return `${absolute} (${minutes} minute${minutes === 1 ? "" : "s"} ${suffix})`;
  }

  if (absDeltaMs < dayMs) {
    const hours = Math.round(absDeltaMs / hourMs);
    return `${absolute} (${hours} hour${hours === 1 ? "" : "s"} ${suffix})`;
  }

  if (absDeltaMs < yearMs) {
    const days = Math.round(absDeltaMs / dayMs);
    return `${absolute} (${days} day${days === 1 ? "" : "s"} ${suffix})`;
  }

  const years = Math.round(absDeltaMs / yearMs);
  return `${absolute} (${years} year${years === 1 ? "" : "s"} ${suffix})`;
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
