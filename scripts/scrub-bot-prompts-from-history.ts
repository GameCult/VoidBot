import "dotenv/config";

import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { loadConfig } from "@voidbot/config";
import {
  applyArchivedMessageKind,
  isArchivedBotPrompt,
  setArchivedMessageKind,
  type InteractionMemoryProfile,
} from "@voidbot/shared";
import {
  createTextEmbedder,
  createVectorStores,
  FileMessageArchiveRepository,
  HistoryIngester,
  RagPipeline,
} from "@voidbot/rag";

interface CliOptions {
  dryRun: boolean;
  botUserId?: string;
  botRoleIds: string[];
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__rag_scrub__";
  }

  const config = loadConfig();
  const options = parseArgs(process.argv.slice(2));
  const botUserId = options.botUserId ?? config.applicationId;
  const botRoleIds = [...new Set([...config.botTriggerRoleIds, ...options.botRoleIds])];

  if (!botUserId && botRoleIds.length === 0) {
    throw new Error(
      "Provide --bot-user-id or configure DISCORD_APPLICATION_ID / DISCORD_BOT_TRIGGER_ROLE_IDS before scrubbing bot prompts.",
    );
  }

  const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
  const messages = await archiveRepository.listAllActive();
  const recordedPromptMessageIds = await collectRecordedPromptMessageIds(config);
  const alreadyTagged = messages.filter((message) => isArchivedBotPrompt(message)).length;
  const retaggedMessages = messages.map((message) => {
    if (recordedPromptMessageIds.has(message.id)) {
      return {
        ...message,
        metadata: setArchivedMessageKind(message.metadata, "bot_prompt"),
      };
    }

    return applyArchivedMessageKind(message, { botUserId, botRoleIds });
  });
  const newlyTaggedMessages = retaggedMessages.filter(
    (message, index) =>
      !isArchivedBotPrompt(messages[index]) && isArchivedBotPrompt(message),
  );

  console.log(`Active archived messages: ${messages.length}`);
  console.log(`Recorded direct-prompt message ids: ${recordedPromptMessageIds.size}`);
  console.log(`Already tagged bot prompts: ${alreadyTagged}`);
  console.log(`Newly detected bot prompts: ${newlyTaggedMessages.length}`);

  if (newlyTaggedMessages.length === 0) {
    return;
  }

  if (options.dryRun) {
    console.log("Dry run only. No archive rows or vectors were changed.");
    return;
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
  }).history;
  const ragPipeline = new RagPipeline(
    archiveRepository,
    new HistoryIngester(),
    vectorStore,
  );
  const result = await ragPipeline.upsertMessages(newlyTaggedMessages);

  console.log(
    `Archive changes: created=${result.createdMessages}, updated=${result.updatedMessages}, unchanged=${result.unchangedMessages}`,
  );
  console.log(
    `History chunks still indexed for those rows after scrub: ${result.indexedChunks}`,
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    botRoleIds: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (argument === "--bot-user-id") {
      options.botUserId = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--bot-role-id") {
      const roleId = args[index + 1];

      if (roleId) {
        options.botRoleIds.push(roleId);
      }

      index += 1;
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

async function collectRecordedPromptMessageIds(
  config: ReturnType<typeof loadConfig>,
): Promise<Set<string>> {
  if (config.stateStorageBackend === "postgres") {
    return collectRecordedPromptMessageIdsFromPostgres(config.databaseDsn);
  }

  return collectRecordedPromptMessageIdsFromFile(config.interactionMemoryFile);
}

async function collectRecordedPromptMessageIdsFromPostgres(
  databaseDsn: string,
): Promise<Set<string>> {
  const pool = new Pool({ connectionString: databaseDsn });

  try {
    const result = await pool.query<{ id: string }>(
      `select id
       from interaction_memory_events
       where source_kind = 'direct_prompt'`,
    );

    return new Set(
      result.rows
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
  } finally {
    await pool.end();
  }
}

async function collectRecordedPromptMessageIdsFromFile(
  interactionMemoryFile: string,
): Promise<Set<string>> {
  try {
    const raw = await readFile(interactionMemoryFile, "utf8");
    const parsed = JSON.parse(stripLeadingBom(raw)) as {
      profiles?: InteractionMemoryProfile[];
    };
    const ids = new Set<string>();

    for (const profile of parsed.profiles ?? []) {
      for (const event of profile.recentEvents ?? []) {
        if (event.sourceKind === "direct_prompt" && event.id.length > 0) {
          ids.add(event.id);
        }
      }
    }

    return ids;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return new Set();
    }

    throw error;
  }
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
