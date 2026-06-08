import "dotenv/config";

import { createTextEmbedder, createVectorStores, FileMessageArchiveRepository, HistoryIngester, RagPipeline } from "@voidbot/rag";
import { loadConfig } from "@voidbot/config";

interface CandidateMessage {
  id: string;
  channelId: string;
  timestamp: string;
  authorId?: string;
  authorName?: string;
  content: string;
  source: "live" | "archive";
}

interface CliOptions {
  execute: boolean;
  archiveOnly: boolean;
  discordOnly: boolean;
  channelId?: string;
  limit: number;
  hours?: number;
  after?: string;
  messageIds: string[];
  contains: string[];
  regexes: RegExp[];
  authorIds: string[];
  authorNames: string[];
  reason: string;
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__purge_discord_context__";
  }

  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const channelId = options.channelId ?? config.repoFaceHeartbeats.defaultChannelId;

  if (!channelId && options.messageIds.length === 0) {
    throw new Error("Provide --channel-id, configure REPO_FACE_HEARTBEAT_DEFAULT_CHANNEL_ID, or select explicit --message-id values.");
  }

  if (options.discordOnly && options.archiveOnly) {
    throw new Error("--discord-only and --archive-only cannot both be set.");
  }

  const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
  const liveMessages = options.archiveOnly || !channelId
    ? []
    : await fetchLiveDiscordMessages({
        token: requireBotToken(config.botToken),
        channelId,
        limit: options.limit,
      });
  const explicitLiveMessages = options.archiveOnly || !channelId || options.messageIds.length === 0
    ? []
    : await fetchExplicitLiveDiscordMessages({
        token: requireBotToken(config.botToken),
        channelId,
        messageIds: options.messageIds,
      });
  const archiveMessages = options.discordOnly
    ? []
    : await fetchArchivedMessages({
        archiveRepository,
        channelId,
        limit: Math.max(options.limit, options.messageIds.length),
      });
  const explicitArchiveMessages = options.discordOnly || options.messageIds.length === 0
    ? []
    : await fetchExplicitArchivedMessages({
        archiveRepository,
        messageIds: options.messageIds,
      });

  const candidates = selectCandidates([
    ...liveMessages,
    ...explicitLiveMessages,
    ...archiveMessages,
    ...explicitArchiveMessages,
  ], options);
  const uniqueCandidates = dedupeCandidates(candidates);

  printPlan(uniqueCandidates, options);

  if (uniqueCandidates.length === 0) {
    return;
  }

  if (!options.execute) {
    console.log("Dry run only. Re-run with --execute to delete live Discord messages and/or mark archive records deleted.");
    return;
  }

  const deletedDiscordIds = options.archiveOnly
    ? []
    : await deleteDiscordMessages({
        token: requireBotToken(config.botToken),
        candidates: uniqueCandidates,
        reason: options.reason,
      });

  const archiveDeletedIds = options.discordOnly
    ? []
    : await markArchiveMessagesDeleted({
        config,
        archiveRepository,
        messageIds: uniqueCandidates.map((candidate) => candidate.id),
      });

  console.log(`Deleted or already-missing Discord messages: ${deletedDiscordIds.length}`);
  console.log(`Marked archived messages deleted and removed vectors: ${archiveDeletedIds.length}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    archiveOnly: false,
    discordOnly: false,
    limit: 100,
    messageIds: [],
    contains: [],
    regexes: [],
    authorIds: [],
    authorNames: [],
    reason: "VoidBot operator context purge",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--execute":
        options.execute = true;
        break;
      case "--archive-only":
        options.archiveOnly = true;
        break;
      case "--discord-only":
        options.discordOnly = true;
        break;
      case "--channel-id":
        options.channelId = readValue(args, ++index, argument);
        break;
      case "--limit":
        options.limit = Number.parseInt(readValue(args, ++index, argument), 10);
        break;
      case "--hours":
        options.hours = Number.parseFloat(readValue(args, ++index, argument));
        break;
      case "--after":
        options.after = readValue(args, ++index, argument);
        break;
      case "--message-id":
        options.messageIds.push(readValue(args, ++index, argument));
        break;
      case "--contains":
        options.contains.push(readValue(args, ++index, argument).toLowerCase());
        break;
      case "--regex":
        options.regexes.push(new RegExp(readValue(args, ++index, argument), "i"));
        break;
      case "--author-id":
        options.authorIds.push(readValue(args, ++index, argument));
        break;
      case "--author-name":
        options.authorNames.push(readValue(args, ++index, argument).toLowerCase());
        break;
      case "--reason":
        options.reason = readValue(args, ++index, argument);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100. Discord's channel fetch endpoint caps this at 100.");
  }

  if (options.hours !== undefined && (!Number.isFinite(options.hours) || options.hours <= 0)) {
    throw new Error("--hours must be a positive number.");
  }

  if (options.after && Number.isNaN(Date.parse(options.after))) {
    throw new Error("--after must be a valid timestamp.");
  }

  if (
    options.messageIds.length === 0 &&
    options.contains.length === 0 &&
    options.regexes.length === 0 &&
    options.authorIds.length === 0 &&
    options.authorNames.length === 0
  ) {
    throw new Error("Refusing unfiltered purge. Provide --message-id, --contains, --regex, --author-id, or --author-name.");
  }

  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function fetchLiveDiscordMessages(input: {
  token: string;
  channelId: string;
  limit: number;
}): Promise<CandidateMessage[]> {
  const response = await fetch(`https://discord.com/api/v10/channels/${input.channelId}/messages?limit=${input.limit}`, {
    headers: {
      Authorization: `Bot ${input.token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Discord fetch failed ${response.status}: ${await response.text()}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Discord fetch returned a non-array payload.");
  }

  return payload.map((message) => ({
    id: readPayloadString(message, "id"),
    channelId: readPayloadString(message, "channel_id") || input.channelId,
    timestamp: readPayloadString(message, "timestamp"),
    authorId: readPayloadString(message?.author, "id"),
    authorName: readPayloadString(message?.author, "global_name") ||
      readPayloadString(message?.author, "username"),
    content: readPayloadString(message, "content"),
    source: "live",
  })).filter((message) => message.id && message.channelId);
}

async function fetchExplicitLiveDiscordMessages(input: {
  token: string;
  channelId: string;
  messageIds: string[];
}): Promise<CandidateMessage[]> {
  const messages: CandidateMessage[] = [];

  for (const messageId of input.messageIds) {
    const response = await fetch(`https://discord.com/api/v10/channels/${input.channelId}/messages/${messageId}`, {
      headers: {
        Authorization: `Bot ${input.token}`,
      },
    });

    if (response.status === 404) {
      messages.push({
        id: messageId,
        channelId: input.channelId,
        timestamp: "",
        content: "",
        source: "live",
      });
      continue;
    }

    if (!response.ok) {
      throw new Error(`Discord explicit fetch failed for ${messageId} with ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    messages.push({
      id: readPayloadString(payload, "id"),
      channelId: readPayloadString(payload, "channel_id") || input.channelId,
      timestamp: readPayloadString(payload, "timestamp"),
      authorId: readPayloadString(payload?.author, "id"),
      authorName: readPayloadString(payload?.author, "global_name") ||
        readPayloadString(payload?.author, "username"),
      content: readPayloadString(payload, "content"),
      source: "live",
    });
  }

  return messages;
}

async function fetchArchivedMessages(input: {
  archiveRepository: FileMessageArchiveRepository;
  channelId?: string;
  limit: number;
}): Promise<CandidateMessage[]> {
  const records = input.channelId
    ? await input.archiveRepository.listByChannel(input.channelId, input.limit)
    : await input.archiveRepository.listAllActive();

  return records.slice(-input.limit).map((message) => ({
    id: message.id,
    channelId: message.channelId,
    timestamp: message.timestamp,
    authorId: message.authorId,
    authorName: message.authorName,
    content: message.content,
    source: "archive",
  }));
}

async function fetchExplicitArchivedMessages(input: {
  archiveRepository: FileMessageArchiveRepository;
  messageIds: string[];
}): Promise<CandidateMessage[]> {
  const messages: CandidateMessage[] = [];

  for (const messageId of input.messageIds) {
    const message = await input.archiveRepository.get(messageId);
    if (!message || message.deletedAt) {
      continue;
    }
    messages.push({
      id: message.id,
      channelId: message.channelId,
      timestamp: message.timestamp,
      authorId: message.authorId,
      authorName: message.authorName,
      content: message.content,
      source: "archive",
    });
  }

  return messages;
}

function selectCandidates(messages: CandidateMessage[], options: CliOptions): CandidateMessage[] {
  const messageIdSet = new Set(options.messageIds);
  const authorIdSet = new Set(options.authorIds);
  const authorNameSet = new Set(options.authorNames.map(normalizeText));
  const afterMs = options.after ? Date.parse(options.after) : undefined;
  const lowerBoundMs = afterMs ?? (options.hours ? Date.now() - options.hours * 60 * 60 * 1000 : undefined);

  return messages.filter((message) => {
    if (lowerBoundMs !== undefined) {
      const timestampMs = Date.parse(message.timestamp);
      if (Number.isNaN(timestampMs) || timestampMs < lowerBoundMs) {
        return false;
      }
    }

    if (messageIdSet.has(message.id)) {
      return true;
    }

    const content = message.content.toLowerCase();
    const authorName = normalizeText(message.authorName ?? "");
    return (
      options.contains.some((needle) => content.includes(needle)) ||
      options.regexes.some((regex) => regex.test(message.content)) ||
      (message.authorId !== undefined && authorIdSet.has(message.authorId)) ||
      (authorName.length > 0 && authorNameSet.has(authorName))
    );
  });
}

function dedupeCandidates(candidates: CandidateMessage[]): CandidateMessage[] {
  const byId = new Map<string, CandidateMessage>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    if (!existing || shouldReplaceCandidate(existing, candidate)) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function shouldReplaceCandidate(existing: CandidateMessage, candidate: CandidateMessage): boolean {
  const existingHasBody = existing.timestamp.length > 0 || existing.content.trim().length > 0;
  const candidateHasBody = candidate.timestamp.length > 0 || candidate.content.trim().length > 0;
  if (!existingHasBody && candidateHasBody) {
    return true;
  }
  if (existing.source === "archive" && candidate.source === "live" && candidateHasBody) {
    return true;
  }
  return false;
}

function printPlan(candidates: CandidateMessage[], options: CliOptions): void {
  console.log(options.execute ? "EXECUTE purge plan" : "DRY RUN purge plan");
  console.log(`Matched messages: ${candidates.length}`);
  console.log(`Targets: ${options.archiveOnly ? "archive/vector only" : options.discordOnly ? "Discord only" : "Discord plus archive/vector"}`);
  console.log("");

  for (const candidate of candidates) {
    console.log([
      candidate.id,
      candidate.timestamp || "missing-live-message",
      `channel=${candidate.channelId}`,
      `source=${candidate.source}`,
      `${candidate.authorName ?? "unknown"} (${candidate.authorId ?? "unknown"})`,
      excerpt(candidate.content),
    ].join(" | "));
  }

  console.log("");
}

async function deleteDiscordMessages(input: {
  token: string;
  candidates: CandidateMessage[];
  reason: string;
}): Promise<string[]> {
  const deleted: string[] = [];

  for (const candidate of input.candidates) {
    const response = await fetch(`https://discord.com/api/v10/channels/${candidate.channelId}/messages/${candidate.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bot ${input.token}`,
        "X-Audit-Log-Reason": encodeURIComponent(input.reason),
      },
    });

    if (response.status === 204 || response.status === 404) {
      deleted.push(candidate.id);
      continue;
    }

    throw new Error(`Discord delete failed for ${candidate.id} with ${response.status}: ${await response.text()}`);
  }

  return deleted;
}

async function markArchiveMessagesDeleted(input: {
  config: ReturnType<typeof loadConfig>;
  archiveRepository: FileMessageArchiveRepository;
  messageIds: string[];
}): Promise<string[]> {
  const embedder = createTextEmbedder({
    backend: input.config.ragEmbeddingBackend,
    hashDimensions: input.config.ragEmbeddingDimensions,
    ollamaBaseUrl: input.config.ragOllamaBaseUrl,
    ollamaModel: input.config.ragOllamaModel,
    ollamaTimeoutMs: input.config.ragOllamaTimeoutMs,
    queryInstruction: input.config.ragQueryInstruction,
  });
  const vectorStore = createVectorStores({
    kind: input.config.vectorStore.kind,
    historyPath: input.config.vectorStore.path,
    personaMemoryPath: input.config.vectorStore.personaMemoryPath,
    sourceRoot: input.config.sourceVectorStoreRoot,
    qdrant: input.config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: embedder,
    personaMemoryEmbedder: embedder,
  }).history;
  const pipeline = new RagPipeline(input.archiveRepository, new HistoryIngester(), vectorStore);
  const deleted: string[] = [];

  for (const messageId of input.messageIds) {
    if (await pipeline.markDeleted(messageId)) {
      deleted.push(messageId);
    }
  }

  return deleted;
}

function requireBotToken(token: string | undefined): string {
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required for live Discord purge work.");
  }
  return token;
}

function readPayloadString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function excerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
