import {
  type Actor,
  type InteractionMemoryProfile,
  type SituationalSocialRead,
  type SourceMessage,
} from "@voidbot/shared";

interface SituationalSocialReadInput {
  prompt: string;
  actor: Actor;
  recentMessages?: SourceMessage[];
  interactionMemory?: InteractionMemoryProfile;
}

interface InferSituationalSocialReadRequestBody {
  model: string;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  stream: false;
  think: false;
  keep_alive: string;
  format: "json";
  options: {
    num_ctx: number;
    temperature: number;
  };
}

interface InferSituationalSocialReadResponseBody {
  message?: {
    content?: unknown;
  };
}

export interface OllamaSituationalSocialReadInfererOptions {
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  ollamaKeepAlive: string;
  ollamaNumCtx: number;
}

const MAX_RECENT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 280;

export class OllamaSituationalSocialReadInferer {
  public constructor(
    private readonly options: OllamaSituationalSocialReadInfererOptions,
  ) {}

  public async infer(
    input: SituationalSocialReadInput,
  ): Promise<SituationalSocialRead | undefined> {
    const recentMessages = (input.recentMessages ?? [])
      .filter((message) => message.content.trim().length > 0)
      .slice(-MAX_RECENT_MESSAGES);

    if (recentMessages.length === 0 && !input.interactionMemory) {
      return undefined;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      Math.min(this.options.ollamaTimeoutMs, 30_000),
    );

    try {
      const requestBody: InferSituationalSocialReadRequestBody = {
        model: this.options.ollamaModel,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(),
          },
          {
            role: "user",
            content: buildUserPrompt(input, recentMessages),
          },
        ],
        stream: false,
        think: false,
        keep_alive: this.options.ollamaKeepAlive,
        format: "json",
        options: {
          num_ctx: this.options.ollamaNumCtx,
          temperature: 0.2,
        },
      };

      const response = await fetch(`${normalizeBaseUrl(this.options.ollamaBaseUrl)}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Ollama situational social read request failed with ${response.status}: ${await response.text()}`,
        );
      }

      const payload =
        (await response.json()) as InferSituationalSocialReadResponseBody;
      const rawContent = normalizeModelText(payload.message?.content);

      if (!rawContent) {
        return undefined;
      }

      const parsed = parseSituationalSocialRead(rawContent);
      return parsed ?? undefined;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          `Timed out waiting for situational social read from local Ollama model "${this.options.ollamaModel}" at ${this.options.ollamaBaseUrl}.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function buildSystemPrompt(): string {
  return [
    "You are producing private room-reading scaffolding for a Discord bot reply.",
    "Read the recent room context and infer only what is useful for this one reply.",
    "Do not diagnose, moralize, or write therapy notes.",
    "Do not infer more certainty than the evidence supports.",
    "This read is private scaffolding and must stay concise, practical, and grounded in visible behavior.",
    "Return strict JSON only with these keys:",
    '- "summary": one short synthesis of the current room situation',
    '- "roomTone": the room tone for this moment',
    '- "speakerCurrentRead": what the current speaker seems to be doing or wanting right now',
    '- "socialFrame": what kind of interaction this is and how it should be framed',
    '- "responseGuidance": private guidance for the final reply model',
    '- "supportingSignals": an array of short evidence bullets tied to the visible context',
    "If the evidence is weak, say so plainly inside the fields instead of inventing drama.",
  ].join("\n");
}

function buildUserPrompt(
  input: SituationalSocialReadInput,
  recentMessages: SourceMessage[],
): string {
  const recentTranscript =
    recentMessages.length > 0
      ? recentMessages
          .map(
            (message) =>
              `- [${message.timestamp}] ${message.authorName}${message.isBot ? " (bot)" : ""}: ${truncate(message.content, MAX_MESSAGE_CHARS)}`,
          )
          .join("\n")
      : "- No recent room transcript was attached.";
  const interactionMemory = input.interactionMemory
    ? [
        `Relationship summary: ${input.interactionMemory.summary}`,
        `Current stance: ${input.interactionMemory.disposition}; affinity=${input.interactionMemory.affinityScore}`,
        `Private response guidance: ${input.interactionMemory.responseGuidance}`,
      ].join("\n")
    : "No explicit long-horizon interaction memory was attached.";

  return [
    `Current speaker: ${input.actor.displayName} (${input.actor.id})`,
    "",
    "Current prompt:",
    input.prompt,
    "",
    "Recent room transcript:",
    recentTranscript,
    "",
    "Longer-horizon interaction memory:",
    interactionMemory,
    "",
    "Infer a private situational social read for this one reply.",
    "Ground it in the visible room context and the current prompt.",
    "Do not output anything except the requested JSON object.",
  ].join("\n");
}

function parseSituationalSocialRead(
  input: string,
): SituationalSocialRead | undefined {
  const normalized = unwrapStructuredFence(input);

  if (!normalized.startsWith("{")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const summary = normalizeModelText(parsed.summary);
    const roomTone = normalizeModelText(parsed.roomTone);
    const speakerCurrentRead = normalizeModelText(parsed.speakerCurrentRead);
    const socialFrame = normalizeModelText(parsed.socialFrame);
    const responseGuidance = normalizeModelText(parsed.responseGuidance);
    const supportingSignals = normalizeStringArray(parsed.supportingSignals);

    if (
      !summary ||
      !roomTone ||
      !speakerCurrentRead ||
      !socialFrame ||
      !responseGuidance
    ) {
      return undefined;
    }

    return {
      summary,
      roomTone,
      speakerCurrentRead,
      socialFrame,
      responseGuidance,
      supportingSignals,
    };
  } catch {
    return undefined;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeModelText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function unwrapStructuredFence(input: string): string {
  const trimmed = input.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeModelText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
