import {
  type Actor,
  type InteractionMemoryProfile,
  type PronounEvidence,
  type PronounEvidenceSource,
  type PronounEvidenceStance,
  type PronounSet,
  socialReadBehavioralDimensionKeys,
  socialReadPresentationStrategyKeys,
  socialReadSituationalStateKeys,
  socialReadStableDispositionKeys,
  socialReadUnderlyingOrganizationKeys,
  socialReadVoiceStyleKeys,
  type SituationalSocialRead,
  type SourceMessage,
  type TranscriptParticipantRead,
  loadPromptTemplate,
} from "@voidbot/shared";

import {
  BEHAVIORAL_DIMENSION_DESCRIPTORS,
  PRESENTATION_STRATEGY_DESCRIPTORS,
  SITUATIONAL_STATE_DESCRIPTORS,
  STABLE_DISPOSITION_DESCRIPTORS,
  UNDERLYING_ORGANIZATION_DESCRIPTORS,
  VOICE_STYLE_DESCRIPTORS,
} from "./social-read-glossary";

interface SituationalSocialReadInput {
  prompt: string;
  actor: Actor;
  recentMessages?: SourceMessage[];
  interactionMemory?: InteractionMemoryProfile;
}

interface ParticipantRosterEntry {
  actorId: string;
  actorName: string;
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

const PRONOUN_EVIDENCE_SCHEMA = {
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
  required: ["pronounSet", "source", "stance", "confidence", "excerpt"],
} satisfies JsonSchema;

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
    const participantRoster = buildParticipantRoster(input.actor, recentMessages);

    if (
      prompt.length === 0 &&
      recentMessages.length === 0 &&
      !input.interactionMemory &&
      participantRoster.length === 0
    ) {
      return undefined;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      this.options.ollamaTimeoutMs,
    );

    try {
      const rawContent = await this.requestStructuredJson(
        buildSystemPrompt(),
        buildUserPrompt(input, recentMessages, participantRoster),
        buildSituationalSocialReadSchema(participantRoster),
        controller.signal,
      );

      if (!rawContent) {
        return undefined;
      }

      return parseSituationalSocialRead(rawContent, input.actor.id, participantRoster);
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
  return loadPromptTemplate("situational-social-read-system.prompt.md", {
    underlyingOrganizationGlossary: renderLabelGlossary(UNDERLYING_ORGANIZATION_DESCRIPTORS),
    stableDispositionGlossary: renderLabelGlossary(STABLE_DISPOSITION_DESCRIPTORS),
    behavioralDimensionGlossary: renderLabelGlossary(BEHAVIORAL_DIMENSION_DESCRIPTORS),
    presentationStrategyGlossary: renderLabelGlossary(PRESENTATION_STRATEGY_DESCRIPTORS),
    voiceStyleGlossary: renderLabelGlossary(VOICE_STYLE_DESCRIPTORS),
    situationalStateGlossary: renderLabelGlossary(SITUATIONAL_STATE_DESCRIPTORS),
  });
}

function buildUserPrompt(
  input: SituationalSocialReadInput,
  recentMessages: SourceMessage[],
  participantRoster: ParticipantRosterEntry[],
): string {
  const recentTranscript =
    recentMessages.length > 0
      ? recentMessages
          .map(
            (message) =>
              `- [${message.timestamp}] ${message.authorName} (${message.authorId})${message.isBot ? " (bot)" : ""}: ${truncate(message.content, MAX_MESSAGE_CHARS)}`,
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
  const participantLines =
    participantRoster.length > 0
      ? participantRoster
          .map((participant) => `- ${participant.actorName} (${participant.actorId})`)
          .join("\n")
      : "- No participant roster was derived.";

  return loadPromptTemplate("situational-social-read-user.prompt.md", {
    speakerName: input.actor.displayName,
    speakerId: input.actor.id,
    prompt: input.prompt,
    recentTranscript,
    interactionMemory,
    participantLines,
  });
}

function buildParticipantReadSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      actorId: { type: "string" },
      actorName: { type: "string" },
      summary: { type: "string" },
      underlyingOrganization: {
        type: "array",
        items: {
          type: "string",
          enum: [...socialReadUnderlyingOrganizationKeys],
        },
      },
      stableDispositions: {
        type: "array",
        items: {
          type: "string",
          enum: [...socialReadStableDispositionKeys],
        },
      },
      behavioralDimensions: {
        type: "array",
        items: {
          type: "string",
          enum: [...socialReadBehavioralDimensionKeys],
        },
      },
      presentationStrategies: {
        type: "array",
        items: {
          type: "string",
          enum: [...socialReadPresentationStrategyKeys],
        },
      },
      voiceStyle: {
        type: "array",
        items: {
          type: "string",
          enum: [...socialReadVoiceStyleKeys],
        },
      },
      situationalState: {
        type: "array",
        items: {
          type: "string",
          enum: [...socialReadSituationalStateKeys],
        },
      },
      pronounEvidence: {
        type: "array",
        items: PRONOUN_EVIDENCE_SCHEMA,
      },
      supportingSignals: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: [
      "actorId",
      "actorName",
      "summary",
      "underlyingOrganization",
      "stableDispositions",
      "behavioralDimensions",
      "presentationStrategies",
      "voiceStyle",
      "situationalState",
      "pronounEvidence",
      "supportingSignals",
    ],
  } satisfies JsonSchema;
}

function buildSituationalSocialReadSchema(
  participantRoster: ParticipantRosterEntry[],
): JsonSchema {
  return {
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
      participantReads: {
        type: "array",
        items: buildParticipantReadSchema(),
      },
    },
    required: [
      "summary",
      "roomTone",
      "speakerCurrentRead",
      "socialFrame",
      "responseGuidance",
      "supportingSignals",
      "participantReads",
    ],
  } satisfies JsonSchema;
}

function parseSituationalSocialRead(
  input: string,
  currentActorId: string,
  participantRoster: ParticipantRosterEntry[],
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
    const participantReads = normalizeParticipantReadArray(
      parsed.participantReads,
      participantRoster,
    );

    if (
      !summary ||
      !roomTone ||
      !speakerCurrentRead ||
      !socialFrame ||
      !responseGuidance
    ) {
      return undefined;
    }

    const currentParticipantRead =
      participantReads.find((entry) => entry.actorId === currentActorId) ??
      participantReads[0];

    return {
      summary,
      roomTone,
      speakerCurrentRead,
      socialFrame,
      responseGuidance,
      supportingSignals,
      pronounEvidence: currentParticipantRead?.pronounEvidence ?? [],
      participantReads,
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

function normalizeParticipantReadArray(
  value: unknown,
  participantRoster: ParticipantRosterEntry[],
): TranscriptParticipantRead[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rosterById = new Map(
    participantRoster.map((participant) => [participant.actorId, participant]),
  );
  const rosterByName = new Map(
    participantRoster.map((participant) => [
      participant.actorName.trim().toLowerCase(),
      participant,
    ]),
  );
  const deduped = new Map<string, TranscriptParticipantRead>();

  for (const entry of value) {
    const normalized = normalizeParticipantRead(entry, rosterById, rosterByName);

    if (!normalized || deduped.has(normalized.actorId)) {
      continue;
    }

    deduped.set(normalized.actorId, normalized);
  }

  return participantRoster
    .map((participant) => deduped.get(participant.actorId))
    .filter((entry): entry is TranscriptParticipantRead => entry !== undefined);
}

function normalizeParticipantRead(
  value: unknown,
  rosterById: Map<string, ParticipantRosterEntry>,
  rosterByName: Map<string, ParticipantRosterEntry>,
): TranscriptParticipantRead | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const rawActorId = normalizeModelText(record.actorId);
  const rawActorName = normalizeModelText(record.actorName);
  const summary = normalizeModelText(record.summary);
  const underlyingOrganization = normalizeEnumArray(
    record.underlyingOrganization,
    socialReadUnderlyingOrganizationKeys,
  );
  const stableDispositions = normalizeEnumArray(
    record.stableDispositions,
    socialReadStableDispositionKeys,
  );
  const behavioralDimensions = normalizeEnumArray(
    record.behavioralDimensions,
    socialReadBehavioralDimensionKeys,
  );
  const presentationStrategies = normalizeEnumArray(
    record.presentationStrategies,
    socialReadPresentationStrategyKeys,
  );
  const voiceStyle = normalizeEnumArray(record.voiceStyle, socialReadVoiceStyleKeys);
  const situationalState = normalizeEnumArray(
    record.situationalState,
    socialReadSituationalStateKeys,
  );
  const pronounEvidence = normalizePronounEvidenceArray(record.pronounEvidence);
  const supportingSignals = normalizeStringArray(record.supportingSignals);
  const rosterEntry =
    (rawActorId ? rosterById.get(rawActorId) : undefined) ??
    (rawActorName ? rosterByName.get(rawActorName.trim().toLowerCase()) : undefined);

  if (!rosterEntry || !summary) {
    return undefined;
  }

  return {
    actorId: rosterEntry.actorId,
    actorName: rosterEntry.actorName,
    summary,
    underlyingOrganization,
    stableDispositions,
    behavioralDimensions,
    presentationStrategies,
    voiceStyle,
    situationalState,
    pronounEvidence,
    supportingSignals,
  };
}

function normalizeEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is T => allowed.includes(entry as T));
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

function renderLabelGlossary(
  definitions: Record<string, { label: string; description: string }>,
): string {
  return Object.entries(definitions)
    .map(([key, descriptor]) => `- ${key}: ${descriptor.label}. ${descriptor.description}`)
    .join("\n");
}

function buildParticipantRoster(
  actor: Actor,
  recentMessages: SourceMessage[],
): ParticipantRosterEntry[] {
  const roster = new Map<string, ParticipantRosterEntry>();

  if (!actor.isBot) {
    roster.set(actor.id, {
      actorId: actor.id,
      actorName: actor.displayName,
    });
  }

  for (const message of recentMessages) {
    if (message.isBot) {
      continue;
    }

    roster.set(message.authorId, {
      actorId: message.authorId,
      actorName: message.authorName,
    });
  }

  return [...roster.values()];
}
