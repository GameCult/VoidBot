import { type VectorStore } from "@voidbot/shared";

import { FileVectorStore } from "./file-vector-store";
import { type TextEmbedder } from "./hash-embedder";
import { QdrantVectorStore } from "./qdrant-vector-store";
import { ShardedSourceVectorStore } from "./source-vector-store";

export interface VectorStoreFactoryOptions {
  kind: "local_json" | "qdrant";
  historyPath: string;
  sourceRoot: string;
  qdrant: {
    url: string;
    apiKey?: string;
    timeoutMs: number;
    historyCollection: string;
    sourceCollection: string;
    personaCollection: string;
  };
  historyEmbedder: TextEmbedder;
  sourceEmbedder: TextEmbedder;
  personaEmbedder?: TextEmbedder;
}

export interface BuiltVectorStores {
  history: VectorStore;
  source: VectorStore;
  persona: VectorStore;
}

export function createVectorStores(options: VectorStoreFactoryOptions): BuiltVectorStores {
  if (options.kind === "qdrant") {
    return {
      history: new QdrantVectorStore({
        url: options.qdrant.url,
        apiKey: options.qdrant.apiKey,
        timeoutMs: options.qdrant.timeoutMs,
        collectionName: options.qdrant.historyCollection,
        corpusKind: "discord_history",
        embedder: options.historyEmbedder,
      }),
      source: new QdrantVectorStore({
        url: options.qdrant.url,
        apiKey: options.qdrant.apiKey,
        timeoutMs: options.qdrant.timeoutMs,
        collectionName: options.qdrant.sourceCollection,
        corpusKind: "repository_source",
        embedder: options.sourceEmbedder,
      }),
      persona: new QdrantVectorStore({
        url: options.qdrant.url,
        apiKey: options.qdrant.apiKey,
        timeoutMs: options.qdrant.timeoutMs,
        collectionName: options.qdrant.personaCollection,
        corpusKind: "persona_memory",
        embedder: options.personaEmbedder ?? options.historyEmbedder,
      }),
    };
  }

  return {
    history: new FileVectorStore(options.historyPath, options.historyEmbedder),
    source: new ShardedSourceVectorStore(options.sourceRoot, options.sourceEmbedder),
    persona: new FileVectorStore(options.historyPath.replace(/\.json$/i, "-persona-memory.json"), options.personaEmbedder ?? options.historyEmbedder),
  };
}
