import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadConfig } from "@voidbot/config";

interface StoredVectorChunk {
  id: string;
  sourceId?: string;
  sourceMessageId?: string;
  sourceKind?: "discord_message" | "source_document";
  text: string;
  normalizedText: string;
  metadata: Record<string, string>;
  vector: number[];
  indexedAt: string;
}

interface VectorIndexStore {
  version: number;
  embedderId: string;
  dimensions: number;
  chunks: StoredVectorChunk[];
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__vector_migration__";
  }

  const config = loadConfig();
  const legacyPath = join(config.storageRoot, "vector-store.json");
  const raw = await readFile(legacyPath, "utf8");
  const legacyStore = JSON.parse(raw) as VectorIndexStore;
  const historyChunks: StoredVectorChunk[] = [];
  const sourceChunksByRepo = new Map<string, StoredVectorChunk[]>();

  for (const chunk of legacyStore.chunks ?? []) {
    const sourceId = chunk.sourceId ?? chunk.sourceMessageId;
    const sourceKind = chunk.sourceKind ?? (chunk.metadata?.corpusKind === "repository_source" ? "source_document" : "discord_message");
    const normalizedChunk: StoredVectorChunk = {
      ...chunk,
      sourceId,
      sourceKind,
      metadata: {
        ...chunk.metadata,
        sourceId: chunk.metadata?.sourceId ?? sourceId ?? "",
      },
    };

    if (normalizedChunk.metadata.corpusKind === "repository_source") {
      const repoName = normalizedChunk.metadata.repoName;

      if (!repoName) {
        continue;
      }

      const bucket = sourceChunksByRepo.get(repoName) ?? [];
      bucket.push(normalizedChunk);
      sourceChunksByRepo.set(repoName, bucket);
      continue;
    }

    historyChunks.push(normalizedChunk);
  }

  await mkdir(dirname(config.vectorStore.path), { recursive: true });
  await writeFile(
    config.vectorStore.path,
    `${JSON.stringify({
      version: 2,
      embedderId: legacyStore.embedderId,
      dimensions: legacyStore.dimensions,
      chunks: historyChunks,
    })}\n`,
    "utf8",
  );

  await mkdir(config.sourceVectorStoreRoot, { recursive: true });

  for (const [repoName, chunks] of sourceChunksByRepo) {
    const shardPath = join(config.sourceVectorStoreRoot, `${encodeURIComponent(repoName)}.json`);
    await writeFile(
      shardPath,
      `${JSON.stringify({
        version: 2,
        embedderId: legacyStore.embedderId,
        dimensions: legacyStore.dimensions,
        chunks,
      })}\n`,
      "utf8",
    );
  }

  console.log(`Legacy mixed store: ${legacyPath}`);
  console.log(`History chunks written: ${historyChunks.length}`);
  console.log(`Source repos written: ${sourceChunksByRepo.size}`);
  console.log(
    `Source chunks written: ${[...sourceChunksByRepo.values()].reduce((sum, chunks) => sum + chunks.length, 0)}`,
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
