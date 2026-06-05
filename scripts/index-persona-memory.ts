import "dotenv/config";

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  loadVoidSelfStateTypedDocuments,
  writeVoidSelfStateTypedDocuments,
  type VoidSelfStateTypedProjection,
} from "@voidbot/core";
import { loadConfig } from "@voidbot/config";
import { createTextEmbedder, createVectorStores } from "@voidbot/rag";
import type { EmbeddingChunk } from "@voidbot/shared";

const CHUNK_TARGET_CHARS = 2600;
const CHUNK_OVERLAP_CHARS = 240;

interface CliOptions {
  canonicalPath: string;
  personaId: string;
  publicName: string;
  query?: string;
  limit: number;
}

interface PersonaMemoryChunkPlan {
  memoryId: string;
  contentHash: string;
  chunks: EmbeddingChunk[];
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__persona_memory_index__";
  }

  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const embedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: "Given a Persona memory question, retrieve the relevant typed Persona memories.",
  });
  const vectorStores = createVectorStores({
    kind: config.vectorStore.kind,
    historyPath: config.vectorStore.path,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: embedder,
    personaEmbedder: embedder,
  });
  const state = await loadVoidSelfStateTypedDocuments({
    canonicalPath: options.canonicalPath,
    identity: {
      agentId: options.personaId,
      publicName: options.publicName,
    },
  });

  const plans = buildPersonaMemoryChunkPlans(state, options.personaId, options.publicName);
  const chunks = plans.flatMap((plan) => plan.chunks);

  await vectorStores.persona.upsert(chunks);
  updateSemanticIndexMetadata(state, plans, {
    vectorStore: config.vectorStore.kind,
    collectionName:
      config.vectorStore.kind === "qdrant"
        ? config.qdrant.personaCollection
        : config.vectorStore.path.replace(/\.json$/i, "-persona-memory.json"),
    embedderId: embedder.id,
  });
  await writeVoidSelfStateTypedDocuments({
    canonicalPath: options.canonicalPath,
    identity: {
      agentId: options.personaId,
      publicName: options.publicName,
    },
  }, state);

  console.log(`Persona memory indexed: ${plans.length} memories, ${chunks.length} chunks`);
  console.log(`Vector store: ${config.vectorStore.kind}`);
  console.log(`Collection/path: ${config.vectorStore.kind === "qdrant" ? config.qdrant.personaCollection : config.vectorStore.path.replace(/\.json$/i, "-persona-memory.json")}`);
  console.log(`Embedder: ${embedder.id}`);

  if (options.query) {
    const results = await vectorStores.persona.query(options.query, options.limit, {
      corpusKind: "persona_memory",
      repoName: options.personaId,
    });
    console.log(JSON.stringify({
      query: options.query,
      results: results.map((result) => ({
        score: result.score,
        memoryId: result.metadata.memoryId,
        chunkId: result.chunkId,
        target: result.metadata.targetLabel,
        text: result.text.slice(0, 500),
      })),
    }, null, 2));
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    canonicalPath: "state/personas/metacrat.cc",
    personaId: "metacrat",
    publicName: "Metacrat",
    limit: 5,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--state" && next) {
      options.canonicalPath = next;
      index += 1;
    } else if (arg === "--persona-id" && next) {
      options.personaId = next;
      index += 1;
    } else if (arg === "--public-name" && next) {
      options.publicName = next;
      index += 1;
    } else if (arg === "--query" && next) {
      options.query = next;
      index += 1;
    } else if (arg === "--limit" && next) {
      options.limit = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--help") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  options.canonicalPath = resolve(options.canonicalPath);
  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error("--limit must be a positive integer.");
  }

  return options;
}

function printHelpAndExit(): never {
  console.log([
    "Usage: npm run persona:memory-index -- [options]",
    "",
    "Options:",
    "  --state <path>         Persona .cc path. Defaults to state/personas/metacrat.cc",
    "  --persona-id <id>      Persona id stored in vector metadata. Defaults to metacrat",
    "  --public-name <name>   Persona public name. Defaults to Metacrat",
    "  --query <text>         Optional smoke query after indexing.",
    "  --limit <n>            Query result limit. Defaults to 5",
  ].join("\n"));
  process.exit(0);
}

function buildPersonaMemoryChunkPlans(
  state: VoidSelfStateTypedProjection,
  personaId: string,
  publicName: string,
): PersonaMemoryChunkPlan[] {
  return state.thoughtMemory.memories
    .filter((memory) => !memory.retiredAt)
    .map((memory) => {
      const text = renderMemoryForEmbedding(memory);
      const contentHash = hashText(text);
      const parts = splitText(text);
      const chunks = parts.map((part, index): EmbeddingChunk => ({
        id: `${personaId}:${memory.memoryId}:chunk-${index}`,
        sourceId: `${personaId}:${memory.memoryId}`,
        sourceKind: "persona_memory",
        text: part,
        normalizedText: normalizeWhitespace(part),
        metadata: {
          corpusKind: "persona_memory",
          sourceId: `${personaId}:${memory.memoryId}`,
          personaId,
          publicName,
          memoryId: memory.memoryId,
          memoryKind: memory.kind,
          targetKind: memory.target.kind,
          targetId: memory.target.id,
          targetLabel: memory.target.label ?? memory.target.id,
          repoName: personaId,
          contentHash,
          chunkIndex: String(index),
          chunkCount: String(parts.length),
          tags: memory.tags.join(","),
        },
      }));
      return {
        memoryId: memory.memoryId,
        contentHash,
        chunks,
      };
    });
}

function updateSemanticIndexMetadata(
  state: VoidSelfStateTypedProjection,
  plans: PersonaMemoryChunkPlan[],
  index: {
    vectorStore: "qdrant" | "local_json";
    collectionName: string;
    embedderId: string;
  },
): void {
  const indexedAt = new Date().toISOString();
  const planByMemoryId = new Map(plans.map((plan) => [plan.memoryId, plan]));

  for (const memory of state.thoughtMemory.memories) {
    const plan = planByMemoryId.get(memory.memoryId);
    if (!plan) {
      if (memory.semanticIndex) {
        memory.semanticIndex = {
          ...memory.semanticIndex,
          stale: true,
        };
      }
      continue;
    }

    memory.semanticIndex = {
      corpusKind: "persona_memory",
      vectorStore: index.vectorStore,
      collectionName: index.collectionName,
      embedderId: index.embedderId,
      contentHash: plan.contentHash,
      chunkIds: plan.chunks.map((chunk) => chunk.id),
      indexedAt,
      stale: false,
    };
    memory.updatedAt = indexedAt;
  }

  state.thoughtMemory.updatedAt = indexedAt;
}

function renderMemoryForEmbedding(
  memory: VoidSelfStateTypedProjection["thoughtMemory"]["memories"][number],
): string {
  return [
    `Memory: ${memory.memoryId}`,
    `Kind: ${memory.kind}`,
    `Target: ${memory.target.label ?? memory.target.id} (${memory.target.kind}:${memory.target.id})`,
    `Summary: ${memory.summary}`,
    memory.claim ? `Claim: ${memory.claim}` : undefined,
    memory.question ? `Question: ${memory.question}` : undefined,
    memory.tension ? `Tension: ${memory.tension}` : undefined,
    memory.actionImplication ? `Action: ${memory.actionImplication}` : undefined,
    memory.tags.length > 0 ? `Tags: ${memory.tags.join(", ")}` : undefined,
    memory.anchorRefs.length > 0
      ? `Anchors: ${memory.anchorRefs.map((anchor) => anchor.ref).join(", ")}`
      : undefined,
  ].filter(Boolean).join("\n");
}

function splitText(text: string): string[] {
  if (text.length <= CHUNK_TARGET_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_TARGET_CHARS);
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf("\n", end);
      if (paragraphBreak > start + CHUNK_TARGET_CHARS * 0.5) {
        end = paragraphBreak;
      }
    }
    chunks.push(text.slice(start, end).trim());
    start = Math.max(end - CHUNK_OVERLAP_CHARS, end);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(normalizeWhitespace(text)).digest("hex")}`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
