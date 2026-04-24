import "dotenv/config";

import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  createTextEmbedder,
  QdrantVectorStore,
  type StoredQdrantChunk,
} from "@voidbot/rag";

interface CliOptions {
  wipe: boolean;
}

interface StoredVectorIndex {
  chunks?: StoredQdrantChunk[];
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__qdrant_migration__";
  }

  const config = loadConfig();
  const options = parseArgs(process.argv.slice(2));
  const historyEmbedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragQueryInstruction,
  });
  const sourceEmbedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragSourceQueryInstruction,
  });
  const historyStore = new QdrantVectorStore({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey,
    timeoutMs: config.qdrant.timeoutMs,
    collectionName: config.qdrant.historyCollection,
    corpusKind: "discord_history",
    embedder: historyEmbedder,
  });
  const sourceStore = new QdrantVectorStore({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey,
    timeoutMs: config.qdrant.timeoutMs,
    collectionName: config.qdrant.sourceCollection,
    corpusKind: "repository_source",
    embedder: sourceEmbedder,
  });

  if (options.wipe) {
    await historyStore.clear();
    await sourceStore.clear();
  }

  const localVectors = await loadLocalVectors(config.storageRoot, {
    historyPath: config.vectorStore.path,
    sourceRoot: config.sourceVectorStoreRoot,
  });

  await historyStore.upsertStoredChunks(localVectors.historyChunks);
  await sourceStore.upsertStoredChunks(localVectors.sourceChunks);

  console.log(`Qdrant URL: ${config.qdrant.url}`);
  console.log(`History collection: ${config.qdrant.historyCollection}`);
  console.log(`Source collection: ${config.qdrant.sourceCollection}`);
  console.log(`History chunks migrated: ${localVectors.historyChunks.length}`);
  console.log(`Source chunks migrated: ${localVectors.sourceChunks.length}`);
  console.log(`Source shards discovered locally: ${localVectors.sourceShardFiles}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    wipe: false,
  };

  for (const argument of args) {
    if (argument === "--wipe") {
      options.wipe = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

async function loadLocalVectors(
  storageRoot: string,
  options: {
    historyPath: string;
    sourceRoot: string;
  },
): Promise<{
  historyChunks: StoredQdrantChunk[];
  sourceChunks: StoredQdrantChunk[];
  sourceShardFiles: number;
}> {
  const historyChunks = await loadChunksFromPath(options.historyPath);
  const sourceFiles = await listJsonFiles(options.sourceRoot);
  const sourceChunks: StoredQdrantChunk[] = [];

  for (const filePath of sourceFiles) {
    sourceChunks.push(...(await loadChunksFromPath(filePath)));
  }

  if (historyChunks.length > 0 || sourceChunks.length > 0) {
    return {
      historyChunks,
      sourceChunks,
      sourceShardFiles: sourceFiles.length,
    };
  }

  const legacyPath = join(storageRoot, "vector-store.json");
  const legacyChunks = await loadChunksFromPath(legacyPath);

  return {
    historyChunks: legacyChunks.filter((chunk) => chunk.metadata.corpusKind !== "repository_source"),
    sourceChunks: legacyChunks.filter((chunk) => chunk.metadata.corpusKind === "repository_source"),
    sourceShardFiles: 0,
  };
}

async function loadChunksFromPath(filePath: string): Promise<StoredQdrantChunk[]> {
  if (!(await pathExists(filePath))) {
    return [];
  }

  const raw = await readFile(filePath, "utf8");
  const store = JSON.parse(raw) as StoredVectorIndex;
  return (store.chunks ?? []).filter(isStoredChunk);
}

async function listJsonFiles(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isStoredChunk(value: unknown): value is StoredQdrantChunk {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const chunk = value as Partial<StoredQdrantChunk>;

  return (
    typeof chunk.id === "string" &&
    typeof chunk.sourceId === "string" &&
    (chunk.sourceKind === "discord_message" || chunk.sourceKind === "source_document") &&
    typeof chunk.text === "string" &&
    Array.isArray(chunk.vector) &&
    typeof chunk.indexedAt === "string" &&
    typeof chunk.metadata === "object" &&
    chunk.metadata !== null
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
