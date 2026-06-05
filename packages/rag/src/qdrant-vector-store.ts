import { createHash } from "node:crypto";

import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import {
  type EmbeddingChunk,
  type RetrievalFilters,
  type RetrievalResult,
  type VectorStore,
} from "@voidbot/shared";

import { type TextEmbedder, HashingTextEmbedder } from "./hash-embedder";

const UPSERT_BATCH_SIZE = 256;
const DELETE_BATCH_SIZE = 128;
const COLLECTION_METADATA_VERSION = 1;

type QdrantPayload = Schemas["Payload"];
type QdrantPoint = Schemas["PointStruct"];
type QdrantScoredPoint = Schemas["ScoredPoint"];
type QdrantFilter = Schemas["Filter"];

export interface StoredQdrantChunk extends EmbeddingChunk {
  vector: number[];
  indexedAt: string;
}

export interface QdrantVectorStoreOptions {
  url: string;
  collectionName: string;
  corpusKind: "discord_history" | "repository_source" | "persona_memory";
  apiKey?: string;
  timeoutMs?: number;
  embedder?: TextEmbedder;
}

export class QdrantVectorStore implements VectorStore {
  private readonly client: QdrantClient;
  private readonly embedder: TextEmbedder;
  private readonly timeoutSeconds?: number;
  private ensuredVectorLength?: number;

  public constructor(private readonly options: QdrantVectorStoreOptions) {
    this.embedder = options.embedder ?? new HashingTextEmbedder();
    this.client = new QdrantClient({
      url: options.url,
      apiKey: options.apiKey,
      checkCompatibility: true,
    });
    this.timeoutSeconds = options.timeoutMs
      ? Math.max(1, Math.ceil(options.timeoutMs / 1000))
      : undefined;
  }

  public async upsert(chunks: EmbeddingChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const vectors = await this.embedder.embedDocuments(chunks.map((chunk) => chunk.text));
    const vectorLength = validateEmbeddingBatch(vectors, chunks.length);
    await this.ensureCollection(vectorLength);
    const indexedAt = new Date().toISOString();

    for (let index = 0; index < chunks.length; index += UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(index, index + UPSERT_BATCH_SIZE);
      const points = batch.map((chunk, offset) =>
        toQdrantPoint({
          ...chunk,
          vector: vectors[index + offset],
          indexedAt,
        }),
      );

      await this.client.upsert(this.options.collectionName, {
        wait: true,
        timeout: this.timeoutSeconds,
        points,
      });
    }
  }

  public async upsertStoredChunks(chunks: StoredQdrantChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const vectorLength = validateSingleEmbedding(chunks[0]?.vector ?? []);
    await this.ensureCollection(vectorLength);

    for (let index = 0; index < chunks.length; index += UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(index, index + UPSERT_BATCH_SIZE);
      const points = batch.map((chunk) => toQdrantPoint(chunk));

      await this.client.upsert(this.options.collectionName, {
        wait: true,
        timeout: this.timeoutSeconds,
        points,
      });
    }
  }

  public async clear(): Promise<void> {
    const exists = await this.client.collectionExists(this.options.collectionName);

    if (!exists.exists) {
      return;
    }

    await this.client.deleteCollection(this.options.collectionName, {
      timeout: this.timeoutSeconds,
    });
    this.ensuredVectorLength = undefined;
  }

  public async deleteBySourceIds(sourceIds: string[]): Promise<void> {
    for (let index = 0; index < sourceIds.length; index += DELETE_BATCH_SIZE) {
      const batch = sourceIds.slice(index, index + DELETE_BATCH_SIZE);
      const filter = buildMatchAnyFilter("sourceId", batch);

      if (!filter) {
        continue;
      }

      await this.deleteByFilter(filter);
    }
  }

  public async deleteByFilters(filters: RetrievalFilters): Promise<void> {
    const filter = toQdrantFilter(filters);

    if (!filter) {
      return;
    }

    await this.deleteByFilter(filter);
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
    const exists = await this.ensureCollection(vectorLength, { createIfMissing: false });

    if (!exists) {
      return [];
    }

    const results = await this.client.search(this.options.collectionName, {
      vector: queryVector,
      limit,
      timeout: this.timeoutSeconds,
      with_payload: true,
      with_vector: false,
      filter: toQdrantFilter(filters),
    });

    return results
      .map((point) => fromQdrantPoint(point))
      .filter((result): result is RetrievalResult => Boolean(result));
  }

  private async deleteByFilter(filter: QdrantFilter): Promise<void> {
    const exists = await this.client.collectionExists(this.options.collectionName);

    if (!exists.exists) {
      return;
    }

    await this.client.delete(this.options.collectionName, {
      wait: true,
      timeout: this.timeoutSeconds,
      filter,
    });
  }

  private async ensureCollection(
    vectorLength: number,
    options?: {
      createIfMissing?: boolean;
    },
  ): Promise<boolean> {
    if (this.ensuredVectorLength === vectorLength) {
      return true;
    }

    const createIfMissing = options?.createIfMissing ?? true;
    const exists = await this.client.collectionExists(this.options.collectionName);

    if (!exists.exists) {
      if (!createIfMissing) {
        return false;
      }

      await this.client.createCollection(this.options.collectionName, {
        timeout: this.timeoutSeconds,
        vectors: {
          size: vectorLength,
          distance: "Cosine",
          on_disk: true,
        },
        on_disk_payload: true,
        metadata: {
          managedBy: "voidbot",
          corpusKind: this.options.corpusKind,
          embedderId: this.embedder.id,
          vectorLength,
          schemaVersion: COLLECTION_METADATA_VERSION,
        },
      });
      await this.ensurePayloadIndexes();
      this.ensuredVectorLength = vectorLength;
      return true;
    }

    const collection = await this.client.getCollection(this.options.collectionName);
    validateCollectionCompatibility(collection, {
      collectionName: this.options.collectionName,
      corpusKind: this.options.corpusKind,
      embedderId: this.embedder.id,
      vectorLength,
    });
    await this.ensurePayloadIndexes(collection);
    this.ensuredVectorLength = vectorLength;
    return true;
  }

  private async ensurePayloadIndexes(existingCollection?: Schemas["CollectionInfo"]): Promise<void> {
    const collection =
      existingCollection ??
      (await this.client.getCollection(this.options.collectionName));
    const existingIndexes = new Set(Object.keys(collection.payload_schema ?? {}));

    for (const index of buildPayloadIndexDefinitions(this.options.corpusKind)) {
      if (existingIndexes.has(index.field_name)) {
        continue;
      }

      await this.client.createPayloadIndex(this.options.collectionName, {
        wait: true,
        timeout: this.timeoutSeconds,
        field_name: index.field_name,
        field_schema: index.field_schema,
      });
    }
  }
}

function toQdrantPoint(chunk: StoredQdrantChunk): QdrantPoint {
  return {
    id: toQdrantPointId(chunk.id),
    vector: chunk.vector,
    payload: buildPayload(chunk),
  };
}

function toQdrantPointId(chunkId: string): string {
  const digest = createHash("sha256").update(chunkId).digest();

  // Shape the first 16 bytes into an RFC 4122 version 5 UUID so Qdrant
  // accepts our stable point IDs while we keep the real chunk ID in payload.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;

  const hex = digest.subarray(0, 16).toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function buildPayload(chunk: StoredQdrantChunk): QdrantPayload {
  const payload: QdrantPayload = {
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    sourceKind: chunk.sourceKind,
    text: chunk.text,
    indexedAt: chunk.indexedAt,
    corpusKind: chunk.metadata.corpusKind ?? inferCorpusKind(chunk.sourceKind),
    metadata: {
      ...chunk.metadata,
      sourceId: chunk.metadata.sourceId ?? chunk.sourceId,
    },
  };

  copyOptionalMetadataField(payload, chunk.metadata, "guildId");
  copyOptionalMetadataField(payload, chunk.metadata, "channelId");
  copyOptionalMetadataField(payload, chunk.metadata, "authorId");
  copyOptionalMetadataField(payload, chunk.metadata, "threadId");
  copyOptionalMetadataField(payload, chunk.metadata, "repoName");
  copyOptionalMetadataField(payload, chunk.metadata, "language");
  copyOptionalMetadataField(payload, chunk.metadata, "path");

  const path = typeof chunk.metadata.path === "string" ? chunk.metadata.path : undefined;

  if (path) {
    payload.pathPrefixes = buildPathPrefixes(path);
  }

  return payload;
}

function copyOptionalMetadataField(
  payload: QdrantPayload,
  metadata: Record<string, string>,
  key: string,
): void {
  const value = metadata[key];

  if (typeof value === "string" && value.length > 0) {
    payload[key] = value;
  }
}

function buildPathPrefixes(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");

  if (normalized.length === 0) {
    return [];
  }

  const prefixes = new Set<string>();
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  for (let index = 0; index < segments.length; index += 1) {
    const prefix = segments.slice(0, index + 1).join("/");
    prefixes.add(prefix);

    if (index < segments.length - 1) {
      prefixes.add(`${prefix}/`);
    }
  }

  return [...prefixes];
}

function inferCorpusKind(
  sourceKind: StoredQdrantChunk["sourceKind"],
): "discord_history" | "repository_source" | "persona_memory" {
  if (sourceKind === "source_document") {
    return "repository_source";
  }
  if (sourceKind === "persona_memory") {
    return "persona_memory";
  }
  return "discord_history";
}

function fromQdrantPoint(point: QdrantScoredPoint): RetrievalResult | undefined {
  const payload = toPayloadRecord(point.payload);
  const chunkId = readString(payload.chunkId);
  const sourceId = readString(payload.sourceId);
  const sourceKind = readSourceKind(payload.sourceKind);
  const text = readString(payload.text);

  if (!chunkId || !sourceId || !sourceKind || !text) {
    return undefined;
  }

  return {
    chunkId,
    score: point.score,
    text,
    sourceId,
    sourceKind,
    metadata: extractMetadata(payload),
  };
}

function extractMetadata(payload: Record<string, unknown>): Record<string, string> {
  const metadata = toPayloadRecord(payload.metadata);

  if (metadata) {
    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === "string") {
        normalized[key] = value;
      }
    }

    return normalized;
  }

  const normalized: Record<string, string> = {};

  for (const key of ["corpusKind", "guildId", "channelId", "authorId", "threadId", "repoName", "language", "path", "sourceId"]) {
    const value = readString(payload[key]);

    if (value) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function toPayloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSourceKind(value: unknown): "discord_message" | "source_document" | "persona_memory" | undefined {
  return value === "discord_message" || value === "source_document" || value === "persona_memory"
    ? value
    : undefined;
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

function validateCollectionCompatibility(
  collection: Schemas["CollectionInfo"],
  expected: {
    collectionName: string;
    corpusKind: "discord_history" | "repository_source" | "persona_memory";
    embedderId: string;
    vectorLength: number;
  },
): void {
  const actualVectorLength = readCollectionVectorLength(collection.config.params.vectors);

  if (actualVectorLength !== undefined && actualVectorLength !== expected.vectorLength) {
    throw new Error(
      `Qdrant collection ${expected.collectionName} stores ${actualVectorLength}-dimensional vectors, but Void expects ${expected.vectorLength}. Run a rebuild or migrate into a clean collection.`,
    );
  }

  const metadata = toPayloadRecord(collection.config.metadata);
  const collectionCorpusKind = readString(metadata.corpusKind);
  const collectionEmbedderId = readString(metadata.embedderId);

  if (collectionCorpusKind && collectionCorpusKind !== expected.corpusKind) {
    throw new Error(
      `Qdrant collection ${expected.collectionName} is tagged for corpus ${collectionCorpusKind}, not ${expected.corpusKind}.`,
    );
  }

  if (collectionEmbedderId && collectionEmbedderId !== expected.embedderId) {
    throw new Error(
      `Qdrant collection ${expected.collectionName} was built with embedder ${collectionEmbedderId}, but Void is configured for ${expected.embedderId}. Run a rebuild or migrate into a clean collection.`,
    );
  }
}

function readCollectionVectorLength(
  vectors: Schemas["VectorsConfig"] | undefined,
): number | undefined {
  if (!vectors) {
    return undefined;
  }

  if ("size" in vectors && typeof vectors.size === "number") {
    return vectors.size;
  }

  for (const value of Object.values(vectors)) {
    if (value && typeof value === "object" && "size" in value && typeof value.size === "number") {
      return value.size;
    }
  }

  return undefined;
}

function buildPayloadIndexDefinitions(
  corpusKind: "discord_history" | "repository_source" | "persona_memory",
): Array<{
  field_name: string;
  field_schema:
    | "keyword"
    | {
        type: "text";
        tokenizer?: "word" | "whitespace" | "prefix" | "multilingual";
      };
}> {
  const shared = [
    { field_name: "sourceId", field_schema: "keyword" as const },
    { field_name: "corpusKind", field_schema: "keyword" as const },
  ];

  if (corpusKind === "discord_history") {
    return [
      ...shared,
      { field_name: "guildId", field_schema: "keyword" as const },
      { field_name: "channelId", field_schema: "keyword" as const },
      { field_name: "authorId", field_schema: "keyword" as const },
      { field_name: "threadId", field_schema: "keyword" as const },
    ];
  }

  if (corpusKind === "persona_memory") {
    return [
      ...shared,
      { field_name: "personaId", field_schema: "keyword" as const },
      { field_name: "memoryId", field_schema: "keyword" as const },
      { field_name: "memoryKind", field_schema: "keyword" as const },
      { field_name: "targetKind", field_schema: "keyword" as const },
      { field_name: "targetId", field_schema: "keyword" as const },
      { field_name: "repoName", field_schema: "keyword" as const },
      { field_name: "contentHash", field_schema: "keyword" as const },
    ];
  }

  return [
    ...shared,
    { field_name: "repoName", field_schema: "keyword" as const },
    { field_name: "language", field_schema: "keyword" as const },
    { field_name: "pathPrefixes", field_schema: "keyword" as const },
  ];
}

function toQdrantFilter(filters?: RetrievalFilters): QdrantFilter | undefined {
  if (!filters) {
    return undefined;
  }

  const must: Schemas["Condition"][] = [];

  appendExactMatch(must, "corpusKind", filters.corpusKind);
  appendExactMatch(must, "guildId", filters.guildId);
  appendExactMatch(must, "channelId", filters.channelId);
  appendExactMatch(must, "authorId", filters.authorId);
  appendExactMatch(must, "repoName", filters.repoName);
  appendExactMatch(must, "language", filters.language);
  appendExactMatch(must, "sourceId", filters.sourceId);

  if (filters.pathPrefix) {
    appendExactMatch(must, "pathPrefixes", normalizePathPrefixFilter(filters.pathPrefix));
  }

  return must.length > 0 ? { must } : undefined;
}

function buildMatchAnyFilter(field: string, values: string[]): QdrantFilter | undefined {
  const normalizedValues = values.filter((value) => value.length > 0);

  if (normalizedValues.length === 0) {
    return undefined;
  }

  return {
    must: [
      {
        key: field,
        match: {
          any: normalizedValues,
        },
      },
    ],
  };
}

function appendExactMatch(
  must: Schemas["Condition"][],
  key: string,
  value: string | undefined,
): void {
  if (!value || value.length === 0) {
    return;
  }

  must.push({
    key,
    match: {
      value,
    },
  });
}

function normalizePathPrefixFilter(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
