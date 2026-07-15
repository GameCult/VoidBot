export interface WeksaSpeechClientOptions {
  commandUri: string;
  repoRoot: string;
  timeoutMs: number;
}

export interface WeksaRepoFaceSpeechInput {
  jobId: string;
  identityId: string;
  displayName: string;
  repoName: string;
  personaStatePath: string;
  channelId: string;
  messageId: string;
  content: string;
  replyToMessageId?: string;
  requestId?: string;
  scene?: string;
  addressee?: string;
  performanceRegister?: Record<string, unknown>;
  deliveryControls?: string[];
  forbiddenTraits?: string[];
  voiceDesignPrompt?: string;
  privateInterpretation?: string;
  intendedEffect?: string;
}

export interface WeksaMimoReceipt {
  schema_version?: string;
  request_id?: string;
  ok?: boolean;
  provider?: string;
  model?: string;
  artifacts?: {
    audio?: string;
    receipt?: string;
    interlingua_packet?: string;
    mimo_request?: string;
  };
  provider_response?: {
    audio_bytes?: number;
  };
}

export class WeksaSpeechClient {
  private readonly commandUri: string;
  private readonly repoRoot: string;
  private readonly timeoutMs: number;

  constructor(options: WeksaSpeechClientOptions) {
    this.commandUri = options.commandUri;
    this.repoRoot = options.repoRoot;
    this.timeoutMs = options.timeoutMs;
  }

  async renderRepoFaceSpeech(input: WeksaRepoFaceSpeechInput): Promise<WeksaMimoReceipt> {
    const requestId = input.requestId ?? buildRequestId(input);
    void this.repoRoot;
    void this.timeoutMs;
    throw new Error(
      `Weksa speech command ${requestId} requires CultMesh command document publication to ${this.commandUri}; the legacy direct sender has been removed.`,
    );
  }
}

function buildRequestId(input: WeksaRepoFaceSpeechInput): string {
  return [
    "voidbot",
    sanitizeId(input.identityId),
    sanitizeId(input.jobId).slice(0, 16),
    sanitizeId(input.messageId).slice(0, 24),
  ].filter(Boolean).join("-");
}

function sanitizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
