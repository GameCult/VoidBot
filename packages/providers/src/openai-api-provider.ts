import {
  type Actor,
  type ContextBundle,
  type GuildContext,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
} from "@voidbot/shared";

export class OpenAiApiProvider implements ProviderAdapter {
  public constructor(private readonly enabled: boolean) {}

  public getName(): "openai_api" {
    return "openai_api";
  }

  public getCapabilities(): string[] {
    return [
      "public_generation",
      "input_moderation_required",
      "output_moderation_required",
      "budget_controls_required",
    ];
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public isAllowedForActor(_actor: Actor, _guildContext: GuildContext): boolean {
    return this.enabled;
  }

  public buildRequest(
    contextBundle: ContextBundle,
    options?: Record<string, unknown>,
  ): ProviderRequest {
    return {
      provider: "openai_api",
      contextBundle,
      options,
    };
  }

  public async execute(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error("The OpenAI API provider scaffold exists, but the runtime adapter is not wired yet.");
  }

  public async estimateCost(_request: ProviderRequest): Promise<number> {
    return 0;
  }

  public getAuditRedactions(): string[] {
    return ["api_key"];
  }
}

