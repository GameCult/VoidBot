import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  type AuditLog,
  buildVoidMcpServerConfig,
  createStateStorage,
  type JobQueue,
  loadSystemMessageCatalog,
  type SystemMessageCatalog,
} from "@voidbot/core";
import {
  LocalLlmProvider,
  OpenAiApiProvider,
  OwnerCodexProvider,
  ProviderRegistry,
} from "@voidbot/providers";
import {
  filterPromptEchoHistoryResults,
  createTextEmbedder,
  createVectorStores,
  FileMessageArchiveRepository,
  FileSourceDocumentArchiveRepository,
  RetrievalService,
  searchHistoryWithArchiveFallback,
  SourceDocumentIngester,
  type ArchivedMessageRecord,
} from "@voidbot/rag";
import {
  type JobRecord,
  type ProviderArtifact,
  type ProviderNotificationIntent,
} from "@voidbot/shared";

const config = loadConfig();

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
const historyVectorStore = vectorStores.history;
const sourceVectorStore = vectorStores.source;
const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
const sourceArchiveRepository = new FileSourceDocumentArchiveRepository(config.ragSourceArchivePath);
const sourceDocumentIngester = new SourceDocumentIngester();
const retrievalService = new RetrievalService(
  historyVectorStore,
  sourceVectorStore,
);

let isProcessing = false;
let providerRegistry: ProviderRegistry;
let systemMessages: SystemMessageCatalog;
let jobQueue: JobQueue;
let auditLog: AuditLog;

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const {
    jobQueue: stateJobQueue,
    auditLog: stateAuditLog,
  } = await createStateStorage({
    backend: config.stateStorageBackend,
    databaseDsn: config.databaseDsn,
    jobsFile: config.jobsFile,
    auditLogFile: config.auditLogFile,
    interactionMemoryFile: config.interactionMemoryFile,
    rateLimitStateFile: config.rateLimitStateFile,
  });
  jobQueue = stateJobQueue;
  auditLog = stateAuditLog;
  systemMessages = await loadSystemMessageCatalog(
    config.systemMessagesPath,
    resolve("config/system-messages.json"),
  );
  providerRegistry = await buildProviderRegistry(systemMessages);
  console.log(`VoidBot worker polling every ${config.workerPollIntervalMs}ms.`);
  await pollPendingJobs();
  setInterval(() => {
    void pollPendingJobs();
  }, config.workerPollIntervalMs);
}

async function processPendingJobs(): Promise<void> {
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    systemMessages = await loadSystemMessageCatalog(
      config.systemMessagesPath,
      resolve("config/system-messages.json"),
    );
    providerRegistry = await buildProviderRegistry(systemMessages);
    const jobs = await jobQueue.claimRunnableJobs();

    for (const job of jobs) {
      await processJob(job);
    }
  } finally {
    isProcessing = false;
  }
}

async function pollPendingJobs(): Promise<void> {
  try {
    await processPendingJobs();
  } catch (error) {
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : "Unexpected worker poll failure.";
    console.error(`Worker poll failed: ${message}`);
  }
}

async function buildProviderRegistry(systemMessagesCatalog: SystemMessageCatalog): Promise<ProviderRegistry> {
  return new ProviderRegistry([
    new OwnerCodexProvider({
      ownerDiscordId: config.ownerDiscordId,
      enabled: config.enabledProviders.includes("owner_codex"),
      mode: config.ownerCodexMode,
      executable: config.codexExecutable,
      executableArgs: config.codexExecArgs,
      model: config.codexModel,
      reasoningEffort: config.codexModelReasoningEffort,
      timeoutMs: config.codexExecTimeoutMs,
      workingDirectory: process.cwd(),
      historyLookup: retrievalService,
      handoffNoticeBuilder: (jobId) =>
        systemMessagesCatalog.render("owner_codex.handoff_notice", {
          handoffPath: `.voidbot/artifacts/${jobId}/handoff.md`,
          debugPath: `.voidbot/artifacts/${jobId}/debug-trace.md`,
        }),
      mcpServers: [buildVoidMcpServerConfig(process.cwd())],
    }),
    new OpenAiApiProvider(config.enabledProviders.includes("openai_api")),
    new LocalLlmProvider({
      enabled: config.enabledProviders.includes("local_llm"),
      ownerDiscordId: config.ownerDiscordId,
      ollamaBaseUrl: config.localLlm.ollamaBaseUrl,
      ollamaModel: config.localLlm.ollamaModel,
      ollamaTimeoutMs: config.localLlm.ollamaTimeoutMs,
      ollamaKeepAlive: config.localLlm.ollamaKeepAlive,
      ollamaThink: config.localLlm.ollamaThink,
      ollamaNumCtx: config.localLlm.ollamaNumCtx,
      allowPublicResponses: config.localLlm.allowPublic,
      toolbox: {
        listIndexedRepos: async () => {
          const repos = await sourceArchiveRepository.listRepoSummaries();

          return {
            repoCount: repos.length,
            repos,
          };
        },
        searchHistory: async (input) => {
          const rawResults = await searchHistoryWithArchiveFallback({
            retrievalService,
            archiveRepository,
            query: input.query,
            limit: input.limit,
            guildId: input.guildId,
            channelId: input.channelId,
            authorId: input.authorId,
            preserveOverfetch: true,
          });
          const results = filterPromptEchoHistoryResults(rawResults, input.query);

          return {
            query: input.query,
            resultCount: results.length,
            results: formatHistoryResults(results),
          };
        },
        getMessageContext: async (input) => {
          const messages = await archiveRepository.listContextWindow(
            input.messageId,
            input.before,
            input.after,
          );

          return {
            found: messages.length > 0,
            messageId: input.messageId,
            count: messages.length,
            messages: messages.map((message) =>
              formatArchivedMessageContext(message, input.messageId),
            ),
          };
        },
        searchSources: async (input) => {
          const results = await retrievalService.searchRepositorySources(input.query, input.limit, {
            repoName: input.repoName,
            pathPrefix: input.pathPrefix,
            language: input.language,
          });

          return {
            query: input.query,
            resultCount: results.length,
            results: formatSourceResults(results),
          };
        },
        getSourceContext: async (input) => {
          const document = await sourceArchiveRepository.get(input.sourceId);

          if (!document) {
            return {
              found: false,
              sourceId: input.sourceId,
              count: 0,
              chunks: [],
            };
          }

          const chunks = sourceDocumentIngester.buildContextWindow(
            document,
            input.chunkIndex,
            input.before,
            input.after,
          );

          return {
            found: true,
            sourceId: input.sourceId,
            repoName: document.repoName,
            path: document.path,
            language: document.language,
            count: chunks.length,
            chunks: chunks.map((chunk) => ({
              chunkId: chunk.chunkId,
              chunkIndex: chunk.chunkIndex,
              lineStart: chunk.lineStart,
              lineEnd: chunk.lineEnd,
              isAnchor: chunk.chunkIndex === input.chunkIndex,
              text: chunk.text,
            })),
          };
        },
      },
    }),
  ]);
}

async function processJob(job: JobRecord): Promise<void> {
  const provider = providerRegistry.get(job.provider);

  if (!provider || !provider.isEnabled()) {
    const errorMessage = `Provider ${job.provider} is not enabled.`;
    await jobQueue.markFailed(job.id, errorMessage);
    await maybeNotifyOwnerOfJobFailure(job, errorMessage);
    return;
  }

  try {
    const request = provider.buildRequest(job.contextBundle, {
      jobId: job.id,
      command: job.command,
    });
    const response = await provider.execute(request);
    const artifactPaths = await writeArtifacts(job.id, response.artifacts ?? []);

    if (response.status === "ready_for_review") {
      await jobQueue.markAwaitingPostApproval(job.id, artifactPaths, response.summary);
      await deliverOwnerNotifications(job, response.notifications ?? []);
      await auditLog.record({
        type: "provider.bundle_ready",
        actorId: job.requester.id,
        jobId: job.id,
        provider: job.provider,
        details: {
          artifactPaths,
        },
      });
      console.log(`Prepared manual package for job ${job.id}.`);
      return;
    }

    const finalResponse = fitDiscordMessage(response.outputText ?? response.summary);

    if (job.postApprovalRequired) {
      await jobQueue.markAwaitingPostApproval(job.id, artifactPaths, response.summary);
      await deliverOwnerNotifications(job, response.notifications ?? []);
      await auditLog.record({
        type: "provider.completed_pending_post_approval",
        actorId: job.requester.id,
        jobId: job.id,
        provider: job.provider,
        details: {
          summary: response.summary,
        },
      });
      console.log(`Prepared response for post approval on job ${job.id}.`);
      return;
    }

    if (job.command === "repo-identity-mention" || job.command === "repo-face-rumination") {
      await jobQueue.completeJobDirect(job.id, finalResponse);
      await deliverOwnerNotifications(job, response.notifications ?? []);
      await auditLog.record({
        type: "provider.completed",
        actorId: job.requester.id,
        jobId: job.id,
        provider: job.provider,
        details: {
          summary: response.summary,
          autoPosted: false,
          reason: `${job.command}_must_post_through_mcp`,
        },
      });
      console.log(`Completed ${job.command} job ${job.id}.`);
      return;
    }

    await postJobResponse(job, finalResponse);
    await jobQueue.completeJobDirect(job.id, finalResponse);
    await deliverOwnerNotifications(job, response.notifications ?? []);
    await auditLog.record({
      type: "provider.completed",
      actorId: job.requester.id,
      jobId: job.id,
      provider: job.provider,
      details: {
        summary: response.summary,
        autoPosted: true,
      },
    });
    console.log(`Completed job ${job.id}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected worker failure.";
    await jobQueue.markFailed(job.id, message);
    await maybeNotifyOwnerOfJobFailure(job, message);
    await auditLog.record({
      type: "provider.failed",
      actorId: job.requester.id,
      jobId: job.id,
      provider: job.provider,
      details: {
        error: message,
      },
    });
    console.error(`Failed job ${job.id}: ${message}`);
  }
}

async function maybeNotifyOwnerOfJobFailure(job: JobRecord, errorMessage: string): Promise<void> {
  if (job.requester.id !== config.ownerDiscordId) {
    return;
  }

  try {
    await postOwnerNotification(
      systemMessages.render("job.owner.worker_failed_dm", {
        jobId: job.id,
        command: job.command,
        providerName: job.provider,
        errorMessage,
      }),
    );
  } catch (error) {
    console.error(
      `Failed to DM owner about job ${job.id}: ${
        error instanceof Error ? error.message : "Unexpected notification failure."
      }`,
    );
  }
}

async function deliverOwnerNotifications(
  job: JobRecord,
  notifications: ProviderNotificationIntent[],
): Promise<void> {
  if (notifications.length === 0) {
    return;
  }

  for (const notification of notifications) {
    try {
      await postOwnerNotification(notification.message);
      await auditLog.record({
        type: "provider.notification_sent",
        actorId: job.requester.id,
        jobId: job.id,
        provider: job.provider,
        details: {
          channel: notification.channel,
          reason: notification.reason,
          message: notification.message,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected notification delivery failure.";
      await auditLog.record({
        type: "provider.notification_failed",
        actorId: job.requester.id,
        jobId: job.id,
        provider: job.provider,
        details: {
          channel: notification.channel,
          reason: notification.reason,
          message: notification.message,
          error: message,
        },
      });
      console.error(`Failed owner notification for job ${job.id}: ${message}`);
    }
  }
}

async function writeArtifacts(
  jobId: string,
  artifacts: ProviderArtifact[],
): Promise<Record<string, string>> {
  if (artifacts.length === 0) {
    return {};
  }

  const artifactDirectory = join(config.artifactsDir, jobId);
  await mkdir(artifactDirectory, { recursive: true });

  const paths: Record<string, string> = {};

  for (const artifact of artifacts) {
    const filePath = join(artifactDirectory, artifact.name);
    await writeFile(filePath, artifact.content, "utf8");
    paths[artifact.name] = filePath;
  }

  return paths;
}

async function postJobResponse(job: JobRecord, content: string): Promise<void> {
  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required for the worker to post completed responses.");
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${job.outputChannelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      message_reference: job.requestMessageId
        ? {
            message_id: job.requestMessageId,
            fail_if_not_exists: false,
          }
        : undefined,
      allowed_mentions: {
        parse: [],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord post failed with ${response.status}: ${await response.text()}`);
  }
}

async function postOwnerNotification(content: string): Promise<void> {
  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required for the worker to send owner notifications.");
  }

  const dmChannelId = await openOwnerDmChannel();
  const response = await fetch(`https://discord.com/api/v10/channels/${dmChannelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: fitDiscordMessage(content),
      allowed_mentions: {
        parse: [],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord owner notification failed with ${response.status}: ${await response.text()}`);
  }
}

async function openOwnerDmChannel(): Promise<string> {
  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required for the worker to open an owner DM.");
  }

  const response = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient_id: config.ownerDiscordId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord DM open failed with ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord DM open succeeded without returning a channel id.");
  }

  return payload.id;
}

function fitDiscordMessage(content: string): string {
  const trimmed = content.trim();

  if (trimmed.length <= 1900) {
    return trimmed;
  }

  return `${trimmed.slice(0, 1897)}...`;
}

function formatHistoryResults(
  results: Awaited<ReturnType<RetrievalService["searchHistory"]>>,
): Array<Record<string, unknown>> {
  return results.map((result) => ({
    score: Number(result.score.toFixed(4)),
    text: result.text,
    sourceId: result.sourceId,
    channelId: result.metadata.channelId,
    channelName: result.metadata.channelName,
    authorId: result.metadata.authorId,
    authorName: result.metadata.authorName,
    timestamp: result.metadata.timestamp,
    timeContext: formatTimeContext(result.metadata.timestamp),
    jumpUrl: result.metadata.jumpUrl,
    threadId: result.metadata.threadId,
  }));
}

function formatSourceResults(
  results: Awaited<ReturnType<RetrievalService["searchRepositorySources"]>>,
): Array<Record<string, unknown>> {
  return results.map((result) => ({
    score: Number(result.score.toFixed(4)),
    text: result.text,
    sourceId: result.sourceId,
    repoName: result.metadata.repoName,
    path: result.metadata.path,
    language: result.metadata.language,
    title: result.metadata.title,
    chunkIndex: Number(result.metadata.chunkIndex ?? 0),
    lineStart: Number(result.metadata.lineStart ?? 1),
    lineEnd: Number(result.metadata.lineEnd ?? 1),
    lastModifiedAt: result.metadata.lastModifiedAt,
  }));
}

function formatArchivedMessageContext(
  message: ArchivedMessageRecord,
  anchorMessageId: string,
): Record<string, unknown> {
  return {
    id: message.id,
    isAnchor: message.id === anchorMessageId,
    timestamp: message.timestamp,
    timeContext: formatTimeContext(message.timestamp),
    authorId: message.authorId,
    authorName: message.authorName,
    channelId: message.channelId,
    channelName: message.metadata?.channelName,
    threadId: message.threadId,
    content: message.content,
    jumpUrl: message.metadata?.jumpUrl,
    editedAt: message.editedAt,
  };
}

function formatTimeContext(timestamp: string | undefined): string | undefined {
  if (!timestamp) {
    return undefined;
  }

  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  const absolute = formatUtcTimestamp(timestamp);
  const now = new Date();
  const deltaMs = now.getTime() - parsed.getTime();
  const absDeltaMs = Math.abs(deltaMs);
  const suffix = deltaMs >= 0 ? "ago" : "from now";

  if (absDeltaMs < 60_000) {
    return `${absolute} (just now)`;
  }

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const yearMs = 365 * dayMs;

  if (absDeltaMs < hourMs) {
    const minutes = Math.round(absDeltaMs / minuteMs);
    return `${absolute} (${minutes} minute${minutes === 1 ? "" : "s"} ${suffix})`;
  }

  if (absDeltaMs < dayMs) {
    const hours = Math.round(absDeltaMs / hourMs);
    return `${absolute} (${hours} hour${hours === 1 ? "" : "s"} ${suffix})`;
  }

  if (absDeltaMs < yearMs) {
    const days = Math.round(absDeltaMs / dayMs);
    return `${absolute} (${days} day${days === 1 ? "" : "s"} ${suffix})`;
  }

  const years = Math.round(absDeltaMs / yearMs);
  return `${absolute} (${years} year${years === 1 ? "" : "s"} ${suffix})`;
}

function formatUtcTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}
