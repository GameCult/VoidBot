import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { type AppConfig, loadConfig } from "@voidbot/config";
import {
  FileMessageArchiveRepository,
  FileSourceDocumentArchiveRepository,
  RetrievalService,
  SourceDocumentIngester,
  createTextEmbedder,
  createVectorStores,
} from "@voidbot/rag";

export interface VoidbotMcpContext {
  config: AppConfig;
  archiveRepository: FileMessageArchiveRepository;
  sourceArchiveRepository: FileSourceDocumentArchiveRepository;
  retrievalService: RetrievalService;
  sourceDocumentIngester: SourceDocumentIngester;
}

export function createVoidbotMcpContext(): VoidbotMcpContext {
  const workspaceRoot = resolve(process.env.VOIDBOT_WORKSPACE_ROOT ?? process.cwd());
  loadDotenv({ path: resolve(workspaceRoot, ".env") });
  process.chdir(workspaceRoot);

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
  const sourceQueryEmbedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragSourceQueryInstruction,
  });
  const vectorStores = createVectorStores({
    kind: config.vectorStore.kind,
    historyPath: config.vectorStore.path,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: sourceQueryEmbedder,
  });
  const retrievalService = new RetrievalService(
    vectorStores.history,
    vectorStores.source,
  );
  const sourceDocumentIngester = new SourceDocumentIngester();

  return {
    config,
    archiveRepository,
    sourceArchiveRepository,
    retrievalService,
    sourceDocumentIngester,
  };
}
