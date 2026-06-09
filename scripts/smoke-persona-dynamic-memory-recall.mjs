#!/usr/bin/env node
import "dotenv/config";

import { loadConfig } from "@voidbot/config";
import {
  createTextEmbedder,
  createVectorStores,
  RetrievalService,
} from "@voidbot/rag";

if (!process.env.DISCORD_OWNER_ID) {
  process.env.DISCORD_OWNER_ID = "__persona_dynamic_memory_smoke__";
}

const identityId = readArg("--identity") ?? "metame";
const query = readArg("--query")
  ?? "My week was about consent, body and home boundaries, Emily helping through dissociation, Wayne failing support, Lobo threatening retaliation, and evidence preservation.";

const config = loadConfig();
const embedder = createTextEmbedder({
  backend: config.ragEmbeddingBackend,
  hashDimensions: config.ragEmbeddingDimensions,
  ollamaBaseUrl: config.ragOllamaBaseUrl,
  ollamaModel: config.ragOllamaModel,
  ollamaTimeoutMs: config.ragOllamaTimeoutMs,
  queryInstruction: "Given a Face's current train of thought, retrieve relevant memories, bonds, needs, status reads, and doctrine from this Persona's own typed state.",
});
const stores = createVectorStores({
  kind: config.vectorStore.kind,
  historyPath: config.vectorStore.path,
  personaMemoryPath: config.vectorStore.personaMemoryPath,
  sourceRoot: config.sourceVectorStoreRoot,
  qdrant: config.qdrant,
  historyEmbedder: embedder,
  sourceEmbedder: embedder,
  personaMemoryEmbedder: embedder,
});
const retrieval = new RetrievalService(stores.history, stores.source, stores.personaMemory);
const results = await retrieval.searchPersonaMemory(query, 12, { identityId });

const combined = results.map((result) => result.text).join("\n");
const summary = {
  ok: results.length > 0,
  identityId,
  vectorStoreKind: config.vectorStore.kind,
  resultCount: results.length,
  hasEmily: /Emily/i.test(combined),
  hasWayne: /Wayne/i.test(combined),
  hasLobo: /Lobo/i.test(combined),
  hasConsent: /consent/i.test(combined),
};

console.log(JSON.stringify(summary, null, 2));
for (const [index, result] of results.entries()) {
  console.log(`--- ${index + 1} ${result.score.toFixed(3)} ${result.metadata.targetLabel ?? result.metadata.targetId}/${result.metadata.memoryKind}`);
  console.log(result.text.slice(0, 700));
}

if (!summary.ok || !summary.hasEmily || !summary.hasWayne || !summary.hasLobo || !summary.hasConsent) {
  process.exitCode = 1;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}
