import { projectRepoFaceResponsePressure, type ResponsePressureProjection } from "@voidbot/core";
import { createTextEmbedder, embedAffinityCards, scoreAffinityMessages } from "@voidbot/rag";

export interface SemanticPressureCandidate {
  identityId: string;
  interruptThreshold: number;
  affinityText: string;
  allowedChannelIds: string[];
}

export interface SemanticPressureMessage {
  id: string;
  content: string;
  timestamp: string;
  channelId: string;
  isBot: boolean;
}

export interface SemanticPressureResult {
  projections: ResponsePressureProjection[];
  unavailableReason?: string;
}

export async function readSemanticPressure(input: {
  candidates: SemanticPressureCandidate[];
  messages: SemanticPressureMessage[];
  now: Date;
  embedding: {
    backend: Parameters<typeof createTextEmbedder>[0]["backend"];
    hashDimensions: number;
    ollamaBaseUrl: string;
    ollamaModel: string;
    ollamaTimeoutMs: number;
  };
}): Promise<SemanticPressureResult> {
  const messages = input.messages
    .filter((message) => !message.isBot && message.content.trim().length > 0)
    .filter((message) => input.now.getTime() - Date.parse(message.timestamp) <= 3 * 60 * 60_000)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 24);
  if (input.candidates.length === 0 || messages.length === 0) return { projections: [] };

  try {
    const embedder = createTextEmbedder(input.embedding);
    const cards = await embedAffinityCards(embedder, input.candidates.map((candidate) => ({
      id: candidate.identityId,
      text: candidate.affinityText,
    })));
    const scores = await scoreAffinityMessages(embedder, cards, messages.map((message) => ({
      id: message.id,
      text: message.content,
      observedAt: message.timestamp,
    })));
    return {
      projections: projectRepoFaceResponsePressure({
        participants: input.candidates.map((candidate) => ({
          identityId: candidate.identityId,
          interruptThreshold: candidate.interruptThreshold,
        })),
        evidence: scores.flatMap((score) => {
          const candidate = input.candidates.find((entry) => entry.identityId === score.cardId);
          const message = messages.find((entry) => entry.id === score.messageId);
          if (!candidate || !message || !candidate.allowedChannelIds.includes(message.channelId)) return [];
          return [{
            identityId: score.cardId,
            messageId: score.messageId,
            observedAt: score.observedAt,
            similarity: score.similarity,
          }];
        }),
        now: input.now,
        maxAwakened: Math.min(3, input.candidates.length),
      }),
    };
  } catch (error) {
    return {
      projections: [],
      unavailableReason: collapseWhitespace(error instanceof Error ? error.message : String(error), 300),
    };
  }
}

function collapseWhitespace(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
