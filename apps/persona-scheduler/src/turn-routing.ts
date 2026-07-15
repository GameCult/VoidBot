import type { RepoDiscordIdentity, RepoFacePendingMention } from "@voidbot/core";

export interface PersonaChannelPlan {
  primaryChannelId?: string;
  snapshotChannelIds: string[];
  options: PersonaChannelOption[];
  lowThresholdTopics: string[];
}

export interface PersonaChannelOption {
  channelId: string;
  label: string;
  topic: string;
  speechThreshold: "very_low" | "low" | "medium" | "high";
  speedMultiplier: number;
  posture?: string;
}

export function buildPersonaChannelPlan(
  identity: RepoDiscordIdentity,
  defaultChannelId?: string,
  preferredChannelId?: string,
): PersonaChannelPlan {
  const explicit = identity.channelPermissions.map((permission): PersonaChannelOption => ({
    channelId: permission.channelId,
    label: permission.label ?? permission.channelId,
    topic: permission.topic ?? "general",
    speechThreshold: permission.speechThreshold,
    speedMultiplier: permission.speedMultiplier,
    posture: permission.posture,
  }));
  const explicitChannelIds = new Set(explicit.map((permission) => permission.channelId));
  const legacy = identity.allowedChannelIds
    .filter((channelId) => !explicitChannelIds.has(channelId))
    .map((channelId): PersonaChannelOption => ({
      channelId,
      label: channelId === defaultChannelId ? "default" : channelId,
      topic: channelId === defaultChannelId ? "casual Aquarium musing" : "registered channel",
      speechThreshold: channelId === defaultChannelId ? "very_low" : "medium",
      speedMultiplier: channelId === defaultChannelId ? 1.5 : 1,
      posture: channelId === defaultChannelId
        ? "Low-stakes casual chatter, half-formed fascinations, jokes, little observations, and friendly asides are welcome here."
        : undefined,
    }));
  const fallback: PersonaChannelOption[] = explicit.length === 0 && legacy.length === 0 && defaultChannelId
    ? [{
        channelId: defaultChannelId,
        label: "aquarium",
        topic: "casual Aquarium musing",
        speechThreshold: "very_low",
        speedMultiplier: 1.5,
        posture: "Low-stakes casual chatter, half-formed fascinations, jokes, little observations, and friendly asides are welcome here.",
      }]
    : [];
  const options = [...explicit, ...legacy, ...fallback];
  const preferred = preferredChannelId ? options.find((option) => option.channelId === preferredChannelId) : undefined;
  const defaultOption = defaultChannelId ? options.find((option) => option.channelId === defaultChannelId) : undefined;
  const primary = preferred ?? defaultOption ?? options
    .slice()
    .sort((left, right) => thresholdRank(left.speechThreshold) - thresholdRank(right.speechThreshold))[0];

  return {
    primaryChannelId: primary?.channelId,
    snapshotChannelIds: [...new Set([
      ...options.map((option) => option.channelId),
      ...(preferredChannelId ? [preferredChannelId] : []),
    ])],
    options,
    lowThresholdTopics: options
      .filter((option) => thresholdRank(option.speechThreshold) <= thresholdRank("low"))
      .map((option) => option.topic),
  };
}

export function newestPendingMentionChannel(pendingMentions: RepoFacePendingMention[]): string | undefined {
  return pendingMentions
    .slice()
    .sort((left, right) => Date.parse(right.queuedAt) - Date.parse(left.queuedAt))[0]?.channelId;
}

export function personaChannelSpeedMultiplier(identity: RepoDiscordIdentity): number {
  const multipliers = identity.channelPermissions.map((permission) => permission.speedMultiplier);
  return multipliers.length > 0 ? clamp(Math.max(...multipliers), 0.5, 3) : 1;
}

function thresholdRank(threshold: PersonaChannelOption["speechThreshold"]): number {
  switch (threshold) {
    case "very_low": return 0;
    case "low": return 1;
    case "medium": return 2;
    case "high": return 3;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}
