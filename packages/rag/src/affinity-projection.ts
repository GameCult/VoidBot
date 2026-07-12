import { createHash } from "node:crypto";

import { cosineSimilarity, type TextEmbedder } from "./hash-embedder";

export interface AffinityCard {
  id: string;
  text: string;
}

export interface EmbeddedAffinityCard extends AffinityCard {
  contentHash: string;
  embedderId: string;
  embedding: number[];
}

export interface AffinityMessage {
  id: string;
  text: string;
  observedAt: string;
}

export interface AffinityScore {
  cardId: string;
  messageId: string;
  observedAt: string;
  similarity: number;
}

export async function embedAffinityCards(
  embedder: TextEmbedder,
  cards: AffinityCard[],
): Promise<EmbeddedAffinityCard[]> {
  const usable = cards.filter((card) => card.id.trim() && card.text.trim());
  const embeddings = await embedder.embedDocuments(usable.map((card) => card.text));
  if (embeddings.length !== usable.length) {
    throw new Error(`Affinity embedder returned ${embeddings.length} card vectors for ${usable.length} cards.`);
  }

  return usable.map((card, index) => ({
    ...card,
    contentHash: createHash("sha256").update(card.text).digest("hex"),
    embedderId: embedder.id,
    embedding: embeddings[index] ?? [],
  }));
}

export async function scoreAffinityMessages(
  embedder: TextEmbedder,
  cards: EmbeddedAffinityCard[],
  messages: AffinityMessage[],
): Promise<AffinityScore[]> {
  const mismatched = cards.find((card) => card.embedderId !== embedder.id);
  if (mismatched) {
    throw new Error(`Affinity card ${mismatched.id} uses ${mismatched.embedderId}, not ${embedder.id}.`);
  }

  const usable = messages.filter((message) => message.id.trim() && message.text.trim());
  const embeddings = await embedder.embedDocuments(usable.map((message) => message.text));
  if (embeddings.length !== usable.length) {
    throw new Error(`Affinity embedder returned ${embeddings.length} message vectors for ${usable.length} messages.`);
  }

  return cards.flatMap((card) => usable.map((message, index) => ({
    cardId: card.id,
    messageId: message.id,
    observedAt: message.observedAt,
    similarity: clampSimilarity(cosineSimilarity(card.embedding, embeddings[index] ?? [])),
  })));
}

function clampSimilarity(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}
