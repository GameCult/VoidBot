import {
  type EmbeddingChunk,
  type RetrievalFilters,
  type RetrievalResult,
  type VectorStore,
} from "@voidbot/shared";

import { SerializedFileStore } from "./file-store";
import { type TextEmbedder, HashingTextEmbedder, cosineSimilarity } from "./hash-embedder";

interface StoredVectorChunk extends EmbeddingChunk {
  vector: number[];
  indexedAt: string;
}

interface LegacyStoredVectorChunk extends Omit<StoredVectorChunk, "sourceId" | "sourceKind"> {
  sourceId?: string;
  sourceMessageId?: string;
  sourceKind?: "discord_message" | "source_document";
}

interface VectorIndexStore {
  version: 2;
  embedderId: string;
  dimensions: number;
  chunks: StoredVectorChunk[];
}

interface LegacyVectorIndexStore {
  version?: number;
  embedderId?: string;
  dimensions?: number;
  chunks?: StoredVectorChunk[];
}

const STORED_VECTOR_DECIMAL_PLACES = 4;

export class FileVectorStore implements VectorStore {
  private readonly store: SerializedFileStore<VectorIndexStore>;
  private readonly embedder: TextEmbedder;

  public constructor(filePath: string, embedder: TextEmbedder = new HashingTextEmbedder()) {
    this.embedder = embedder;
    this.store = new SerializedFileStore(filePath, () => this.createEmptyStore());
  }

  public async upsert(chunks: EmbeddingChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const vectors = await this.embedder.embedDocuments(chunks.map((chunk) => chunk.text));
    const vectorLength = validateEmbeddingBatch(vectors, chunks.length);

    await this.store.mutate((store) => {
      const activeStore = this.ensureCompatibility(store, vectorLength);
      const positions = new Map(activeStore.chunks.map((chunk, index) => [chunk.id, index]));
      const now = new Date().toISOString();

      for (const [index, chunk] of chunks.entries()) {
        const storedChunk: StoredVectorChunk = {
          ...chunk,
          vector: quantizeVector(vectors[index]),
          indexedAt: now,
        };
        const position = positions.get(chunk.id);

        if (position === undefined) {
          activeStore.chunks.push(storedChunk);
          positions.set(chunk.id, activeStore.chunks.length - 1);
          continue;
        }

        activeStore.chunks[position] = storedChunk;
      }
    });
  }

  public async clear(): Promise<void> {
    await this.store.overwrite(this.createEmptyStore());
  }

  public async deleteBySourceIds(sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) {
      return;
    }

    const sourceIdSet = new Set(sourceIds);

    await this.store.mutate((store) => {
      const activeStore = this.normalizeStore(store);
      const nextChunks = activeStore.chunks.filter(
        (chunk) => !sourceIdSet.has(chunk.sourceId),
      );
      activeStore.chunks = nextChunks;
      store.chunks = nextChunks;
    });
  }

  public async deleteByFilters(filters: RetrievalFilters): Promise<void> {
    await this.store.mutate((store) => {
      const activeStore = this.normalizeStore(store);
      const nextChunks = activeStore.chunks.filter(
        (chunk) => !matchesFilters(chunk.metadata, filters),
      );
      activeStore.chunks = nextChunks;
      store.chunks = nextChunks;
    });
  }

  public async query(
    query: string,
    limit: number,
    filters?: RetrievalFilters,
  ): Promise<RetrievalResult[]> {
    if (query.trim().length === 0) {
      return [];
    }

    const queryVector = await this.embedder.embedQuery(query);
    const vectorLength = validateSingleEmbedding(queryVector);
    const store = this.getQueryableStore(await this.store.snapshot(), vectorLength);

    return store.chunks
      .filter((chunk) => matchesFilters(chunk.metadata, filters))
      .map((chunk) => ({
        chunk,
        score: scoreChunk(query, queryVector, chunk),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ chunk, score }) => ({
        chunkId: chunk.id,
        score,
        text: chunk.text,
        sourceId: chunk.sourceId,
        sourceKind: chunk.sourceKind,
        metadata: chunk.metadata,
      }));
  }

  private createEmptyStore(dimensions = 0): VectorIndexStore {
    return createStore(this.embedder.id, dimensions);
  }

  private normalizeStore(rawStore: LegacyVectorIndexStore): VectorIndexStore {
    return writeStore(rawStore, normalizeLegacyStore(rawStore, this.embedder.id));
  }

  private ensureCompatibility(
    rawStore: LegacyVectorIndexStore,
    vectorLength: number,
  ): VectorIndexStore {
    const normalized = normalizeLegacyStore(rawStore, this.embedder.id);
    const shouldPreserve =
      shouldPreserveCurrentStore(normalized, this.embedder.id, vectorLength) ||
      shouldPreserveLegacyHashStore(rawStore, this.embedder.id, vectorLength);

    if (shouldPreserve) {
      normalized.embedderId = this.embedder.id;
      normalized.dimensions = vectorLength;
      return writeStore(rawStore, normalized);
    }

    return writeStore(rawStore, createStore(this.embedder.id, vectorLength));
  }

  private getQueryableStore(
    rawStore: LegacyVectorIndexStore,
    vectorLength: number,
  ): VectorIndexStore {
    const normalized = normalizeLegacyStore(rawStore, this.embedder.id);

    if (shouldPreserveCurrentStore(normalized, this.embedder.id, vectorLength)) {
      return normalized;
    }

    if (shouldPreserveLegacyHashStore(rawStore, this.embedder.id, vectorLength)) {
      normalized.embedderId = this.embedder.id;
      normalized.dimensions = vectorLength;
      return normalized;
    }

    return createStore(this.embedder.id, vectorLength);
  }
}

function scoreChunk(_query: string, queryVector: number[], chunk: StoredVectorChunk): number {
  const cosine = cosineSimilarity(queryVector, chunk.vector);
  return cosine;
}

function matchesFilters(metadata: Record<string, string>, filters?: RetrievalFilters): boolean {
  if (!filters) {
    return true;
  }

  if (filters.guildId && metadata.guildId !== filters.guildId) {
    return false;
  }

  if (filters.channelId && metadata.channelId !== filters.channelId) {
    return false;
  }

  if (filters.authorId && metadata.authorId !== filters.authorId) {
    return false;
  }

  if (filters.corpusKind && metadata.corpusKind !== filters.corpusKind) {
    return false;
  }

  if (filters.repoName && metadata.repoName !== filters.repoName) {
    return false;
  }

  if (filters.pathPrefix) {
    const path = metadata.path ?? "";

    if (!path.startsWith(filters.pathPrefix)) {
      return false;
    }
  }

  if (filters.language && metadata.language !== filters.language) {
    return false;
  }

  if (filters.sourceId && metadata.sourceId !== filters.sourceId) {
    return false;
  }

  return true;
}

function validateEmbeddingBatch(vectors: number[][], expectedCount: number): number {
  if (vectors.length !== expectedCount) {
    throw new Error(
      `Embedding backend returned ${vectors.length} vectors for ${expectedCount} chunks.`,
    );
  }

  return validateSingleEmbedding(vectors[0] ?? []);
}

function validateSingleEmbedding(vector: number[]): number {
  if (vector.length === 0) {
    throw new Error("Embedding backend returned an empty vector.");
  }

  return vector.length;
}

function inferVectorLength(chunks: StoredVectorChunk[]): number {
  return chunks[0]?.vector.length ?? 0;
}

function isHashEmbedderId(value: string): boolean {
  return value.startsWith("hash:");
}

function coerceChunks(value: unknown): StoredVectorChunk[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((chunk) => normalizeStoredChunk(chunk as LegacyStoredVectorChunk))
    .filter((chunk): chunk is StoredVectorChunk => Boolean(chunk));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writeStore(target: LegacyVectorIndexStore, next: VectorIndexStore): VectorIndexStore {
  target.version = next.version;
  target.embedderId = next.embedderId;
  target.dimensions = next.dimensions;
  target.chunks = next.chunks;
  return next;
}

function normalizeLegacyStore(
  rawStore: LegacyVectorIndexStore,
  fallbackEmbedderId: string,
): VectorIndexStore {
  const chunks = coerceChunks(rawStore.chunks);

  return {
    version: 2,
    embedderId: readString(rawStore.embedderId) ?? fallbackEmbedderId,
    dimensions: readNumber(rawStore.dimensions) ?? inferVectorLength(chunks),
    chunks,
  };
}

function shouldPreserveLegacyHashStore(
  rawStore: LegacyVectorIndexStore,
  embedderId: string,
  vectorLength: number,
): boolean {
  return rawStore.version === 1 && isHashEmbedderId(embedderId) && rawStore.dimensions === vectorLength;
}

function shouldPreserveCurrentStore(
  store: VectorIndexStore,
  embedderId: string,
  vectorLength: number,
): boolean {
  return store.embedderId === embedderId && store.dimensions === vectorLength;
}

function createStore(embedderId: string, dimensions = 0): VectorIndexStore {
  return {
    version: 2,
    embedderId,
    dimensions,
    chunks: [],
  };
}

function quantizeVector(vector: number[]): number[] {
  return vector.map((value) => Number(value.toFixed(STORED_VECTOR_DECIMAL_PLACES)));
}

function normalizeStoredChunk(chunk: LegacyStoredVectorChunk): StoredVectorChunk | undefined {
  const sourceId =
    typeof chunk.sourceId === "string" && chunk.sourceId.length > 0
      ? chunk.sourceId
      : typeof chunk.sourceMessageId === "string" && chunk.sourceMessageId.length > 0
        ? chunk.sourceMessageId
        : undefined;

  if (!sourceId) {
    return undefined;
  }

  return {
    ...chunk,
    sourceId,
    sourceKind: chunk.sourceKind ?? "discord_message",
    metadata: {
      ...chunk.metadata,
      sourceId,
      corpusKind: chunk.metadata?.corpusKind ?? inferCorpusKind(chunk),
    },
  };
}

function inferCorpusKind(chunk: LegacyStoredVectorChunk): "discord_history" | "repository_source" {
  return chunk.sourceKind === "source_document" ? "repository_source" : "discord_history";
}
