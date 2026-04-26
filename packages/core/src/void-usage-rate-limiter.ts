import { type CommandName, type ProviderName } from "@voidbot/shared";

export interface VoidUsageRateLimitConfig {
  defaultCooldownSeconds: number;
  defaultDailyLimit: number;
  unlimitedUserIds: string[];
  unlimitedRoleIds: string[];
  boostedUserIds: string[];
  boostedRoleIds: string[];
  boostedMultiplier: number;
}

export interface VoidUsageSubject {
  actorId: string;
  roleIds: string[];
}

export interface EffectiveVoidUsagePolicy {
  cooldownSeconds?: number;
  dailyLimit?: number;
  modifier: "default" | "boosted" | "unlimited";
  matchedSubjects: string[];
}

export interface VoidUsageRateLimitDecision {
  allowed: boolean;
  reason?: "cooldown" | "daily_limit";
  policy: EffectiveVoidUsagePolicy;
  dailyCount: number;
  retryAfterSeconds?: number;
  resetsAt?: string;
}

export interface ConsumeVoidUsageRateLimitInput {
  actorId: string;
  command: CommandName;
  provider: ProviderName;
  guildId?: string;
  channelId: string;
  cooldownSeconds?: number;
  dailyLimit?: number;
  timestamp?: string;
}

export interface VoidUsageRateLimitStore {
  consume(input: ConsumeVoidUsageRateLimitInput): Promise<VoidUsageRateLimitDecision>;
}

export class VoidUsageRateLimiter {
  public constructor(
    private readonly store: VoidUsageRateLimitStore,
    private readonly config: VoidUsageRateLimitConfig,
  ) {}

  public async consume(input: {
    actorId: string;
    roleIds: string[];
    command: CommandName;
    provider: ProviderName;
    guildId?: string;
    channelId: string;
    timestamp?: string;
  }): Promise<VoidUsageRateLimitDecision> {
    const policy = resolveEffectivePolicy(this.config, {
      actorId: input.actorId,
      roleIds: input.roleIds,
    });

    if (policy.cooldownSeconds === undefined && policy.dailyLimit === undefined) {
      return {
        allowed: true,
        policy,
        dailyCount: 0,
      };
    }

    const decision = await this.store.consume({
      actorId: input.actorId,
      command: input.command,
      provider: input.provider,
      guildId: input.guildId,
      channelId: input.channelId,
      cooldownSeconds: policy.cooldownSeconds,
      dailyLimit: policy.dailyLimit,
      timestamp: input.timestamp,
    });

    return {
      ...decision,
      policy,
    };
  }
}

export function resolveEffectivePolicy(
  config: VoidUsageRateLimitConfig,
  subject: VoidUsageSubject,
): EffectiveVoidUsagePolicy {
  const baseCooldownSeconds = normalizeLimitValue(config.defaultCooldownSeconds);
  const baseDailyLimit = normalizeLimitValue(config.defaultDailyLimit);
  const unlimitedMatches = collectMatches(subject, {
    userIds: config.unlimitedUserIds,
    roleIds: config.unlimitedRoleIds,
  });

  if (unlimitedMatches.length > 0) {
    return {
      modifier: "unlimited",
      matchedSubjects: unlimitedMatches,
    };
  }

  const boostedMatches = collectMatches(subject, {
    userIds: config.boostedUserIds,
    roleIds: config.boostedRoleIds,
  });

  if (boostedMatches.length === 0) {
    return {
      cooldownSeconds: baseCooldownSeconds,
      dailyLimit: baseDailyLimit,
      modifier: "default",
      matchedSubjects: [],
    };
  }

  const multiplier = config.boostedMultiplier > 1 ? config.boostedMultiplier : 10;

  return {
    cooldownSeconds:
      baseCooldownSeconds === undefined
        ? undefined
        : Math.max(1, Math.floor(baseCooldownSeconds / multiplier)),
    dailyLimit:
      baseDailyLimit === undefined ? undefined : Math.max(1, baseDailyLimit * multiplier),
    modifier: "boosted",
    matchedSubjects: boostedMatches,
  };
}

function normalizeLimitValue(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function collectMatches(
  subject: VoidUsageSubject,
  targets: {
    userIds: string[];
    roleIds: string[];
  },
): string[] {
  const matches: string[] = [];

  if (targets.userIds.includes(subject.actorId)) {
    matches.push(`user:${subject.actorId}`);
  }

  for (const roleId of subject.roleIds) {
    if (targets.roleIds.includes(roleId)) {
      matches.push(`role:${roleId}`);
    }
  }

  return matches;
}
