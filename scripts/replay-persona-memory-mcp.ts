#!/usr/bin/env node
import "dotenv/config";

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "@voidbot/config";
import { createTextEmbedder, FileVectorStore, QdrantVectorStore } from "@voidbot/rag";
import type { RetrievalResult, VectorStore } from "@voidbot/shared";

const config = loadConfig();
const collectionName = readRequiredEnv("REPLAY_PERSONA_MEMORY_COLLECTION");
const vectorKind = (process.env.REPLAY_PERSONA_MEMORY_VECTOR_KIND ?? config.vectorStore.kind) as "qdrant" | "local_json";
const personaId = process.env.REPLAY_PERSONA_ID ?? "metacrat";
const logPath = process.env.REPLAY_PERSONA_MEMORY_TOOL_LOG;
const limitMax = Number.parseInt(process.env.REPLAY_PERSONA_MEMORY_LIMIT_MAX ?? "8", 10);

const embedder = createTextEmbedder({
  backend: config.ragEmbeddingBackend,
  hashDimensions: config.ragEmbeddingDimensions,
  ollamaBaseUrl: config.ragOllamaBaseUrl,
  ollamaModel: config.ragOllamaModel,
  ollamaTimeoutMs: config.ragOllamaTimeoutMs,
  queryInstruction: "Given a Persona replay situation, retrieve relevant frozen Persona memories.",
});

const vectorStore: VectorStore = vectorKind === "qdrant"
  ? new QdrantVectorStore({
    url: config.qdrant.url,
    apiKey: config.qdrant.apiKey,
    timeoutMs: config.qdrant.timeoutMs,
    collectionName,
    corpusKind: "persona_memory",
    embedder,
  })
  : new FileVectorStore(readRequiredEnv("REPLAY_PERSONA_MEMORY_VECTOR_PATH"), embedder);

const server = new McpServer(
  { name: "replay-persona-memory", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

server.registerTool(
  "search_persona_memory",
  {
    title: "Search Frozen Persona Memory",
    description:
      "Search the temporally frozen Persona memory index for this replay. Use this before predicting how Metacrat reacts.",
    inputSchema: {
      query: z.string().trim().min(1).max(1000),
      limit: z.number().int().min(1).max(Math.max(1, limitMax)).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input: { query: string; limit?: number }) => {
    const limit = Math.min(input.limit ?? 5, Math.max(1, limitMax));
    const results = await vectorStore.query(input.query, limit, {
      corpusKind: "persona_memory",
      repoName: personaId,
    });
    await appendToolLog(input.query, limit, results);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            query: input.query,
            vectorStore: vectorKind,
            collectionName,
            embedderId: embedder.id,
            results: results.map((result) => ({
              score: result.score,
              memoryId: result.metadata.memoryId,
              target: result.metadata.targetLabel,
              text: result.text,
            })),
          }, null, 2),
        },
      ],
    };
  },
);

async function appendToolLog(query: string, limit: number, results: RetrievalResult[]): Promise<void> {
  if (!logPath) {
    return;
  }

  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({
    at: new Date().toISOString(),
    query,
    limit,
    resultCount: results.length,
    results: results.map((result) => ({
      score: result.score,
      memoryId: result.metadata.memoryId,
      chunkId: result.chunkId,
    })),
  })}\n`, "utf8");
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

void server.connect(new StdioServerTransport());
