import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  type EmbeddingChunk,
  type RetrievalFilters,
  type RetrievalResult,
  type VectorStore,
} from "@voidbot/shared";

import { SerializedFileStore } from "./file-store";
import { type TextEmbedder, HashingTextEmbedder, cosineSimilarity } from "./hash-embedder";
import { FileVectorStore } from "./file-vector-store";

interface StoredVectorChunk extends EmbeddingChunk {
  vector: number[];
  indexedAt: string;
}

interface VectorIndexStore {
  version: 2;
  embedderId: string;
  dimensions: number;
  chunks: StoredVectorChunk[];
}

export class ShardedSourceVectorStore implements VectorStore {
  private readonly embedder: TextEmbedder;
  private readonly storeCache = new Map<string, FileVectorStore>();

  public constructor(
    private readonly rootDirectory: string,
    embedder: TextEmbedder = new HashingTextEmbedder(),
  ) {
    this.embedder = embedder;
  }

  public async upsert(chunks: EmbeddingChunk[]): Promise<void> {
    const batches = groupChunksByRepo(chunks);

    for (const [repoName, batch] of batches) {
      await this.getStore(repoName).upsert(batch);
    }
  }

  public async clear(): Promise<void> {
    await rm(this.rootDirectory, { recursive: true, force: true });
    this.storeCache.clear();
  }

  public async deleteBySourceIds(sourceIds: string[]): Promise<void> {
    const groupedIds = new Map<string, string[]>();

    for (const sourceId of sourceIds) {
      const repoName = deriveRepoNameFromSourceId(sourceId);

      if (!repoName) {
        continue;
      }

      const bucket = groupedIds.get(repoName) ?? [];
      bucket.push(sourceId);
      groupedIds.set(repoName, bucket);
    }

    for (const [repoName, ids] of groupedIds) {
      await this.getStore(repoName).deleteBySourceIds(ids);
    }
  }

  public async deleteByFilters(filters: RetrievalFilters): Promise<void> {
    const repoNames = await this.resolveCandidateRepos(filters);

    for (const repoName of repoNames) {
      await this.getStore(repoName).deleteByFilters(filters);
    }
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
    const repoNames = await this.resolveCandidateRepos(filters);
    const results: RetrievalResult[] = [];

    for (const repoName of repoNames) {
      const shardStore = await this.readShardStore(repoName);

      for (const chunk of shardStore.chunks) {
        if (!matchesFilters(chunk.metadata, filters)) {
          continue;
        }

        const score = cosineSimilarity(queryVector, chunk.vector);

        if (score <= 0) {
          continue;
        }

        results.push({
          chunkId: chunk.id,
          score,
          text: chunk.text,
          sourceId: chunk.sourceId,
          sourceKind: chunk.sourceKind,
          metadata: chunk.metadata,
        });
      }
    }

    return results
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  private getStore(repoName: string): FileVectorStore {
    const cached = this.storeCache.get(repoName);

    if (cached) {
      return cached;
    }

    const store = new FileVectorStore(this.getShardPath(repoName), this.embedder);
    this.storeCache.set(repoName, store);
    return store;
  }

  private getShardPath(repoName: string): string {
    return join(this.rootDirectory, `${encodeURIComponent(repoName)}.json`);
  }

  private async resolveCandidateRepos(filters?: RetrievalFilters): Promise<string[]> {
    if (filters?.repoName) {
      return [filters.repoName];
    }

    await mkdir(this.rootDirectory, { recursive: true });
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => decodeURIComponent(basename(entry.name, ".json")))
      .sort((left, right) => left.localeCompare(right));
  }

  private async readShardStore(repoName: string): Promise<VectorIndexStore> {
    const store = new SerializedFileStore<VectorIndexStore>(this.getShardPath(repoName), () => ({
      version: 2,
      embedderId: this.embedder.id,
      dimensions: 0,
      chunks: [],
    }));

    return store.snapshot();
  }
}

function groupChunksByRepo(chunks: EmbeddingChunk[]): Map<string, EmbeddingChunk[]> {
  const batches = new Map<string, EmbeddingChunk[]>();

  for (const chunk of chunks) {
    const repoName = chunk.metadata.repoName ?? deriveRepoNameFromSourceId(chunk.sourceId);

    if (!repoName) {
      throw new Error(`Cannot upsert source chunk ${chunk.id} without a repoName.`);
    }

    const batch = batches.get(repoName) ?? [];
    batch.push(chunk);
    batches.set(repoName, batch);
  }

  return batches;
}

function deriveRepoNameFromSourceId(sourceId: string): string | undefined {
  const separatorIndex = sourceId.indexOf(":");
  return separatorIndex === -1 ? undefined : sourceId.slice(0, separatorIndex);
}

function matchesFilters(
  metadata: Record<string, string>,
  filters?: RetrievalFilters,
): boolean {
  if (!filters) {
    return true;
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
