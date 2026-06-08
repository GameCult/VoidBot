import "dotenv/config";

import { loadConfig } from "@voidbot/config";
import {
  createTextEmbedder,
  FileMessageArchiveRepository,
  FileSourceDocumentArchiveRepository,
  HistoryIngester,
  SourceDocumentIngester,
  createVectorStores,
} from "@voidbot/rag";

const REBUILD_CHUNK_BATCH_SIZE = 64;

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__rag_rebuild__";
  }

  const config = loadConfig();
  const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
  const sourceArchiveRepository = new FileSourceDocumentArchiveRepository(config.ragSourceArchivePath);
  const embedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragQueryInstruction,
  });
  const vectorStores = createVectorStores({
    kind: config.vectorStore.kind,
    historyPath: config.vectorStore.path,
    personaMemoryPath: config.vectorStore.personaMemoryPath,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: embedder,
    personaMemoryEmbedder: embedder,
  });
  const vectorStore = vectorStores.history;
  const sourceVectorStore = vectorStores.source;
  const personaMemoryVectorStore = vectorStores.personaMemory;
  const historyIngester = new HistoryIngester();
  const sourceIngester = new SourceDocumentIngester();
  const activeMessages = await archiveRepository.listAllActive();
  const historyChunks = historyIngester.chunkMessages(activeMessages);
  const sourceDocuments = await sourceArchiveRepository.listAll();
  const sourceChunks = sourceIngester.chunkDocuments(sourceDocuments);

  await vectorStore.clear();
  await sourceVectorStore.clear();
  await personaMemoryVectorStore.clear();

  for (let index = 0; index < historyChunks.length; index += REBUILD_CHUNK_BATCH_SIZE) {
    const batch = historyChunks.slice(index, index + REBUILD_CHUNK_BATCH_SIZE);

    if (batch.length === 0) {
      continue;
    }

    await vectorStore.upsert(batch);

    if ((index / REBUILD_CHUNK_BATCH_SIZE + 1) % 25 === 0 || index + batch.length >= historyChunks.length) {
      console.log(`History rebuild progress: ${Math.min(index + batch.length, historyChunks.length)}/${historyChunks.length} chunks`);
    }
  }

  for (let index = 0; index < sourceChunks.length; index += REBUILD_CHUNK_BATCH_SIZE) {
    const batch = sourceChunks.slice(index, index + REBUILD_CHUNK_BATCH_SIZE);

    if (batch.length === 0) {
      continue;
    }

    await sourceVectorStore.upsert(batch);

    if ((index / REBUILD_CHUNK_BATCH_SIZE + 1) % 25 === 0 || index + batch.length >= sourceChunks.length) {
      console.log(`Source rebuild progress: ${Math.min(index + batch.length, sourceChunks.length)}/${sourceChunks.length} chunks`);
    }
  }

  console.log(`Embedder: ${embedder.id}`);
  console.log(`Archived active messages: ${activeMessages.length}`);
  console.log(`Archived source documents: ${sourceDocuments.length}`);
  console.log(`History chunks rebuilt: ${historyChunks.length}`);
  console.log(`Source chunks rebuilt: ${sourceChunks.length}`);
  console.log(`Indexed chunks rebuilt: ${historyChunks.length + sourceChunks.length}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
