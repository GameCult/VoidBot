import {
  type Actor,
  type InteractionMemoryProfile,
  type PronounEvidence,
  type PronounEvidenceSource,
  type PronounEvidenceStance,
  type PronounSet,
  type SituationalSocialRead,
  type SourceMessage,
} from "@voidbot/shared";

interface SituationalSocialReadInput {
  prompt: string;
  actor: Actor;
  recentMessages?: SourceMessage[];
  interactionMemory?: InteractionMemoryProfile;
}

type JsonSchema = Record<string, unknown>;

interface InferSituationalSocialReadRequestBody {
  model: string;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  stream: false;
  think: false;
  keep_alive: string;
  format: JsonSchema;
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
const SITUATIONAL_SOCIAL_READ_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    roomTone: { type: "string" },
    speakerCurrentRead: { type: "string" },
    socialFrame: { type: "string" },
    responseGuidance: { type: "string" },
    supportingSignals: {
      type: "array",
      items: { type: "string" },
    },
    pronounEvidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          pronounSet: {
            type: "string",
            enum: ["they/them", "he/him", "she/her"],
          },
          source: {
            type: "string",
            enum: [
              "explicit_self_statement",
              "explicit_correction",
              "direct_third_party_statement",
              "contextual_relational_inference",
              "ambient_usage",
            ],
          },
          stance: {
            type: "string",
            enum: ["prefer", "avoid"],
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          excerpt: { type: "string" },
        },
        required: [
          "pronounSet",
          "source",
          "stance",
          "confidence",
          "excerpt",
        ],
      },
    },
  },
  required: [
    "summary",
    "roomTone",
    "speakerCurrentRead",
    "socialFrame",
    "responseGuidance",
    "supportingSignals",
    "pronounEvidence",
  ],
};

export class OllamaSituationalSocialReadInferer {
  public constructor(
    private readonly options: OllamaSituationalSocialReadInfererOptions,
  ) {}

  public async infer(
    input: SituationalSocialReadInput,
  ): Promise<SituationalSocialRead | undefined> {
    const prompt = input.prompt.trim();
    const recentMessages = (input.recentMessages ?? [])
      .filter((message) => message.content.trim().length > 0)
      .slice(-MAX_RECENT_MESSAGES);

    if (prompt.length === 0 && recentMessages.length === 0 && !input.interactionMemory) {
      return undefined;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      Math.min(this.options.ollamaTimeoutMs, 30_000),
    );

    try {
      const rawContent = await this.requestStructuredJson(
        buildSystemPrompt(),
        buildUserPrompt(input, recentMessages),
        SITUATIONAL_SOCIAL_READ_SCHEMA,
        controller.signal,
      );

      if (!rawContent) {
        return undefined;
      }

      const parsed = parseSituationalSocialRead(rawContent);

      if (!parsed) {
        return undefined;
      }
      return parsed;
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

  private async requestStructuredJson(
    systemPrompt: string,
    userPrompt: string,
    format: JsonSchema,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const requestBody: InferSituationalSocialReadRequestBody = {
      model: this.options.ollamaModel,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      stream: false,
      think: false,
      keep_alive: this.options.ollamaKeepAlive,
      format,
      options: {
        num_ctx: this.options.ollamaNumCtx,
        temperature: 0,
      },
    };

    const response = await fetch(`${normalizeBaseUrl(this.options.ollamaBaseUrl)}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `Ollama situational social read request failed with ${response.status}: ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as InferSituationalSocialReadResponseBody;
    return normalizeModelText(payload.message?.content);
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
    '- "pronounEvidence": an array of evidence objects about the current speaker only, each with "pronounSet", "source", "stance", "confidence", and "excerpt"',
    "Treat the current prompt itself as valid room context for pronoun evidence and social framing.",
    "If the current speaker explicitly states acceptable pronouns or explicitly rejects a pronoun, emit that evidence here even if no prior transcript is attached.",
    "If the speaker explicitly accepts multiple pronoun sets, emit one evidence object per accepted set.",
    'Use only these pronoun sets: "they/them", "he/him", "she/her".',
    'Use only these evidence sources: "explicit_self_statement", "explicit_correction", "direct_third_party_statement", "contextual_relational_inference", "ambient_usage".',
    'Use stance "prefer" when the speaker accepts a pronoun set and "avoid" when the speaker explicitly rejects it.',
    'If there is no real pronoun evidence, return "pronounEvidence": [].',
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
    "If you emit pronounEvidence, it must be about the current speaker rather than unrelated third parties.",
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
    const pronounEvidence = normalizePronounEvidenceArray(parsed.pronounEvidence);

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
      pronounEvidence,
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

function normalizePronounEvidenceArray(value: unknown): PronounEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizePronounEvidence(entry))
    .filter((entry): entry is PronounEvidence => entry !== undefined);
}

function normalizePronounEvidence(value: unknown): PronounEvidence | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const pronounSet = normalizePronounSet(record.pronounSet);
  const source = normalizePronounEvidenceSource(record.source);
  const stance = normalizePronounEvidenceStance(record.stance);
  const confidence = normalizeConfidence(record.confidence);
  const excerpt = normalizeModelText(record.excerpt);

  if (!pronounSet || !source || !stance || confidence === undefined || !excerpt) {
    return undefined;
  }

  return {
    pronounSet,
    source,
    stance,
    confidence,
    excerpt,
    timestamp: new Date().toISOString(),
  };
}

function normalizePronounSet(value: unknown): PronounSet | undefined {
  return value === "they/them" || value === "he/him" || value === "she/her"
    ? value
    : undefined;
}

function normalizePronounEvidenceSource(
  value: unknown,
): PronounEvidenceSource | undefined {
  switch (value) {
    case "explicit_self_statement":
    case "explicit_correction":
    case "direct_third_party_statement":
    case "contextual_relational_inference":
    case "ambient_usage":
      return value;
    default:
      return undefined;
  }
}

function normalizePronounEvidenceStance(
  value: unknown,
): PronounEvidenceStance | undefined {
  return value === "prefer" || value === "avoid" ? value : undefined;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(1, Math.max(0, value));
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
