import "dotenv/config";

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  crawlRepositoryDocuments,
  createTextEmbedder,
  createVectorStores,
  FileSourceDocumentArchiveRepository,
  SourceDocumentIngester,
  SourceRagPipeline,
} from "@voidbot/rag";

interface ScriptOptions {
  repos?: string[];
  forceReindex?: boolean;
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__source_reindex__";
  }

  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (!config.sourceRepoRoot) {
    throw new Error("SOURCE_REPO_ROOT is not configured.");
  }

  const repoNames =
    options.repos && options.repos.length > 0
      ? options.repos
      : await resolveRepoNames(config.sourceRepoRoot, config.sourceRepoPatterns);

  if (repoNames.length === 0) {
    throw new Error("No source repositories matched SOURCE_REPO_PATTERNS.");
  }

  const embedder = createTextEmbedder({
    backend: config.ragEmbeddingBackend,
    hashDimensions: config.ragEmbeddingDimensions,
    ollamaBaseUrl: config.ragOllamaBaseUrl,
    ollamaModel: config.ragOllamaModel,
    ollamaTimeoutMs: config.ragOllamaTimeoutMs,
    queryInstruction: config.ragQueryInstruction,
  });
  const vectorStore = createVectorStores({
    kind: config.vectorStore.kind,
    historyPath: config.vectorStore.path,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: embedder,
  }).source;
  const archiveRepository = new FileSourceDocumentArchiveRepository(config.ragSourceArchivePath);
  const sourceIngester = new SourceDocumentIngester();
  const pipeline = new SourceRagPipeline(archiveRepository, sourceIngester, vectorStore);

  let indexedRepositories = 0;
  let totalDocuments = 0;
  let totalChunks = 0;

  for (const repoName of repoNames) {
    const repoPath = join(config.sourceRepoRoot, repoName);
    const scan = await crawlRepositoryDocuments(repoPath, repoName, {
      includePathPrefixes: config.sourceRepoIncludePrefixes[repoName],
    });
    const result = await pipeline.syncRepoDocuments(repoName, scan.documents, {
      forceReindex: options.forceReindex,
    });
    indexedRepositories += 1;
    totalDocuments += scan.documents.length;
    totalChunks += result.indexedChunks;

    console.log(
      [
        `Repo ${repoName}:`,
        `documents=${scan.documents.length}`,
        `created=${result.createdDocuments}`,
        `updated=${result.updatedDocuments}`,
        `unchanged=${result.unchangedDocuments}`,
        `deleted=${result.deletedDocuments}`,
        `indexedChunks=${result.indexedChunks}`,
        `skippedFiles=${scan.skippedFiles.length}`,
      ].join(" "),
    );
  }

  console.log(`Indexed repositories: ${indexedRepositories}`);
  console.log(`Indexed documents: ${totalDocuments}`);
  console.log(`Indexed chunks: ${totalChunks}`);
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if ((argument === "--repo" || argument === "--repos") && argv[index + 1]) {
      options.repos = argv[index + 1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      index += 1;
      continue;
    }

    if (argument === "--force") {
      options.forceReindex = true;
    }
  }

  return options;
}

async function resolveRepoNames(root: string, patterns: string[]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const repoNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => patterns.length === 0 || patterns.some((pattern) => matchesPattern(name, pattern)))
    .sort((left, right) => left.localeCompare(right));

  return repoNames;
}

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(value);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
