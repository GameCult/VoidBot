import "dotenv/config";

import { resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  applyArchivedMessageKind,
  isArchivedBotPrompt,
  createTextEmbedder,
  createVectorStores,
  FileImportStateRepository,
  FileMessageArchiveRepository,
  HistoryIngester,
  RagPipeline,
  importDiscordLogs,
} from "@voidbot/rag";

interface CliOptions {
  inputPath?: string;
  recursive: boolean;
  respectIndexingRules: boolean;
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__rag_backfill__";
  }

  const config = loadConfig();
  const options = parseArgs(process.argv.slice(2));
  const inputPath = options.inputPath ?? config.discordLogRoot;

  if (!inputPath) {
    throw new Error(
      "Provide --input <path> or set DISCORD_LOG_ROOT before running the log backfill.",
    );
  }

  const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
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
    personaMemoryPath: config.vectorStore.personaMemoryPath,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: embedder,
    personaMemoryEmbedder: embedder,
  }).history;
  const historyIngester = new HistoryIngester();
  const ragPipeline = new RagPipeline(archiveRepository, historyIngester, vectorStore);
  const importStateRepository = new FileImportStateRepository(config.ragImportStatePath);
  const previousState = await importStateRepository.read();
  const importResult = await importDiscordLogs(resolve(inputPath), {
    recursive: options.recursive,
    channelIndexing: options.respectIndexingRules ? config.channelIndexing : undefined,
    previousState,
  });
  const normalizedMessages = importResult.messages.map((message) =>
    applyArchivedMessageKind(message, {
      botUserId: config.applicationId,
      botRoleIds: config.botTriggerRoleIds,
    }),
  );
  const ingestResult = await ragPipeline.upsertMessages(normalizedMessages);

  await importStateRepository.write(importResult.nextState);

  console.log(`Input: ${resolve(inputPath)}`);
  console.log(`Files scanned: ${importResult.filesScanned}`);
  console.log(`Files imported: ${importResult.filesImported}`);
  console.log(`Files skipped (unchanged): ${importResult.filesSkipped}`);
  console.log(`Messages discovered: ${importResult.messages.length}`);
  console.log(
    `Bot-directed prompts archived but skipped for semantic history: ${
      normalizedMessages.filter((message) => isArchivedBotPrompt(message)).length
    }`,
  );
  console.log(`Invalid records: ${importResult.invalidRecords}`);
  console.log(
    `Archive changes: created=${ingestResult.createdMessages}, updated=${ingestResult.updatedMessages}, unchanged=${ingestResult.unchangedMessages}`,
  );
  console.log(`Indexed chunks: ${ingestResult.indexedChunks}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    recursive: true,
    respectIndexingRules: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--input") {
      options.inputPath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--no-recursive") {
      options.recursive = false;
      continue;
    }

    if (argument === "--all-channels") {
      options.respectIndexingRules = false;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
