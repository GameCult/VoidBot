import { createTextEmbedder } from "./embedder-factory";
import { FileSourceDocumentArchiveRepository } from "./source-document-archive";
import { SourceDocumentIngester } from "./source-document-ingester";
import { SourceRagPipeline } from "./source-rag-pipeline";
import { crawlRepositoryDocuments } from "./source-repo-crawler";
import { type SourceRepoMatch } from "./source-repo-discovery";
import { createVectorStores } from "./vector-store-factory";

export interface SourceRepoIndexConfig {
  ragSourceArchivePath: string;
  ragEmbeddingBackend: "hash" | "ollama";
  ragEmbeddingDimensions: number;
  ragOllamaBaseUrl: string;
  ragOllamaModel: string;
  ragOllamaTimeoutMs: number;
  ragQueryInstruction: string;
  sourceRepoIncludePrefixes: Record<string, string[]>;
  vectorStore: {
    kind: "local_json" | "qdrant";
    path: string;
    personaMemoryPath: string;
  };
  sourceVectorStoreRoot: string;
  qdrant: {
    url: string;
    apiKey?: string;
    timeoutMs: number;
    historyCollection: string;
    sourceCollection: string;
    personaMemoryCollection: string;
  };
}

export interface IndexedRepoResult {
  repoName: string;
  documents: number;
  createdDocuments: number;
  updatedDocuments: number;
  unchangedDocuments: number;
  deletedDocuments: number;
  indexedChunks: number;
  skippedFiles: number;
}

export interface SourceIndexRunSummary {
  indexedRepositories: number;
  totalDocuments: number;
  totalChunks: number;
  results: IndexedRepoResult[];
}

export function createSourceVectorStore(config: SourceRepoIndexConfig) {
  const embedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragQueryInstruction,
  });

  return createVectorStores({
    kind: config.vectorStore.kind,
    historyPath: config.vectorStore.path,
    personaMemoryPath: config.vectorStore.personaMemoryPath,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: embedder,
    personaMemoryEmbedder: embedder,
  }).source;
}

export async function indexSourceRepos(
  config: SourceRepoIndexConfig,
  repos: SourceRepoMatch[],
  options: {
    forceReindex?: boolean;
    logger?: (line: string) => void;
  } = {},
): Promise<SourceIndexRunSummary> {
  const vectorStore = createSourceVectorStore(config);
  const archiveRepository = new FileSourceDocumentArchiveRepository(config.ragSourceArchivePath);
  const sourceIngester = new SourceDocumentIngester();
  const pipeline = new SourceRagPipeline(archiveRepository, sourceIngester, vectorStore);
  const results: IndexedRepoResult[] = [];
  let indexedRepositories = 0;
  let totalDocuments = 0;
  let totalChunks = 0;

  for (const repo of repos) {
    const scan = await crawlRepositoryDocuments(repo.repoPath, repo.repoName, {
      includePathPrefixes: config.sourceRepoIncludePrefixes[repo.repoName]
        ?? config.sourceRepoIncludePrefixes[repo.localRepoName],
    });
    const result = await pipeline.syncRepoDocuments(repo.repoName, scan.documents, {
      forceReindex: options.forceReindex,
      onEmbeddingProgress: (completedChunks, totalChunks) => options.logger?.(
        `Repo ${repo.repoName}: embedded_chunks=${completedChunks}/${totalChunks}`,
      ),
    });
    const repoResult: IndexedRepoResult = {
      repoName: repo.repoName,
      documents: scan.documents.length,
      createdDocuments: result.createdDocuments,
      updatedDocuments: result.updatedDocuments,
      unchangedDocuments: result.unchangedDocuments,
      deletedDocuments: result.deletedDocuments,
      indexedChunks: result.indexedChunks,
      skippedFiles: scan.skippedFiles.length,
    };

    results.push(repoResult);
    indexedRepositories += 1;
    totalDocuments += scan.documents.length;
    totalChunks += result.indexedChunks;

    options.logger?.(
      [
        `Repo ${repo.repoName}:`,
        `documents=${repoResult.documents}`,
        `created=${repoResult.createdDocuments}`,
        `updated=${repoResult.updatedDocuments}`,
        `unchanged=${repoResult.unchangedDocuments}`,
        `deleted=${repoResult.deletedDocuments}`,
        `indexedChunks=${repoResult.indexedChunks}`,
        `skippedFiles=${repoResult.skippedFiles}`,
      ].join(" "),
    );
  }

  return {
    indexedRepositories,
    totalDocuments,
    totalChunks,
    results,
  };
}
