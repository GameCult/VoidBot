import {
  type Actor,
  type JobRecord,
  type ProviderName,
  type TrustTier,
} from "@voidbot/shared";

export interface ProviderAccessDecision {
  allowed: boolean;
  tier: TrustTier;
  reasonKey?: string;
}

export class PermissionEngine {
  public constructor(
    private readonly ownerDiscordId: string,
    private readonly options: {
      localLlmAllowPublic?: boolean;
    } = {},
  ) {}

  public resolveTrustTier(actor: Actor): TrustTier {
    if (actor.id === this.ownerDiscordId) {
      return "T2";
    }

    if (actor.isAdmin) {
      return "T1";
    }

    return "T0";
  }

  public canUseProvider(actor: Actor, provider: ProviderName): ProviderAccessDecision {
    const tier = this.resolveTrustTier(actor);

    if (provider === "owner_codex") {
      return actor.id === this.ownerDiscordId
        ? { allowed: true, tier }
        : {
            allowed: false,
            tier,
            reasonKey: "permission.owner_codex.denied",
          };
    }

    if (provider === "openai_api") {
      return {
        allowed: tier === "T0" || tier === "T1" || tier === "T2",
        tier,
      };
    }

    if (provider === "local_llm") {
      return this.options.localLlmAllowPublic || tier === "T1" || tier === "T2"
        ? {
            allowed: true,
            tier,
          }
        : {
            allowed: false,
            tier,
            reasonKey: "permission.local_llm.denied",
          };
    }

    return {
      allowed: true,
      tier,
    };
  }

  public canReindex(actor: Actor): boolean {
    const tier = this.resolveTrustTier(actor);
    return tier === "T1" || tier === "T2";
  }

  public canManageConfiguration(actor: Actor): boolean {
    const tier = this.resolveTrustTier(actor);
    return tier === "T1" || tier === "T2";
  }

  public canApproveJob(actor: Actor, job: JobRecord): boolean {
    return actor.id === this.ownerDiscordId && job.requester.id === this.ownerDiscordId;
  }
}
