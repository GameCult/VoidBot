export interface ChannelIndexingPolicy {
  indexAllChannels: boolean;
  indexedChannelIds: string[];
  excludedChannelIds: string[];
  excludedChannelNames: string[];
}

export interface ChannelIndexingTarget {
  channelId?: string;
  channelName?: string;
  parentChannelId?: string;
  parentChannelName?: string;
}

export function normalizeDiscordChannelName(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

export function isChannelExcluded(
  policy: ChannelIndexingPolicy,
  target: ChannelIndexingTarget,
): boolean {
  const channelIds = collectChannelIds(target);

  if (channelIds.some((channelId) => policy.excludedChannelIds.includes(channelId))) {
    return true;
  }

  const channelNames = collectChannelNames(target);
  return channelNames.some((channelName) => policy.excludedChannelNames.includes(channelName));
}

export function shouldIndexChannel(
  policy: ChannelIndexingPolicy,
  target: ChannelIndexingTarget,
): boolean {
  if (isChannelExcluded(policy, target)) {
    return false;
  }

  if (policy.indexAllChannels) {
    return true;
  }

  const channelIds = collectChannelIds(target);
  return channelIds.some((channelId) => policy.indexedChannelIds.includes(channelId));
}

function collectChannelIds(target: ChannelIndexingTarget): string[] {
  return [target.channelId, target.parentChannelId].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function collectChannelNames(target: ChannelIndexingTarget): string[] {
  return [target.channelName, target.parentChannelName]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeDiscordChannelName)
    .filter((value) => value.length > 0);
}
