export interface DiscordActivityMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  isBot: boolean;
  channelId: string;
}

export interface IdleCoolingSnapshot {
  enabled: boolean;
  active: boolean;
  reason?: string;
  checkedChannelIds: string[];
  lastHumanActivityAt?: string;
  idleForMinutes?: number;
  idleAfterMinutes: number;
  recoveryMinutes: number;
  lastUnpromptedTurnQueuedAt?: string;
  nextUnpromptedTurnAllowedAt?: string;
  observedHumanMessages: DiscordActivityMessage[];
}

export interface SchedulerHistoryEntry {
  type?: string;
  queuedAt?: string;
  pendingMentionCount?: number;
}

interface DiscordApiMessage {
  id: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
}

export async function readDiscordActivitySnapshot(input: {
  botToken?: string;
  channelIds: Iterable<string | undefined>;
  policy: {
    enabled: boolean;
    idleAfterMinutes: number;
    recoveryMinutes: number;
  };
  history: SchedulerHistoryEntry[];
  now: Date;
  fetchImpl?: typeof fetch;
  messageLimit?: number;
}): Promise<IdleCoolingSnapshot> {
  const checkedChannelIds = uniqueChannelIds(input.channelIds);
  const lastUnpromptedTurnQueuedAt = newestUnpromptedTurnQueuedAt(input.history);
  const base: IdleCoolingSnapshot = {
    enabled: input.policy.enabled,
    active: false,
    checkedChannelIds,
    idleAfterMinutes: input.policy.idleAfterMinutes,
    recoveryMinutes: input.policy.recoveryMinutes,
    lastUnpromptedTurnQueuedAt,
    observedHumanMessages: [],
  };

  if (!input.botToken) return { ...base, reason: "missing_discord_bot_token" };
  if (checkedChannelIds.length === 0) return { ...base, reason: "no_watched_discord_channels" };

  const fetchImpl = input.fetchImpl ?? fetch;
  const fetchErrors: string[] = [];
  let newestHumanActivityAt: string | undefined;
  const observedIds = new Set<string>();

  for (const channelId of checkedChannelIds) {
    try {
      const messages = await fetchChannelActivity({
        botToken: input.botToken,
        channelId,
        limit: input.messageLimit ?? 10,
        fetchImpl,
      });
      for (const message of messages) {
        if (!message.content.trim()) continue;
        if (!observedIds.has(message.id)) {
          observedIds.add(message.id);
          base.observedHumanMessages.push(message);
        }
        if (isNewerTimestamp(message.timestamp, newestHumanActivityAt)) {
          newestHumanActivityAt = message.timestamp;
        }
      }
    } catch (error) {
      fetchErrors.push(`${channelId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  base.observedHumanMessages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const nextUnpromptedTurnAllowedAt = addMinutes(lastUnpromptedTurnQueuedAt, input.policy.recoveryMinutes);

  if (!input.policy.enabled) {
    return {
      ...base,
      reason: fetchErrors.length > 0 ? "disabled_with_activity_fetch_failure" : "disabled",
      lastHumanActivityAt: newestHumanActivityAt,
      nextUnpromptedTurnAllowedAt,
    };
  }
  if (!newestHumanActivityAt) {
    return {
      ...base,
      active: true,
      reason: fetchErrors.length > 0 ? "activity_fetch_failed_or_no_human_messages" : "no_recent_human_messages",
      nextUnpromptedTurnAllowedAt,
    };
  }

  const idleForMinutes = Math.max(0, (input.now.getTime() - Date.parse(newestHumanActivityAt)) / 60_000);
  return {
    ...base,
    active: idleForMinutes >= input.policy.idleAfterMinutes,
    reason: fetchErrors.length > 0 ? "partial_activity_fetch_failure" : undefined,
    lastHumanActivityAt: newestHumanActivityAt,
    idleForMinutes: round3(idleForMinutes),
    nextUnpromptedTurnAllowedAt,
  };
}

export function uniqueChannelIds(channelIds: Iterable<string | undefined>): string[] {
  return Array.from(new Set(Array.from(channelIds)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)));
}

export function newestUnpromptedTurnQueuedAt(history: SchedulerHistoryEntry[]): string | undefined {
  for (const entry of [...history].reverse()) {
    if (entry.type !== "queued" && entry.type !== "dry_run_selected") continue;
    if (typeof entry.queuedAt !== "string") continue;
    if (typeof entry.pendingMentionCount === "number" && entry.pendingMentionCount > 0) continue;
    return entry.queuedAt;
  }
  return undefined;
}

async function fetchChannelActivity(input: {
  botToken: string;
  channelId: string;
  limit: number;
  fetchImpl: typeof fetch;
}): Promise<DiscordActivityMessage[]> {
  const url = new URL(`https://discord.com/api/v10/channels/${input.channelId}/messages`);
  url.searchParams.set("limit", String(Math.max(1, Math.min(input.limit, 25))));
  const response = await input.fetchImpl(url, { headers: { Authorization: `Bot ${input.botToken}` } });
  if (!response.ok) {
    throw new Error(`Discord activity fetch failed with ${response.status}: ${await response.text()}`);
  }
  const messages = await response.json() as DiscordApiMessage[];
  return messages
    .filter((message) => message.author.bot !== true)
    .map((message) => ({
      id: message.id,
      authorId: message.author.id,
      authorName: message.author.global_name ?? message.member?.nick ?? message.author.username,
      content: message.content,
      timestamp: message.timestamp,
      isBot: false,
      channelId: input.channelId,
    }))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function isNewerTimestamp(candidate: string, current?: string): boolean {
  const candidateMs = Date.parse(candidate);
  const currentMs = Date.parse(current ?? "");
  return Number.isFinite(candidateMs) && (!Number.isFinite(currentMs) || candidateMs > currentMs);
}

function addMinutes(timestamp: string | undefined, minutes: number): string | undefined {
  const timestampMs = Date.parse(timestamp ?? "");
  return Number.isFinite(timestampMs) ? new Date(timestampMs + minutes * 60_000).toISOString() : undefined;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
