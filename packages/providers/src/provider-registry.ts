import {
  type Actor,
  type GuildContext,
  type ProviderAdapter,
  type ProviderName,
} from "@voidbot/shared";

export interface ProviderStatus {
  name: ProviderName;
  enabled: boolean;
  allowed: boolean;
  capabilities: string[];
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, ProviderAdapter>();

  public constructor(providers: ProviderAdapter[]) {
    for (const provider of providers) {
      this.providers.set(provider.getName(), provider);
    }
  }

  public get(name: ProviderName): ProviderAdapter | undefined {
    return this.providers.get(name);
  }

  public list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }

  public listStatuses(actor: Actor, guildContext: GuildContext): ProviderStatus[] {
    return this.list().map((provider) => ({
      name: provider.getName(),
      enabled: provider.isEnabled(),
      allowed: provider.isAllowedForActor(actor, guildContext),
      capabilities: provider.getCapabilities(),
    }));
  }
}

