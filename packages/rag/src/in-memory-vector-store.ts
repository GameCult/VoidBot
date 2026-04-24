import {
  type EmbeddingChunk,
  type RetrievalFilters,
  type RetrievalResult,
  type VectorStore,
} from "@voidbot/shared";

export class InMemoryVectorStore implements VectorStore {
  private readonly chunks = new Map<string, EmbeddingChunk>();

  public async upsert(chunks: EmbeddingChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }
  }

  public async clear(): Promise<void> {
    this.chunks.clear();
  }

  public async deleteBySourceIds(sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) {
      return;
    }

    const sourceIdSet = new Set(sourceIds);

    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (sourceIdSet.has(chunk.sourceId)) {
        this.chunks.delete(chunkId);
      }
    }
  }

  public async deleteByFilters(filters: RetrievalFilters): Promise<void> {
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (matchesFilters(chunk.metadata, filters)) {
        this.chunks.delete(chunkId);
      }
    }
  }

  public async query(
    query: string,
    limit: number,
    filters?: RetrievalFilters,
  ): Promise<RetrievalResult[]> {
    const queryTerms = tokenize(query);

    return [...this.chunks.values()]
      .filter((chunk) => matchesFilters(chunk.metadata, filters))
      .map((chunk) => ({
        chunk,
        score: scoreChunk(queryTerms, chunk.normalizedText),
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
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function scoreChunk(queryTerms: string[], normalizedText: string): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  let matches = 0;

  for (const term of queryTerms) {
    if (normalizedText.includes(term)) {
      matches += 1;
    }
  }

  return matches / queryTerms.length;
}

function matchesFilters(
  metadata: Record<string, string>,
  filters?: RetrievalFilters,
): boolean {
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
