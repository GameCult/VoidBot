import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  applyRepoFacePostFatigueAfterSpeech,
  type AuditLog,
  buildVoidMcpServerConfig,
  createStateStorage,
  applyVoidSelfStateOperation,
  findRepoDiscordIdentity,
  isRepoDiscordIdentityAllowedInChannel,
  type JobQueue,
  loadRepoDiscordIdentityRegistry,
  loadSystemMessageCatalog,
  resolveRepoFaceStatePath,
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
const REPO_IDENTITY_POST_SENTINEL = "VOIDBOT_REPO_IDENTITY_POST:";
const REPO_IDENTITY_ARTICLE_SENTINEL = "VOIDBOT_REPO_IDENTITY_ARTICLE:";
const REPO_IDENTITY_PROPOSAL_PR_SENTINEL = "VOIDBOT_REPO_IDENTITY_PROPOSAL_PR:";
const REPO_IDENTITY_PR_COMMENT_SENTINEL = "VOIDBOT_REPO_IDENTITY_PR_COMMENT:";
const REPO_IDENTITY_UPDATE_REQUEST_SENTINEL = "VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST:";

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

    if (job.command === "repo-face-rumination") {
      const repoIdentityPosts = parseRepoIdentityPostIntents(finalResponse);
      const repoIdentityUpdateRequests = parseRepoIdentityUpdateRequestIntents(finalResponse);
      const repoIdentityArticles = config.repoFaceGithubActionsEnabled
        ? parseRepoIdentityArticleIntents(finalResponse)
        : [];
      const repoIdentityProposals = config.repoFaceGithubActionsEnabled
        ? parseRepoIdentityProposalPrIntents(finalResponse)
        : [];
      const repoIdentityPrComments = config.repoFaceGithubActionsEnabled
        ? parseRepoIdentityPrCommentIntents(finalResponse)
        : [];
      const ignoredGithubActionIntents = config.repoFaceGithubActionsEnabled
        ? 0
        : countRepoIdentityGithubActionIntents(finalResponse);
      const proposalPrSubmitted = repoIdentityProposals.length > 0;
      const prCommentSubmitted = !proposalPrSubmitted && repoIdentityPrComments.length > 0;
      const articlePrSubmitted =
        !proposalPrSubmitted && !prCommentSubmitted && repoIdentityArticles.length > 0;
      const updateRequestSubmitted =
        !proposalPrSubmitted && !prCommentSubmitted && !articlePrSubmitted && repoIdentityUpdateRequests.length > 0;
      if (repoIdentityProposals.length > 0) {
        await writeRepoIdentityProposalPrIntent(job, repoIdentityProposals[0]);
      } else if (repoIdentityPrComments.length > 0) {
        await commentRepoIdentityPullRequestIntent(job, repoIdentityPrComments[0]);
      } else if (repoIdentityArticles.length > 0) {
        await writeRepoIdentityArticleIntent(job, repoIdentityArticles[0]);
      } else if (repoIdentityUpdateRequests.length > 0) {
        await enqueueRepoIdentityUpdateRequestIntent(job, repoIdentityUpdateRequests[0]);
      }
      if (!proposalPrSubmitted && !prCommentSubmitted && !articlePrSubmitted && !updateRequestSubmitted) {
        for (const post of repoIdentityPosts.slice(0, 1)) {
          await postRepoIdentityIntent(job, post);
        }
      }
      const cleanedFinalResponse = stripRepoIdentityPostIntents(finalResponse);
      await jobQueue.completeJobDirect(job.id, cleanedFinalResponse || finalResponse);
      await deliverOwnerNotifications(job, response.notifications ?? []);
      await auditLog.record({
        type: "provider.completed",
        actorId: job.requester.id,
        jobId: job.id,
        provider: job.provider,
        details: {
          summary: response.summary,
          autoPosted:
            repoIdentityPosts.length > 0 ||
            proposalPrSubmitted ||
            prCommentSubmitted ||
            articlePrSubmitted ||
            updateRequestSubmitted,
          articlePrSubmitted,
          proposalPrSubmitted,
          prCommentSubmitted,
          updateRequestSubmitted,
          ignoredGithubActionIntents,
          reason:
            proposalPrSubmitted
              ? "repo_face_rumination_submitted_registered_identity_proposal_pr"
              : prCommentSubmitted
                ? "repo_face_rumination_commented_on_pr_as_registered_identity"
              : articlePrSubmitted
                ? "repo_face_rumination_submitted_registered_identity_article_pr"
              : updateRequestSubmitted
                ? "repo_face_rumination_enqueued_bifrost_update_request"
              : repoIdentityPosts.length > 0
                ? "repo_face_rumination_posted_as_registered_identity"
              : `${job.command}_private_summary`,
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

function parseRepoIdentityIdFromPrompt(prompt: string): string | undefined {
  const match = prompt.match(/repo identity\s+.+?\(([^)]+)\)\s+for repo/i);
  return (
    match?.[1]?.trim() ??
    prompt.match(/repo Face heartbeat for .+?\(([^)]+)\) over repo/i)?.[1]?.trim() ??
    prompt.match(/identity "([^"]+)"/i)?.[1]?.trim()
  );
}

interface RepoIdentityPostIntent {
  identity?: string;
  channelId?: string;
  content: string;
  replyToMessageId?: string;
}

interface RepoIdentityArticleIntent {
  identity?: string;
  title: string;
  path?: string;
  content: string;
  shareContent?: string;
  channelId?: string;
  replyToMessageId?: string;
}

interface RepoIdentityProposalPrIntent {
  identity?: string;
  title: string;
  path?: string;
  content: string;
  shareContent?: string;
  channelId?: string;
  replyToMessageId?: string;
}

interface RepoIdentityPrCommentIntent {
  identity?: string;
  pr: string;
  content: string;
  shareContent?: string;
  channelId?: string;
  replyToMessageId?: string;
}

interface RepoIdentityUpdateRequestIntent {
  identity?: string;
  title: string;
  content: string;
  priority?: number;
  sourceMessageIds: string[];
  channelId?: string;
  replyToMessageId?: string;
}

interface BifrostBridgeReceipt {
  action?: string;
  ok?: boolean;
  branch?: string;
  prUrl?: string;
  messageId?: string;
  transport?: "bot" | "webhook";
}

interface BifrostUpdateRequestReceipt {
  id: string;
  status: "queued" | "claimed" | "completed" | "cancelled";
  title: string;
  targetRepoName: string;
  targetAgentIdentity?: string;
  priority: number;
}

async function postRepoIdentityIntent(job: JobRecord, intent: RepoIdentityPostIntent): Promise<void> {
  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required for Bifrost to post repo identity responses.");
  }

  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for job ${job.id}.`);
  }

  const channelId = intent.channelId ?? job.outputChannelId;
  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for job ${job.id}.`);
  }

  if (!isRepoDiscordIdentityAllowedInChannel(identity, channelId)) {
    throw new Error(`Repo identity ${identity.id} is not registered for Discord channel ${channelId}.`);
  }

  const content = sanitizeRepoIdentityPostContent(identity, intent.content);
  const contentFile = await writeBifrostPayloadFile(job, `${identity.id}-discord-post.md`, fitDiscordMessage(content));
  const posted = runBifrostBridge([
    "discord-post",
    "--channel-id",
    channelId,
    "--content-file",
    contentFile,
    "--persona-name",
    identity.displayName,
    ...(identity.avatarUrl ? ["--persona-avatar-url", identity.avatarUrl] : []),
    ...(intent.replyToMessageId ? ["--reply-to-message-id", intent.replyToMessageId] : []),
  ]);
  if (!posted.messageId || !posted.transport) {
    throw new Error(`Bifrost Discord bridge returned no message receipt for job ${job.id}.`);
  }
  await recordRepoIdentityDeliveryReceipt({
    identity,
    channelId,
    content,
    replyToMessageId: intent.replyToMessageId,
    messageId: posted.messageId,
    transport: posted.transport,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not record repo identity delivery receipt for job ${job.id}: ${message}`);
  });
}

function sanitizeRepoIdentityPostContent(identity: { displayName: string; repoName: string }, content: string): string {
  let sanitized = content.trim();
  const escapedRepo = escapeRegExp(identity.repoName);
  const escapedDisplay = escapeRegExp(identity.displayName);
  const prefixPatterns = [
    new RegExp(`^(?:repo[- ]?face\\s+)?heartbeat\\s+from\\s+${escapedRepo}\\s*:\\s*`, "i"),
    new RegExp(`^${escapedRepo}\\s+heartbeat(?:\\s+complete)?\\s*:\\s*`, "i"),
    new RegExp(`^${escapedDisplay}\\s+heartbeat(?:\\s+complete)?\\s*:\\s*`, "i"),
    /^(?:repo[- ]?face\s+)?heartbeat\s+from\s+[^:]{1,80}\s*:\s*/i,
  ];

  for (const pattern of prefixPatterns) {
    sanitized = sanitized.replace(pattern, "").trim();
  }

  return sanitized.length > 0 ? sanitized : content.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRepoIdentityPostIntents(finalResponse: string): RepoIdentityPostIntent[] {
  const intents: RepoIdentityPostIntent[] = [];

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REPO_IDENTITY_POST_SENTINEL)) {
      continue;
    }

    const payload = trimmed.slice(REPO_IDENTITY_POST_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (!content) {
        continue;
      }
      intents.push({
        identity: typeof parsed.identity === "string" ? parsed.identity.trim() : undefined,
        channelId: typeof parsed.channelId === "string" ? parsed.channelId.trim() : undefined,
        replyToMessageId:
          typeof parsed.replyToMessageId === "string" ? parsed.replyToMessageId.trim() : undefined,
        content,
      });
    } catch {
      continue;
    }
  }

  return intents;
}

async function writeRepoIdentityArticleIntent(job: JobRecord, intent: RepoIdentityArticleIntent): Promise<void> {
  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for article intent on job ${job.id}.`);
  }

  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for article intent on job ${job.id}.`);
  }

  const repoRoot = resolveRepoRoot(identity);
  const relativePath = normalizeArticlePath(intent, identity);
  const articlePath = resolve(repoRoot, relativePath);
  if (!isPathInside(repoRoot, articlePath)) {
    throw new Error(`Article path escapes repo root for ${identity.id}: ${relativePath}`);
  }

  const contentFile = await writeBifrostPayloadFile(job, `${identity.id}-article.md`, ensureTrailingNewline(intent.content));
  const pr = runBifrostBridge([
    "github-draft-pr",
    "--repo-root",
    repoRoot,
    "--identity",
    identity.id,
    "--title",
    `${identity.id}: article: ${intent.title}`,
    "--path",
    relativePath,
    "--content-file",
    contentFile,
    "--body",
    `Draft bylined article submitted by repo Face ${identity.id}.\n\nPath: ${relativePath}`,
    "--commit-message",
    `${identity.id}: draft article ${intent.title}`,
  ]);

  const prLine = pr.prUrl ? `\n\nPR: ${pr.prUrl}` : `\n\nDraft branch: ${pr.branch}`;
  const articleLine = `\nArticle path: ${relativePath}`;
  const shareContent =
    intent.shareContent && intent.shareContent.trim().length > 0
      ? intent.shareContent.trim()
      : `${identity.displayName}: I drafted "${intent.title}" as a bylined article and submitted it for review.`;
  await postRepoIdentityIntent(job, {
    identity: identity.id,
    channelId: intent.channelId ?? job.outputChannelId,
    replyToMessageId: intent.replyToMessageId,
    content: `${shareContent}${prLine}${articleLine}`,
  });
}

async function writeRepoIdentityProposalPrIntent(
  job: JobRecord,
  intent: RepoIdentityProposalPrIntent,
): Promise<void> {
  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for proposal PR intent on job ${job.id}.`);
  }

  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for proposal PR intent on job ${job.id}.`);
  }

  const repoRoot = resolveRepoRoot(identity);
  const relativePath = normalizeProposalPath(intent, identity);
  const proposalPath = resolve(repoRoot, relativePath);
  if (!isPathInside(repoRoot, proposalPath)) {
    throw new Error(`Proposal path escapes repo root for ${identity.id}: ${relativePath}`);
  }

  const contentFile = await writeBifrostPayloadFile(job, `${identity.id}-proposal.md`, ensureTrailingNewline(intent.content));
  const pr = runBifrostBridge([
    "github-draft-pr",
    "--repo-root",
    repoRoot,
    "--identity",
    identity.id,
    "--title",
    `${identity.id}: proposal: ${intent.title}`,
    "--path",
    relativePath,
    "--content-file",
    contentFile,
    "--body",
    `Draft change proposal submitted by repo Face ${identity.id}.\n\nPath: ${relativePath}`,
    "--commit-message",
    `${identity.id}: draft proposal ${intent.title}`,
  ]);

  const prLine = pr.prUrl ? `\n\nPR: ${pr.prUrl}` : `\n\nDraft branch: ${pr.branch}`;
  const proposalLine = `\nProposal path: ${relativePath}`;
  const shareContent =
    intent.shareContent && intent.shareContent.trim().length > 0
      ? intent.shareContent.trim()
      : `${identity.displayName}: I put the change proposal where it belongs: a draft PR for review.`;
  await postRepoIdentityIntent(job, {
    identity: identity.id,
    channelId: intent.channelId ?? job.outputChannelId,
    replyToMessageId: intent.replyToMessageId,
    content: `${shareContent}${prLine}${proposalLine}`,
  });
}

async function commentRepoIdentityPullRequestIntent(
  job: JobRecord,
  intent: RepoIdentityPrCommentIntent,
): Promise<void> {
  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for PR comment intent on job ${job.id}.`);
  }

  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for PR comment intent on job ${job.id}.`);
  }

  const repoRoot = resolveRepoRoot(identity);
  const prTarget = intent.pr.trim();
  if (!prTarget) {
    throw new Error(`PR comment intent for ${identity.id} on job ${job.id} did not include a PR target.`);
  }

  const body = `${identity.displayName} (${identity.id}) says:\n\n${intent.content.trim()}`;
  const contentFile = await writeBifrostPayloadFile(job, `${identity.id}-pr-comment.md`, body);
  runBifrostBridge([
    "github-pr-comment",
    "--repo-root",
    repoRoot,
    "--identity",
    identity.id,
    "--pr",
    prTarget,
    "--content-file",
    contentFile,
  ]);

  const shareContent =
    intent.shareContent && intent.shareContent.trim().length > 0
      ? intent.shareContent.trim()
      : `${identity.displayName}: I left my argument on the PR so the proposal has a real review trail.`;
  await postRepoIdentityIntent(job, {
    identity: identity.id,
    channelId: intent.channelId ?? job.outputChannelId,
    replyToMessageId: intent.replyToMessageId,
    content: `${shareContent}\n\nPR: ${prTarget}`,
  });
}

async function enqueueRepoIdentityUpdateRequestIntent(
  job: JobRecord,
  intent: RepoIdentityUpdateRequestIntent,
): Promise<void> {
  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for Bifrost update request intent on job ${job.id}.`);
  }

  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for update request intent on job ${job.id}.`);
  }

  const contentFile = await writeBifrostPayloadFile(
    job,
    `${identity.id}-bifrost-update-request.md`,
    ensureTrailingNewline(renderRepoIdentityUpdateRequestMarkdown(identity, intent)),
  );
  const sourceMessageIds = Array.from(new Set([
    ...intent.sourceMessageIds,
    intent.replyToMessageId,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)));
  const request = runBifrostAgentTransport([
    "enqueue",
    "--repo",
    identity.repoName,
    "--agent",
    identity.id,
    "--title",
    intent.title,
    "--request-file",
    contentFile,
    "--priority",
    String(normalizeBifrostPriority(intent.priority)),
    "--source-kind",
    "repo_face_heartbeat",
    "--packet-path",
    contentFile,
    "--created-by",
    identity.id,
    ...(intent.channelId ?? job.outputChannelId ? ["--source-channel-id", intent.channelId ?? job.outputChannelId] : []),
    ...(sourceMessageIds.length > 0 ? ["--source-message-ids", sourceMessageIds.join(",")] : []),
  ]);
  console.log(
    `Enqueued Bifrost update request ${request.id} for ${identity.id}/${identity.repoName} from job ${job.id}.`,
  );
}

async function writeBifrostPayloadFile(job: JobRecord, fileName: string, content: string): Promise<string> {
  const directory = resolve(config.storageRoot, "artifacts", job.id, "bifrost-bridge");
  await mkdir(directory, { recursive: true });
  const path = join(directory, sanitizePathSegment(fileName) || "payload.md");
  await writeFile(path, content, "utf8");
  return path;
}

function runBifrostAgentTransport(args: string[]): BifrostUpdateRequestReceipt {
  const transportScript = resolve(config.bifrostRoot, "tools", "agent-transport.mjs");
  const result = spawnSync(process.execPath, [transportScript, ...args], {
    cwd: config.bifrostRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(`Bifrost agent transport failed: ${result.stderr || result.stdout}`);
  }

  try {
    return JSON.parse(result.stdout) as BifrostUpdateRequestReceipt;
  } catch {
    throw new Error(`Bifrost agent transport returned non-JSON output: ${result.stdout}`);
  }
}

function runBifrostBridge(args: string[]): BifrostBridgeReceipt {
  const bridgeScript = resolve(config.bifrostRoot, "tools", "bifrost-bridge.mjs");
  const result = spawnSync("node", [bridgeScript, ...args], {
    cwd: config.bifrostRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(`Bifrost bridge failed: ${result.stderr || result.stdout}`);
  }

  try {
    return JSON.parse(result.stdout) as BifrostBridgeReceipt;
  } catch {
    throw new Error(`Bifrost bridge returned non-JSON output: ${result.stdout}`);
  }
}

function parseRepoIdentityUpdateRequestIntents(finalResponse: string): RepoIdentityUpdateRequestIntent[] {
  const intents: RepoIdentityUpdateRequestIntent[] = [];

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REPO_IDENTITY_UPDATE_REQUEST_SENTINEL)) {
      continue;
    }

    const payload = trimmed.slice(REPO_IDENTITY_UPDATE_REQUEST_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (!title || !content) {
        continue;
      }
      intents.push({
        identity: typeof parsed.identity === "string" ? parsed.identity.trim() : undefined,
        title,
        content,
        priority: typeof parsed.priority === "number" ? parsed.priority : undefined,
        sourceMessageIds: Array.isArray(parsed.sourceMessageIds)
          ? parsed.sourceMessageIds.filter((entry): entry is string => typeof entry === "string")
          : [],
        channelId: typeof parsed.channelId === "string" ? parsed.channelId.trim() : undefined,
        replyToMessageId:
          typeof parsed.replyToMessageId === "string" ? parsed.replyToMessageId.trim() : undefined,
      });
    } catch {
      continue;
    }
  }

  return intents;
}

function parseRepoIdentityArticleIntents(finalResponse: string): RepoIdentityArticleIntent[] {
  const intents: RepoIdentityArticleIntent[] = [];

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REPO_IDENTITY_ARTICLE_SENTINEL)) {
      continue;
    }

    const payload = trimmed.slice(REPO_IDENTITY_ARTICLE_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (!title || !content) {
        continue;
      }
      intents.push({
        identity: typeof parsed.identity === "string" ? parsed.identity.trim() : undefined,
        title,
        path: typeof parsed.path === "string" ? parsed.path.trim() : undefined,
        content,
        shareContent: typeof parsed.shareContent === "string" ? parsed.shareContent.trim() : undefined,
        channelId: typeof parsed.channelId === "string" ? parsed.channelId.trim() : undefined,
        replyToMessageId:
          typeof parsed.replyToMessageId === "string" ? parsed.replyToMessageId.trim() : undefined,
      });
    } catch {
      continue;
    }
  }

  return intents;
}

function parseRepoIdentityProposalPrIntents(finalResponse: string): RepoIdentityProposalPrIntent[] {
  const intents: RepoIdentityProposalPrIntent[] = [];

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REPO_IDENTITY_PROPOSAL_PR_SENTINEL)) {
      continue;
    }

    const payload = trimmed.slice(REPO_IDENTITY_PROPOSAL_PR_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (!title || !content) {
        continue;
      }
      intents.push({
        identity: typeof parsed.identity === "string" ? parsed.identity.trim() : undefined,
        title,
        path: typeof parsed.path === "string" ? parsed.path.trim() : undefined,
        content,
        shareContent: typeof parsed.shareContent === "string" ? parsed.shareContent.trim() : undefined,
        channelId: typeof parsed.channelId === "string" ? parsed.channelId.trim() : undefined,
        replyToMessageId:
          typeof parsed.replyToMessageId === "string" ? parsed.replyToMessageId.trim() : undefined,
      });
    } catch {
      continue;
    }
  }

  return intents;
}

function parseRepoIdentityPrCommentIntents(finalResponse: string): RepoIdentityPrCommentIntent[] {
  const intents: RepoIdentityPrCommentIntent[] = [];

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REPO_IDENTITY_PR_COMMENT_SENTINEL)) {
      continue;
    }

    const payload = trimmed.slice(REPO_IDENTITY_PR_COMMENT_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const pr = typeof parsed.pr === "string" ? parsed.pr.trim() : "";
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (!pr || !content) {
        continue;
      }
      intents.push({
        identity: typeof parsed.identity === "string" ? parsed.identity.trim() : undefined,
        pr,
        content,
        shareContent: typeof parsed.shareContent === "string" ? parsed.shareContent.trim() : undefined,
        channelId: typeof parsed.channelId === "string" ? parsed.channelId.trim() : undefined,
        replyToMessageId:
          typeof parsed.replyToMessageId === "string" ? parsed.replyToMessageId.trim() : undefined,
      });
    } catch {
      continue;
    }
  }

  return intents;
}

function countRepoIdentityGithubActionIntents(finalResponse: string): number {
  let count = 0;

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith(REPO_IDENTITY_ARTICLE_SENTINEL) ||
      trimmed.startsWith(REPO_IDENTITY_PROPOSAL_PR_SENTINEL) ||
      trimmed.startsWith(REPO_IDENTITY_PR_COMMENT_SENTINEL)
    ) {
      count += 1;
    }
  }

  return count;
}

function renderRepoIdentityUpdateRequestMarkdown(
  identity: { id: string; displayName: string; repoName: string },
  intent: RepoIdentityUpdateRequestIntent,
): string {
  return [
    "# Repo Face Update Request",
    "",
    `Source Face: ${identity.displayName} (${identity.id})`,
    `Target repo: ${identity.repoName}`,
    "",
    "## Request",
    "",
    intent.content.trim(),
    "",
    "## Instructions For Codex",
    "",
    "Work this request in the target workspace. Prefer a small coherent change, proposal, doc, or test-backed patch. If the request is not actionable enough, write down the smallest missing question instead of silently dropping it.",
    "",
  ].join("\n");
}

function normalizeBifrostPriority(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 80;
  }
  return Math.max(1, Math.min(100, Math.round(value)));
}

function resolveRepoRoot(identity: { repoName: string; repoPath?: string }): string {
  if (identity.repoPath && identity.repoPath.trim().length > 0) {
    return resolve(identity.repoPath);
  }
  if (config.sourceRepoRoot) {
    return resolve(config.sourceRepoRoot, identity.repoName);
  }
  return resolve(config.storageRoot, "repo-article-drafts", identity.repoName);
}

function normalizeArticlePath(
  intent: RepoIdentityArticleIntent,
  identity: { displayName: string },
): string {
  const path = intent.path?.trim();
  if (path && !isAbsolute(path) && !path.split(/[\\/]+/).includes("..")) {
    return path.replace(/\\/g, "/");
  }

  const date = new Date().toISOString().slice(0, 10);
  return `Aetheria/Articles/${sanitizePathSegment(identity.displayName)}/${date}-${slugify(intent.title)}.md`;
}

function normalizeProposalPath(
  intent: RepoIdentityProposalPrIntent,
  identity: { displayName: string },
): string {
  const path = intent.path?.trim();
  if (path && !isAbsolute(path) && !path.split(/[\\/]+/).includes("..")) {
    return path.replace(/\\/g, "/");
  }

  const date = new Date().toISOString().slice(0, 10);
  return `Proposals/${sanitizePathSegment(identity.displayName)}/${date}-${slugify(intent.title)}.md`;
}

function stripRepoIdentityPostIntents(finalResponse: string): string {
  return finalResponse
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith(REPO_IDENTITY_POST_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_UPDATE_REQUEST_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_ARTICLE_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_PROPOSAL_PR_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_PR_COMMENT_SENTINEL)
      );
    })
    .join("\n")
    .trim();
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function slugify(value: string): string {
  return sanitizePathSegment(value)
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "article";
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function recordRepoIdentityDeliveryReceipt(input: {
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>;
  channelId: string;
  content: string;
  replyToMessageId?: string;
  messageId: string;
  transport: "bot" | "webhook";
}): Promise<void> {
  await applyVoidSelfStateOperation(
    {
      canonicalPath: resolveRepoFaceStatePath(input.identity, config.storageRoot),
      identity: {
        agentId: input.identity.id,
        publicName: input.identity.displayName,
        publicDescription: input.identity.description,
      },
    },
    {
      operation: "record_delivery_receipt",
      receipt: {
        receiptKey: `repo-identity:${input.identity.id}:${input.messageId}`,
        sentAt: new Date().toISOString(),
        mode: "repo_identity",
        transport: input.transport,
        channelId: input.channelId,
        replyToMessageId: input.replyToMessageId,
        personaName: input.identity.displayName,
        personaAvatarUrl: input.identity.avatarUrl,
        contentLength: input.content.length,
        chunkCount: 1,
        preview: input.content.slice(0, 1000),
      },
    },
  );

  try {
    await applyRepoFacePostFatigueAfterSpeech({
      identity: input.identity,
      storageRoot: config.storageRoot,
      heartbeatStatePath: config.repoFaceHeartbeats.statePath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not apply repo Face post fatigue for ${input.identity.id}: ${message}`);
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
