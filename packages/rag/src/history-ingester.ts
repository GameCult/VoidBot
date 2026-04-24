import {
  type ArchivedMessage,
  type EmbeddingChunk,
  type VectorStore,
} from "@voidbot/shared";

const DEFAULT_CHUNK_SIZE = 420;

export class HistoryIngester {
  public constructor(private readonly chunkSize = DEFAULT_CHUNK_SIZE) {}

  public chunkMessages(messages: ArchivedMessage[]): EmbeddingChunk[] {
    return messages.flatMap((message) => this.chunkMessage(message));
  }

  public async ingestMessages(
    messages: ArchivedMessage[],
    vectorStore: VectorStore,
  ): Promise<EmbeddingChunk[]> {
    const chunks = this.chunkMessages(messages);
    await vectorStore.upsert(chunks);
    return chunks;
  }

  public chunkMessage(message: ArchivedMessage): EmbeddingChunk[] {
    const segments = splitText(message.content, this.chunkSize);

    return segments.map((segment, index) => ({
      id: `${message.id}:${index}`,
      sourceId: message.id,
      sourceKind: "discord_message",
      text: segment,
      normalizedText: normalizeText(segment),
      metadata: {
        corpusKind: "discord_history",
        sourceId: message.id,
        guildId: message.guildId ?? "",
        channelId: message.channelId,
        authorId: message.authorId,
        authorName: message.authorName,
        timestamp: message.timestamp,
        chunkIndex: String(index),
        threadId: message.threadId ?? "",
        editedAt: message.editedAt ?? "",
      },
    }));
  }
}

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function splitText(input: string, maxLength: number): string[] {
  const normalized = input.trim();

  if (normalized.length === 0) {
    return ["(empty message)"];
  }

  const segments: string[] = [];

  for (let cursor = 0; cursor < normalized.length; cursor += maxLength) {
    segments.push(normalized.slice(cursor, cursor + maxLength));
  }

  return segments;
}
