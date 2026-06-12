export interface WeksaSpeechClientOptions {
  baseUrl: string;
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
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: WeksaSpeechClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
  }

  async renderRepoFaceSpeech(input: WeksaRepoFaceSpeechInput): Promise<WeksaMimoReceipt> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/speech-provider/mimo/voicedesign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          request_id: buildRequestId(input),
          persona_state_path: input.personaStatePath,
          speaker_agent_id: input.identityId,
          thought_text: input.content,
          spoken_text: input.content,
          scene: `Discord channel ${input.channelId}`,
          addressee: "Discord room",
          intent: input.content,
          performance_register: {
            label: `${input.displayName} Discord voice`,
            medium: "Discord voice channel playback",
            delivery_archetype: `${input.displayName} speaks an approved VoidBot SAY line`,
          },
          delivery_controls: [
            "Discord-room conversational delivery",
            "preserve the approved text exactly",
            `repo Face for ${input.repoName}`,
          ],
          forbidden_traits: [
            "generic assistant voice",
            "rewriting source meaning",
            "changing the approved Discord text",
          ],
          private_interpretation:
            "VoidBot already approved this SAY line for public text delivery; Weksa is only projecting it into spoken audio.",
          intended_effect: "Make the approved public Discord line audible without changing its meaning.",
        }),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Weksa speech request failed with ${response.status}: ${text}`);
      }
      return JSON.parse(text) as WeksaMimoReceipt;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Weksa speech request timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
