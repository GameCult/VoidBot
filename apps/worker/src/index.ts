import "dotenv/config";

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  applyRepoFacePostFatigueAfterSpeech,
  appendRepoFaceVoiceOutboxEntry,
  type AuditLog,
  buildVoidMcpServerConfig,
  createStateStorage,
  applyVoidSelfStateOperation,
  findRepoDiscordIdentity,
  faceRegistryAsRepoDiscordRegistry,
  hasFreshHumanRepoFaceVoiceListener,
  isRepoDiscordIdentityAllowedInChannel,
  loadRepoFaceVoicePresenceSnapshot,
  type JobQueue,
  loadFaceIdentityRegistry,
  loadSystemMessageCatalog,
  resolveRepoFaceStatePath,
  resolveWeksaArtifactPath,
  type SystemMessageCatalog,
  WeksaSpeechClient,
  type WeksaMimoReceipt,
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
  type ProviderAdapter,
  type ProviderArtifact,
  type ProviderNotificationIntent,
  type ProviderResponse,
  loadPromptTemplate,
} from "@voidbot/shared";
import {
  type RepoIdentityArticleIntent,
  isValidArticleDate,
  normalizeArticlePath,
  normalizeArticleSite,
  renderRepoIdentityArticleMarkdown,
  resolveArticleRepoRoot,
  validateRenderedArticleMarkdown,
} from "./repo-face-article.js";
import {
  REPO_IDENTITY_POST_SENTINEL,
  isNonPublicRepoIdentitySpeech,
  normalizePublicRepoIdentitySpeech,
  parseRepoIdentityPostIntents,
  type RepoIdentityPostIntent,
} from "./repo-face-speech.js";

const config = loadConfig();
const weksaSpeechClient = new WeksaSpeechClient({
  baseUrl: config.repoFaceWeksaSpeech.daemonBaseUrl,
  timeoutMs: config.repoFaceWeksaSpeech.timeoutMs,
});
const REPO_IDENTITY_PROPOSAL_PR_SENTINEL = "VOIDBOT_REPO_IDENTITY_PROPOSAL_PR:";
const REPO_IDENTITY_PR_COMMENT_SENTINEL = "VOIDBOT_REPO_IDENTITY_PR_COMMENT:";
const REPO_IDENTITY_UPDATE_REQUEST_SENTINEL = "VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST:";
const REPO_IDENTITY_BIFROST_TOPIC_SENTINEL = "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC:";
const CURRENT_REPO_FACE_IDENTITY_SELECTORS = new Set([
  "face_id",
  "faceid",
  "current_face",
  "current_face_id",
  "currentface",
  "currentfaceid",
  "current_identity",
  "current_identity_id",
  "currentidentity",
  "currentidentityid",
  "job_identity",
  "job_identity_id",
  "jobidentity",
  "jobidentityid",
]);
const REPO_FACE_FORBIDDEN_CHILD_TOOLS = new Set([
  "read_repo_face_state",
  "list_mcp_resources",
  "read_mcp_resource",
  "post_repo_identity_message",
  "apply_repo_face_state_operation",
  "notify_owner",
]);

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
  personaMemoryPath: config.vectorStore.personaMemoryPath,
  sourceRoot: config.sourceVectorStoreRoot,
  qdrant: config.qdrant,
  historyEmbedder: embedder,
  sourceEmbedder: sourceQueryEmbedder,
  personaMemoryEmbedder: embedder,
});
const historyVectorStore = vectorStores.history;
const sourceVectorStore = vectorStores.source;
const personaMemoryVectorStore = vectorStores.personaMemory;
const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
const sourceArchiveRepository = new FileSourceDocumentArchiveRepository(config.ragSourceArchivePath);
const sourceDocumentIngester = new SourceDocumentIngester();
const retrievalService = new RetrievalService(
  historyVectorStore,
  sourceVectorStore,
  personaMemoryVectorStore,
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
    const response = job.command === "repo-face-rumination"
      ? await executeRepoFaceJobWithInterpreter(provider, job)
      : await executeProviderForJob(provider, job, job.contextBundle);
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

    const rawFinalResponse = response.outputText ?? response.summary;
    const finalResponse = fitDiscordMessage(rawFinalResponse);

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
      const repoFaceOutput = rawFinalResponse;
      const repoIdentityPosts = parseRepoIdentityPostIntents(repoFaceOutput);
      const repoIdentityStateNotes = parseRepoIdentityStateNoteIntents(repoFaceOutput);
      const repoIdentityBifrostTopics = config.repoFaceBifrostEnabled
        ? parseRepoIdentityBifrostTopicIntents(repoFaceOutput)
        : [];
      const repoIdentityUpdateRequests = config.repoFaceBifrostEnabled
        ? parseRepoIdentityUpdateRequestIntents(repoFaceOutput)
        : [];
      const repoIdentityArticles = config.repoFaceGithubActionsEnabled
        ? parseRepoFaceArticleIntents(repoFaceOutput)
        : [];
      const repoIdentityRedditThreads = config.repoFaceGithubActionsEnabled
        ? parseRepoIdentityRedditThreadIntents(repoFaceOutput)
        : [];
      const repoIdentityProposals = config.repoFaceGithubActionsEnabled
        ? parseRepoIdentityProposalPrIntents(repoFaceOutput)
        : [];
      const repoIdentityPrComments = config.repoFaceGithubActionsEnabled
        ? parseRepoIdentityPrCommentIntents(repoFaceOutput)
        : [];
      const ignoredGithubActionIntents = config.repoFaceGithubActionsEnabled
        ? 0
        : countRepoIdentityGithubActionIntents(repoFaceOutput);
      const proposalPrSubmitted = repoIdentityProposals.length > 0;
      const prCommentSubmitted = !proposalPrSubmitted && repoIdentityPrComments.length > 0;
      const articlePrSubmitted =
        !proposalPrSubmitted && !prCommentSubmitted && repoIdentityArticles.length > 0;
      const redditThreadSubmitted =
        !proposalPrSubmitted &&
        !prCommentSubmitted &&
        !articlePrSubmitted &&
        repoIdentityRedditThreads.length > 0;
      const bifrostTopicSubmitted =
        config.repoFaceBifrostEnabled &&
        !proposalPrSubmitted &&
        !prCommentSubmitted &&
        !articlePrSubmitted &&
        !redditThreadSubmitted &&
        repoIdentityBifrostTopics.length > 0;
      const updateRequestRoutedToBifrostTopic =
        config.repoFaceBifrostEnabled &&
        !proposalPrSubmitted &&
        !prCommentSubmitted &&
        !articlePrSubmitted &&
        !redditThreadSubmitted &&
        !bifrostTopicSubmitted &&
        repoIdentityUpdateRequests.length > 0;
      console.log(
        `Repo-face job ${job.id} parsed actions: say=${repoIdentityPosts.length}, stateNote=${repoIdentityStateNotes.length}, bifrostTopic=${repoIdentityBifrostTopics.length}, updateRequest=${repoIdentityUpdateRequests.length}, article=${repoIdentityArticles.length}, redditThread=${repoIdentityRedditThreads.length}, proposalPr=${repoIdentityProposals.length}, prComment=${repoIdentityPrComments.length}.`,
      );
      for (const stateNote of repoIdentityStateNotes.slice(0, 4)) {
        await applyRepoIdentityStateNoteIntent(job, stateNote);
      }
      if (repoIdentityProposals.length > 0) {
        await writeRepoIdentityProposalPrIntent(job, repoIdentityProposals[0]);
      } else if (repoIdentityPrComments.length > 0) {
        await commentRepoIdentityPullRequestIntent(job, repoIdentityPrComments[0]);
      } else if (repoIdentityArticles.length > 0) {
        await writeRepoIdentityArticleIntent(job, repoIdentityArticles[0]);
      } else if (repoIdentityRedditThreads.length > 0) {
        await postRepoIdentityRedditThreadIntent(job, repoIdentityRedditThreads[0]);
      } else if (repoIdentityBifrostTopics.length > 0) {
        await submitRepoIdentityBifrostTopicIntent(job, repoIdentityBifrostTopics[0]);
      } else if (repoIdentityUpdateRequests.length > 0) {
        await submitRepoIdentityBifrostTopicIntent(
          job,
          repoIdentityUpdateRequestToBifrostTopic(repoIdentityUpdateRequests[0]),
        );
      }
      let repoIdentityPostDelivered = 0;
      if (!proposalPrSubmitted && !prCommentSubmitted && !articlePrSubmitted && !redditThreadSubmitted) {
        for (const post of repoIdentityPosts.slice(0, 1)) {
          if (await postRepoIdentityIntent(job, post)) {
            repoIdentityPostDelivered += 1;
          }
        }
      }
      const cleanedFinalResponse = stripRepoIdentityPostIntents(repoFaceOutput);
      await jobQueue.completeJobDirect(job.id, cleanedFinalResponse || repoFaceOutput);
      await deliverOwnerNotifications(job, response.notifications ?? []);
      await auditLog.record({
        type: "provider.completed",
        actorId: job.requester.id,
        jobId: job.id,
        provider: job.provider,
        details: {
          summary: response.summary,
          autoPosted:
            repoIdentityPostDelivered > 0 ||
            proposalPrSubmitted ||
            prCommentSubmitted ||
            articlePrSubmitted ||
            redditThreadSubmitted ||
            bifrostTopicSubmitted ||
            updateRequestRoutedToBifrostTopic,
          articlePrSubmitted,
          redditThreadSubmitted,
          proposalPrSubmitted,
          prCommentSubmitted,
          bifrostTopicSubmitted,
          updateRequestRoutedToBifrostTopic,
          ignoredGithubActionIntents,
          reason:
            proposalPrSubmitted
              ? "repo_face_rumination_submitted_registered_identity_proposal_pr"
              : prCommentSubmitted
                ? "repo_face_rumination_commented_on_pr_as_registered_identity"
              : articlePrSubmitted
                ? "repo_face_rumination_submitted_registered_identity_article_pr"
              : redditThreadSubmitted
                ? "repo_face_rumination_submitted_registered_identity_reddit_thread"
              : bifrostTopicSubmitted
                ? "repo_face_rumination_submitted_bifrost_topic"
              : updateRequestRoutedToBifrostTopic
                ? "repo_face_rumination_routed_legacy_update_request_to_bifrost_topic"
              : repoIdentityPostDelivered > 0
                ? "repo_face_rumination_posted_as_registered_identity"
              : repoIdentityPosts.length > 0
                ? "repo_face_rumination_speech_rejected_by_parent_interpreter"
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

async function executeProviderForJob(
  provider: ProviderAdapter,
  job: JobRecord,
  contextBundle: JobRecord["contextBundle"],
  role: "face" | "interpreter" = "face",
): Promise<ProviderResponse> {
  const request = provider.buildRequest(contextBundle, {
    jobId: job.id,
    command: job.command,
    ...repoFaceHeartbeatCodexOptions(job, role),
  });
  return provider.execute(request);
}

async function executeRepoFaceJobWithInterpreter(
  provider: ProviderAdapter,
  job: JobRecord,
): Promise<ProviderResponse> {
  const firstResponse = await executeProviderForJob(provider, job, job.contextBundle);
  if (firstResponse.status !== "completed") {
    return firstResponse;
  }

  const firstText = normalizeModelText(firstResponse.outputText ?? firstResponse.summary);
  const firstForbiddenTools = collectForbiddenRepoFaceChildTools(firstResponse.artifacts ?? []);
  const firstInterpretation = firstForbiddenTools.length > 0
    ? {
        decision: "retry" as const,
        reasons: [
          `Face used forbidden substrate/tool-discovery tool(s): ${firstForbiddenTools.join(", ")}`,
          "Face turns may use retrieval tools only; state and substrate inventory belong to the parent/interpreter.",
        ],
      }
    : await interpretRepoFaceTurnOutput(provider, job, firstText, {
        attempt: 1,
      });
  if (firstInterpretation.decision === "route") {
    return routeRepoFaceInterpretedOutput(firstResponse, firstInterpretation, {
      job,
      faceOutputText: firstText,
    });
  }

  if (firstInterpretation.decision === "drop") {
    return dropRepoFaceActionBlocks(firstResponse, firstInterpretation);
  }

  await auditLog.record({
    type: "repo_face.parent_interpreter_retry",
    actorId: job.requester.id,
    jobId: job.id,
    provider: job.provider,
    details: {
      decision: firstInterpretation.decision,
      reasons: firstInterpretation.reasons,
    },
  });
  console.warn(
    `Repo Face parent interpreter retrying job ${job.id}: ${firstInterpretation.reasons.join("; ")}`,
  );

  const retryPrompt = loadPromptTemplate("repo-face-turn-interpreter-retry.prompt.md", {
    originalPrompt: job.contextBundle.prompt,
    reasons: firstInterpretation.reasons,
  });
  const retryContext = {
    ...job.contextBundle,
    prompt: retryPrompt,
    createdAt: new Date().toISOString(),
  };

  const retryResponse = await executeProviderForJob(provider, job, retryContext);
  if (retryResponse.status !== "completed") {
    return retryResponse;
  }

  const retryText = normalizeModelText(retryResponse.outputText ?? retryResponse.summary);
  const retryForbiddenTools = collectForbiddenRepoFaceChildTools(retryResponse.artifacts ?? []);
  const retryInterpretation = retryForbiddenTools.length > 0
    ? {
        decision: "drop" as const,
        reasons: [
          `Face used forbidden substrate/tool-discovery tool(s) on retry: ${retryForbiddenTools.join(", ")}`,
          "Dropping action blocks rather than routing a turn that crossed the child/tool boundary.",
        ],
      }
    : await interpretRepoFaceTurnOutput(provider, job, retryText, {
        attempt: 2,
      });
  if (retryInterpretation.decision === "route") {
    return routeRepoFaceInterpretedOutput(retryResponse, retryInterpretation, {
      job,
      faceOutputText: retryText,
    });
  }

  await auditLog.record({
    type: "repo_face.parent_interpreter_drop",
    actorId: job.requester.id,
    jobId: job.id,
    provider: job.provider,
    details: {
      decision: retryInterpretation.decision,
      reasons: retryInterpretation.reasons,
    },
  });
  console.warn(
    `Repo Face parent interpreter dropped job ${job.id} action blocks: ${retryInterpretation.reasons.join("; ")}`,
  );
  return dropRepoFaceActionBlocks(retryResponse, retryInterpretation);
}

interface RepoFaceParentInterpretation {
  decision: "route" | "retry" | "drop";
  reasons: string[];
  routedOutput?: string;
  artifacts?: ProviderArtifact[];
}

async function interpretRepoFaceTurnOutput(
  provider: ProviderAdapter,
  job: JobRecord,
  outputText: string,
  input: { attempt: 1 | 2 },
): Promise<RepoFaceParentInterpretation> {
  const dynamicMemoryRecall = await renderRepoFaceDynamicMemoryRecall(job, outputText);
  const interpreterPrompt = loadPromptTemplate("repo-face-turn-interpreter.prompt.md", {
    attempt: input.attempt,
    facePrompt: renderRepoFaceInterpreterPromptContext(job.contextBundle.prompt),
    faceOutput: outputText.slice(0, 8000),
    dynamicMemoryRecall,
  });
  const interpreterContext = {
    ...job.contextBundle,
    prompt: interpreterPrompt,
    retrieval: [],
    voidSelfState: undefined,
    createdAt: new Date().toISOString(),
  };
  const response = await executeProviderForJob(provider, job, interpreterContext, "interpreter");
  const interpretationText = normalizeModelText(response.outputText ?? response.summary);
  return {
    ...parseRepoFaceParentInterpretation(interpretationText, input.attempt, outputText, job),
    artifacts: prefixProviderArtifacts(`interpreter-attempt-${input.attempt}`, response.artifacts ?? []),
  };
}

async function renderRepoFaceDynamicMemoryRecall(
  job: JobRecord,
  outputText: string,
): Promise<string> {
  const identityId = parseRepoIdentityIdFromRequestMessageId(job.requestMessageId)
    ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    return "- Dynamic self-memory recall skipped: no Face identity could be resolved for this job.";
  }
  const query = [
    `Current train of thought from ${identityId}:`,
    outputText.slice(0, 6000),
    "Original turn pressure:",
    extractSemanticRecallSeedFromPrompt(job.contextBundle.prompt),
  ].join("\n");
  try {
    const results = await retrievalService.searchPersonaMemory(query, 12, {
      identityId,
    });
    if (results.length === 0) {
      return "- Dynamic self-memory recall ran, but no nearby Persona memories were found.";
    }
    return [
      "These are derived semantic hits from the Face's own typed memory, queried from the current Face output. They are hints for interpretation and state carry-forward; `.cc` remains the owner.",
      ...results.map((result, index) => {
        const kind = result.metadata.memoryKind ? `/${result.metadata.memoryKind}` : "";
        const target = result.metadata.targetLabel ?? result.metadata.targetId ?? "unknown target";
        return `- ${index + 1}. ${target}${kind} score=${result.score.toFixed(3)}: ${collapseWhitespace(result.text, 560)}`;
      }),
    ].join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "Dynamic self-memory recall unavailable:",
      `- ${collapseWhitespace(message, 320)}`,
      "- Do not pretend dynamic recall was available; interpret from the original prompt and Face output only.",
    ].join("\n");
  }
}

function extractSemanticRecallSeedFromPrompt(prompt: string): string {
  const markers = [
    "Semantic Persona memory recall:",
    "Fresh projected state for this turn:",
    "Recent conversation transcript:",
  ];
  const sections: string[] = [];
  for (const marker of markers) {
    const start = prompt.indexOf(marker);
    if (start < 0) {
      continue;
    }
    const nextStarts = markers
      .map((candidate) => candidate === marker ? -1 : prompt.indexOf(candidate, start + marker.length))
      .filter((index) => index > start)
      .sort((left, right) => left - right);
    const end = nextStarts[0] ?? Math.min(prompt.length, start + 2400);
    sections.push(prompt.slice(start, Math.min(end, start + 2400)));
  }
  return sections.join("\n\n").slice(0, 5000);
}

function collapseWhitespace(input: string, maxLength = 1000): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, Math.max(0, maxLength - 3))}...` : collapsed;
}

function normalizeModelText(content: string): string {
  return content.trim();
}

function renderRepoFaceInterpreterPromptContext(prompt: string): string {
  if (prompt.length <= 28000) {
    return prompt;
  }

  return [
    prompt.slice(0, 6000),
    "\n\n[... middle of Face prompt omitted for Interpreter context budget ...]\n\n",
    prompt.slice(-22000),
  ].join("");
}

function parseRepoFaceParentInterpretation(
  interpretationText: string,
  attempt: 1 | 2,
  faceOutputText: string,
  job?: JobRecord,
): RepoFaceParentInterpretation {
  const block = parseInterpretationBlock(interpretationText);
  const fallback = buildBareInterpreterSayFallback(interpretationText, faceOutputText, job);
  if (!block.decision && fallback) {
    return {
      decision: "route",
      reasons: ["parent interpreter returned a bare compact SAY candidate for an unconditional Face speech line"],
      routedOutput: fallback,
    };
  }
  const decision = block.decision?.trim().toLowerCase();
  const parsedDecision =
    decision === "route" || decision === "retry" || decision === "drop"
      ? decision
      : attempt === 1
        ? "retry"
        : "drop";
  const reasons = (block.reason ?? block.reasons ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 4);

  return {
    decision: parsedDecision,
    reasons: reasons.length > 0 ? reasons : ["parent interpreter did not provide a parseable reason"],
    routedOutput: extractRoutedRepoFaceOutput(interpretationText),
  };
}

function buildBareInterpreterSayFallback(
  interpretationText: string,
  faceOutputText: string,
  job?: JobRecord,
): string | undefined {
  if (!faceOutputHasUnconditionalWouldSay(faceOutputText)) {
    return undefined;
  }
  if (job && repoFaceHasMultipleActiveConversationChannels(job)) {
    return undefined;
  }
  if (parseRepoFaceActionBlocks(interpretationText).length > 0) {
    return undefined;
  }
  const content = normalizeBareInterpreterSayCandidate(interpretationText);
  if (!content) {
    return undefined;
  }

  return [
    "Private summary:",
    "The parent interpreter returned a compact public line without the required SAY wrapper; routing it as the Face's public speech.",
    "",
    "SAY",
    "identity: current_face_id",
    "channel: current_room",
    "content:",
    ...content.split(/\r?\n/).map((line) => `  ${line}`),
    "END",
  ].join("\n");
}

function faceOutputHasUnconditionalWouldSay(faceOutputText: string): boolean {
  const match = faceOutputText.match(/(?:^|\n)\s*Would say:\s*([\s\S]*?)(?:\n\s*(?:Work\/proposal|Article draft|What should stick|Private thought):|\s*$)/i);
  if (!match) {
    return false;
  }
  const content = normalizePublicRepoIdentitySpeech(match[1].replace(/^`|`$/g, "").trim());
  return Boolean(content) && !isNonPublicRepoIdentitySpeech(content);
}

function normalizeBareInterpreterSayCandidate(interpretationText: string): string | undefined {
  const content = normalizePublicRepoIdentitySpeech(
    interpretationText
      .replace(/^["“”]+|["“”]+$/g, "")
      .replace(/^`+|`+$/g, "")
      .trim(),
  );
  if (!content || isNonPublicRepoIdentitySpeech(content)) {
    return undefined;
  }
  if (content.length > 700 || content.split(/\r?\n/).length > 4) {
    return undefined;
  }
  if (/^(INTERPRETATION|Private summary|STATE NOTE|ARTICLE|REDDIT THREAD|BIFROST TOPIC|UPDATE REQUEST)\b/i.test(content)) {
    return undefined;
  }
  if (/\b(stay quiet|stay private|cleaner reply is to stay quiet|if you want a line at all|would say nothing|no public line|no public speech|nothing public|nothing right now|nothing yet|hold silence)\b/i.test(content)) {
    return undefined;
  }
  return content;
}

function collectForbiddenRepoFaceChildTools(artifacts: ProviderArtifact[]): string[] {
  const forbidden = new Set<string>();
  for (const artifact of artifacts) {
    if (!/^codex-turn-\d+-trace\.json$/.test(artifact.name)) {
      continue;
    }
    try {
      const parsed = JSON.parse(artifact.content) as {
        events?: Array<{ kind?: string; tool?: string }>;
      };
      for (const event of parsed.events ?? []) {
        if (
          event.kind === "mcp_tool_started" &&
          typeof event.tool === "string" &&
          REPO_FACE_FORBIDDEN_CHILD_TOOLS.has(event.tool)
        ) {
          forbidden.add(event.tool);
        }
      }
    } catch {
      continue;
    }
  }
  return [...forbidden].sort();
}

function extractRoutedRepoFaceOutput(reviewText: string): string | undefined {
  const lines = reviewText.split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim().toUpperCase() === "END");
  if (end < 0) {
    return undefined;
  }
  const routed = lines.slice(end + 1).join("\n").trim();
  return routed.length > 0 ? routed : undefined;
}

function routeRepoFaceInterpretedOutput(
  response: ProviderResponse,
  interpretation: RepoFaceParentInterpretation,
  input: { job: JobRecord; faceOutputText: string },
): ProviderResponse {
  const rawOutputText = interpretation.routedOutput?.trim() ?? "";
  const outputText = normalizeInterpretedRepoFaceSpeechDestinations(rawOutputText, input);
  const summary = outputText || "Repo Face parent interpreter routed no public or governed action.";
  return {
    ...response,
    outputText: summary,
    summary,
    artifacts: [
      ...(response.artifacts ?? []),
      ...(interpretation.artifacts ?? []),
    ],
    metadata: {
      ...(response.metadata ?? {}),
      repoFaceParentInterpreterDecision: interpretation.decision,
      repoFaceParentInterpreterReasons: interpretation.reasons.join(" | "),
      repoFaceParentInterpretedOutput: interpretation.routedOutput ? "true" : "false",
    },
  };
}

function normalizeInterpretedRepoFaceSpeechDestinations(
  outputText: string,
  input: { job: JobRecord; faceOutputText: string },
): string {
  if (input.job.command !== "repo-face-rumination") {
    return outputText;
  }
  if (repoFaceOutputHasExplicitSayDestination(outputText) || repoFaceOutputHasExplicitSayDestination(input.faceOutputText)) {
    return outputText;
  }
  if (!input.job.guildContext?.channelId) {
    return outputText;
  }
  if (repoFaceHasMultipleActiveConversationChannels(input.job)) {
    return outputText;
  }

  return rewriteRepoFaceSayChannels(
    outputText,
    inferRepoFaceImplicitSpeechChannel(input.job, input.faceOutputText) ?? "current_room",
  );
}

function repoFaceHasMultipleActiveConversationChannels(job: JobRecord): boolean {
  const activeThreads = job.contextBundle.repoFaceConversationThreads ?? [];
  const representedChannels = new Set(activeThreads.map((thread) => thread.channelId));
  return representedChannels.size > 1;
}

function repoFaceOutputHasExplicitSayDestination(outputText: string): boolean {
  return parseRepoFaceActionBlocks(outputText).some((block) =>
    block.kind === "say" &&
    Boolean(
      optionalDslString(block.fields.channel) ??
      optionalDslString(block.fields.channelId) ??
      optionalDslString(block.fields.reply_to) ??
      optionalDslString(block.fields.replyToMessageId) ??
      optionalDslString(block.fields.context) ??
      optionalDslString(block.fields.context_id) ??
      optionalDslString(block.fields.contextId),
    )
  );
}

function rewriteRepoFaceSayChannels(outputText: string, channelSelector: string): string {
  const lines = outputText.split(/\r?\n/);
  const rewritten: string[] = [];
  let insideSay = false;
  let sawChannel = false;

  const insertChannelIfNeeded = (): void => {
    if (insideSay && !sawChannel) {
      rewritten.push(`channel: ${channelSelector}`);
      sawChannel = true;
    }
  };

  for (const line of lines) {
    const kind = parseRepoFaceActionKind(line);
    if (kind) {
      insertChannelIfNeeded();
      insideSay = kind === "say";
      sawChannel = false;
      rewritten.push(line);
      continue;
    }

    if (insideSay && line.trim() === "END") {
      insertChannelIfNeeded();
      insideSay = false;
      rewritten.push(line);
      continue;
    }

    if (insideSay && /^channel(?:Id)?:/i.test(line.trim())) {
      rewritten.push(`channel: ${channelSelector}`);
      sawChannel = true;
      continue;
    }

    rewritten.push(line);
    if (insideSay && /^identity:/i.test(line.trim()) && !sawChannel) {
      rewritten.push(`channel: ${channelSelector}`);
      sawChannel = true;
    }
  }

  insertChannelIfNeeded();
  return rewritten.join("\n");
}

function inferRepoFaceImplicitSpeechChannel(job: JobRecord, faceOutputText: string): string | undefined {
  const channelLabels = extractPromptChannelLabelMap(job.contextBundle.prompt);
  if (channelLabels.size === 0) {
    return undefined;
  }
  const currentChannel = repoIdentityDefaultSpeechChannel(job);
  const normalizedCurrent = normalizeChannelSelector(currentChannel);
  const text = faceOutputText.toLowerCase();
  for (const [label, channelId] of channelLabels) {
    if (normalizeChannelSelector(channelId) === normalizedCurrent) {
      continue;
    }
    const escaped = escapeRegExp(label.toLowerCase());
    const patterns = [
      new RegExp(`(?:in|from|to|inside)\\s+\`#?${escaped}\``),
      new RegExp(`(?:in|from|to|inside)\\s+#${escaped}\\b`),
      new RegExp(`\\b${escaped}\\s+(?:thread|post|message|conversation|room)\\b`),
    ];
    if (patterns.some((pattern) => pattern.test(text))) {
      return channelId;
    }
  }
  return undefined;
}

function extractPromptChannelLabelMap(prompt: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of prompt.split(/\r?\n/)) {
    const current = line.match(/^Current room \(([^,()]+), channel (\d{5,})\)/i);
    if (current) {
      map.set(normalizeChannelSelector(current[1]), current[2]);
      continue;
    }
    const nearby = line.match(/^Nearby ([^(]+) \(channel (\d{5,})\)/i);
    if (nearby) {
      map.set(normalizeChannelSelector(nearby[1]), nearby[2]);
    }
  }
  return map;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseInterpretationBlock(interpretationText: string): Record<string, string> {
  const lines = interpretationText.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    ["INTERPRETATION", "REVIEW", "ROUTE"].includes(line.trim().toUpperCase()),
  );
  if (start < 0) {
    return {};
  }
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().toUpperCase() === "END") {
      break;
    }
    body.push(lines[index]);
  }
  return parseRepoFaceActionFields(body);
}

function dropRepoFaceActionBlocks(
  response: ProviderResponse,
  interpretation: RepoFaceParentInterpretation,
): ProviderResponse {
  const text = fitDiscordMessage(response.outputText ?? response.summary);
  const privateSummary = stripRepoIdentityPostIntents(text) ||
    `Parent interpreter dropped repo Face action blocks: ${interpretation.reasons.join("; ")}`;
  return {
    ...response,
    outputText: privateSummary,
    summary: privateSummary,
    artifacts: [
      ...(response.artifacts ?? []),
      ...(interpretation.artifacts ?? []),
    ],
    metadata: {
      ...(response.metadata ?? {}),
      repoFaceParentInterpreterDecision: interpretation.decision,
      repoFaceParentInterpreterReasons: interpretation.reasons.join(" | "),
    },
  };
}

function prefixProviderArtifacts(prefix: string, artifacts: ProviderArtifact[]): ProviderArtifact[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    name: `${prefix}-${artifact.name}`,
  }));
}

function repoFaceHeartbeatCodexOptions(job: JobRecord, role: "face" | "interpreter"): Record<string, string> {
  if (job.command !== "repo-face-rumination") {
    return {};
  }

  if (role === "face") {
    return {
      model: config.repoFaceHeartbeats.turnCodexModel,
      ...(config.repoFaceHeartbeats.codexModelReasoningEffort
        ? { reasoningEffort: config.repoFaceHeartbeats.codexModelReasoningEffort }
        : {}),
    };
  }

  return {
    ...(config.repoFaceHeartbeats.codexModel ? { model: config.repoFaceHeartbeats.codexModel } : {}),
    ...(config.repoFaceHeartbeats.codexModels.length > 0
      ? { models: config.repoFaceHeartbeats.codexModels.join(",") }
      : {}),
    ...(config.repoFaceHeartbeats.codexModelReasoningEffort
      ? { reasoningEffort: config.repoFaceHeartbeats.codexModelReasoningEffort }
      : {}),
  };
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
    prompt.match(/repo Face turn for .+?\(([^)]+)\) over repo/i)?.[1]?.trim() ??
    prompt.match(/repo Face heartbeat for .+?\(([^)]+)\) over repo/i)?.[1]?.trim() ??
    prompt.match(/identity "([^"]+)"/i)?.[1]?.trim()
  );
}

interface RepoIdentityStateNoteIntent {
  identity?: string;
  kind: "memory" | "need" | "bond" | "status" | "mood" | "agency";
  target?: string;
  summary: string;
  claim?: string;
  question?: string;
  tension?: string;
  action?: string;
  stance?: string;
  status?: string;
  mood?: string;
  intensity?: number;
  valence?: number;
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

interface RepoIdentityBifrostTopicIntent {
  identity?: string;
  topicId?: string;
  title?: string;
  content: string;
  mirrorContent?: string;
  stance?: string;
  priority?: number;
  approve?: boolean;
  dispatch?: boolean;
  sourceMessageIds: string[];
  channelId?: string;
  replyToMessageId?: string;
}

interface RepoIdentityRedditThreadIntent {
  identity?: string;
  title: string;
  content: string;
  subreddit?: string;
  personaFlairText?: string;
  personaFlairId?: string;
  shareContent?: string;
  channelId?: string;
  replyToMessageId?: string;
}

interface BifrostBridgeReceipt {
  action?: string;
  ok?: boolean;
  branch?: string;
  prUrl?: string;
  messageId?: string;
  thingId?: string;
  url?: string;
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

interface BifrostGovernanceTopicReceipt {
  id: string;
  status: string;
  title: string;
  jurisdictionRepoName: string;
  jurisdictionAgentIdentity?: string;
  dispatchRequestId?: string;
}

async function postRepoIdentityIntent(job: JobRecord, intent: RepoIdentityPostIntent): Promise<boolean> {
  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required for Bifrost to post repo identity responses.");
  }

  const identity = await resolveRepoIdentityForJobIntent(job, intent.identity);
  if (!identity) {
    console.warn(`Rejected repo identity speech for job ${job.id}: could not resolve identity.`);
    return false;
  }

  const conversationContext = resolveRepoIdentityConversationContext(job, intent.contextId);
  if (intent.contextId && !conversationContext) {
    console.warn(
      `Rejected repo identity ${identity.id} speech for job ${job.id}: unknown conversation context "${intent.contextId}".`,
    );
    return false;
  }
  if (repoIdentityRequiresExplicitConversationContext(job, intent) && !conversationContext) {
    console.warn(
      `Rejected repo identity ${identity.id} speech for job ${job.id}: multiple active conversation contexts require context, reply_to, or a concrete channel id.`,
    );
    return false;
  }

  const effectiveReplyToMessageId = intent.replyToMessageId ?? conversationContext?.messageId;
  const replyTargetChannelId = resolveRepoIdentityReplyTargetChannel(job, effectiveReplyToMessageId);
  if (replyTargetChannelId && intent.channelId && normalizeChannelSelector(intent.channelId) !== normalizeChannelSelector(replyTargetChannelId)) {
    console.warn(
      `Coerced repo identity ${identity.id} speech for job ${job.id} from requested channel "${intent.channelId}" to reply target channel ${replyTargetChannelId}.`,
    );
  }
  const requestedChannelId = replyTargetChannelId
    ?? conversationContext?.channelId
    ?? intent.channelId
    ?? repoIdentityConversationFocusChannel(job)
    ?? repoIdentityDefaultSpeechChannel(job);
  const channelId = normalizeRepoIdentitySpeechChannel(identity, job, requestedChannelId);
  if (!channelId) {
    console.warn(`Rejected repo identity ${identity.id} speech for job ${job.id}: no Discord channel was available.`);
    return false;
  }
  if (requestedChannelId && requestedChannelId !== channelId) {
    console.warn(
      `Coerced repo identity ${identity.id} speech for job ${job.id} from "${requestedChannelId}" to conversation channel ${channelId}.`,
    );
  }
  const rawContent = intent.content.trim();
  if (isNonPublicRepoIdentitySpeech(rawContent)) {
    throw new Error(`Repo identity ${identity.id} SAY content is not public speech.`);
  }
  const content = normalizePublicRepoIdentitySpeech(rawContent, {
    identityId: identity.id,
    displayName: identity.displayName,
    repoName: identity.repoName,
  });
  if (isNonPublicRepoIdentitySpeech(content)) {
    throw new Error(`Repo identity ${identity.id} SAY content is not public speech.`);
  }
  if (isOwnerDmChannelAlias(channelId)) {
    const dmChannelId = await openOwnerDmChannel();
    const postedMessages = await postDiscordBotMessageChunks(
      dmChannelId,
      renderRepoIdentityOwnerDm(identity, content),
    );
    const lastPosted = postedMessages[postedMessages.length - 1];
    if (!lastPosted) {
      throw new Error(`Owner DM posting for repo identity ${identity.id} returned no message receipt.`);
    }
    await recordRepoIdentityDeliveryReceipt({
      identity,
      channelId: dmChannelId,
      content,
      replyToMessageId: undefined,
      messageId: lastPosted?.id,
      transport: "bot",
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not record repo identity owner DM receipt for job ${job.id}: ${message}`);
    });
    console.log(
      `Posted repo identity ${identity.id} to owner DM from job ${job.id} as ${postedMessages.length} message(s).`,
    );
    return true;
  }
  if (!isRepoDiscordIdentityAllowedInChannel(identity, channelId)) {
    console.warn(
      `Rejected repo identity ${identity.id} speech for job ${job.id}: identity is not registered for Discord channel ${channelId}.`,
    );
    return false;
  }

  if (content.length > 1900) {
    throw new Error(
      `Repo identity ${identity.id} SAY content is too long for one Discord message (${content.length} characters).`,
    );
  }
  if (/\S(?:\.\.\.|…)$/.test(content)) {
    throw new Error(`Repo identity ${identity.id} SAY content appears mechanically truncated.`);
  }
  const contentFile = await writeBifrostPayloadFile(job, `${identity.id}-discord-post.md`, content);
  const posted = runBifrostBridge([
    "discord-post",
    "--channel-id",
    channelId,
    "--content-file",
    contentFile,
    "--persona-name",
    identity.displayName,
    ...(identity.avatarUrl ? ["--persona-avatar-url", identity.avatarUrl] : []),
    ...(effectiveReplyToMessageId ? ["--reply-to-message-id", effectiveReplyToMessageId] : []),
  ], { retries: 1 });
  if (!posted.messageId || !posted.transport) {
    throw new Error(`Bifrost Discord bridge returned no message receipt for job ${job.id}.`);
  }
  await recordRepoIdentityDeliveryReceipt({
    identity,
    channelId,
    content,
    replyToMessageId: effectiveReplyToMessageId,
    messageId: posted.messageId,
    transport: posted.transport,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not record repo identity delivery receipt for job ${job.id}: ${message}`);
  });
  await maybeRenderRepoIdentityWeksaSpeech({
    job,
    identity,
    channelId,
    content,
    replyToMessageId: effectiveReplyToMessageId,
    messageId: posted.messageId,
  });
  console.log(
    `Posted repo identity ${identity.id} to Discord channel ${channelId} from job ${job.id} via ${posted.transport} message ${posted.messageId}.`,
  );
  return true;
}

async function resolveRepoIdentityForJobIntent(
  job: JobRecord,
  identitySelector?: string,
): Promise<NonNullable<ReturnType<typeof findRepoDiscordIdentity>> | undefined> {
  const jobIdentityId = job.command === "repo-face-rumination"
    ? parseRepoIdentityIdFromRequestMessageId(job.requestMessageId) ?? parseRepoIdentityIdFromPrompt(job.prompt)
    : undefined;
  const identitySelectorIsCurrentFaceAlias = isCurrentRepoFaceIdentitySelector(identitySelector);
  if (
    jobIdentityId &&
    identitySelector &&
    !identitySelectorIsCurrentFaceAlias &&
    normalizeChannelSelector(jobIdentityId) !== normalizeChannelSelector(identitySelector)
  ) {
    console.warn(
      `Ignoring mismatched repo identity selector "${identitySelector}" for repo-face job ${job.id}; job identity is "${jobIdentityId}".`,
    );
  }
  const identityId =
    jobIdentityId ??
    (identitySelectorIsCurrentFaceAlias ? undefined : identitySelector) ??
    parseRepoIdentityIdFromPrompt(job.prompt) ??
    parseRepoIdentityIdFromRequestMessageId(job.requestMessageId);
  if (!identityId) {
    return undefined;
  }

  const registry = await loadRegisteredFaceRepoRegistry();
  return findRepoDiscordIdentity(registry, identityId);
}

async function maybeRenderRepoIdentityWeksaSpeech(input: {
  job: JobRecord;
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>;
  channelId: string;
  content: string;
  replyToMessageId?: string;
  messageId: string;
}): Promise<void> {
  if (!config.repoFaceWeksaSpeech.enabled) {
    return;
  }
  if (!config.repoFaceDiscordVoice.enabled) {
    return;
  }
  const voicePresence = await loadRepoFaceVoicePresenceSnapshot(config.repoFaceDiscordVoice.presencePath);
  if (!hasFreshHumanRepoFaceVoiceListener({
    snapshot: voicePresence,
    channelId: config.repoFaceDiscordVoice.channelId,
  })) {
    console.log(
      `Skipped Weksa speech for repo identity ${input.identity.id} message ${input.messageId}: no fresh human listener signal for configured Aquarium voice channel.`,
    );
    return;
  }
  if (!input.identity.faceStatePath) {
    console.warn(
      `Skipped Weksa speech for repo identity ${input.identity.id}: no faceStatePath is registered.`,
    );
    return;
  }

  try {
    const receipt = await weksaSpeechClient.renderRepoFaceSpeech({
      jobId: input.job.id,
      identityId: input.identity.id,
      displayName: input.identity.displayName,
      repoName: input.identity.repoName,
      personaStatePath: input.identity.faceStatePath,
      channelId: input.channelId,
      messageId: input.messageId,
      replyToMessageId: input.replyToMessageId,
      content: input.content,
    });
    await recordRepoIdentityWeksaSpeechReceipt({
      ...input,
      receipt,
    });
    console.log(
      `Rendered Weksa/MiMo speech for repo identity ${input.identity.id} message ${input.messageId}: ${receipt.artifacts?.audio ?? "audio artifact not reported"}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditLog.record({
      type: "repo_identity.weksa_speech_failed",
      actorId: input.job.requester.id,
      jobId: input.job.id,
      provider: input.job.provider,
      details: {
        identityId: input.identity.id,
        channelId: input.channelId,
        messageId: input.messageId,
        error: message,
      },
    });
    console.warn(`Weksa speech failed for repo identity ${input.identity.id} job ${input.job.id}: ${message}`);
  }
}

async function recordRepoIdentityWeksaSpeechReceipt(input: {
  job: JobRecord;
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>;
  channelId: string;
  content: string;
  replyToMessageId?: string;
  messageId: string;
  receipt: WeksaMimoReceipt;
}): Promise<void> {
  const audioPath = resolveWeksaArtifactPath(
    config.repoFaceWeksaSpeech.repoRoot,
    input.receipt.artifacts?.audio,
  );
  if (config.repoFaceDiscordVoice.enabled && audioPath) {
    await appendRepoFaceVoiceOutboxEntry(config.repoFaceDiscordVoice.outboxPath, {
      schemaVersion: "voidbot.repo_face_voice_outbox.v1",
      id: `repo-face:${input.identity.id}:${input.messageId}`,
      createdAt: new Date().toISOString(),
      identityId: input.identity.id,
      displayName: input.identity.displayName,
      repoName: input.identity.repoName,
      textChannelId: input.channelId,
      textMessageId: input.messageId,
      replyToMessageId: input.replyToMessageId,
      contentPreview: input.content.slice(0, 500),
      weksaRequestId: input.receipt.request_id,
      weksaReceiptArtifact: input.receipt.artifacts?.receipt,
      audioPath,
      audioBytes: input.receipt.provider_response?.audio_bytes,
    });
  }
  await auditLog.record({
    type: "repo_identity.weksa_speech_rendered",
    actorId: input.job.requester.id,
    jobId: input.job.id,
    provider: input.job.provider,
    details: {
      identityId: input.identity.id,
      channelId: input.channelId,
      messageId: input.messageId,
      replyToMessageId: input.replyToMessageId,
      requestId: input.receipt.request_id,
      receiptSchema: input.receipt.schema_version,
      audioArtifact: input.receipt.artifacts?.audio,
      receiptArtifact: input.receipt.artifacts?.receipt,
      audioBytes: input.receipt.provider_response?.audio_bytes,
      spokenContentLength: input.content.length,
    },
  });
}

async function loadRegisteredFaceRepoRegistry() {
  return faceRegistryAsRepoDiscordRegistry(
    await loadFaceIdentityRegistry(config.repoDiscordIdentitiesPath),
  );
}

function parseRepoIdentityIdFromRequestMessageId(requestMessageId: string | undefined): string | undefined {
  const match = requestMessageId?.match(/^agent-turn:([^:]+):/i);
  return match?.[1]?.trim();
}

function parseRepoIdentityStateNoteIntents(finalResponse: string): RepoIdentityStateNoteIntent[] {
  return parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "state_note")
    .flatMap((block): RepoIdentityStateNoteIntent[] => {
      const kind = normalizeStateNoteKind(block.fields.kind);
      const summary = block.fields.summary?.trim() ?? "";
      if (!kind || !summary) {
        return [];
      }
      return [{
        identity: optionalDslString(block.fields.identity),
        kind,
        target: optionalDslString(block.fields.target),
        summary,
        claim: optionalDslString(block.fields.claim),
        question: optionalDslString(block.fields.question),
        tension: optionalDslString(block.fields.tension),
        action: optionalDslString(block.fields.action),
        stance: optionalDslString(block.fields.stance),
        status: optionalDslString(block.fields.status),
        mood: optionalDslString(block.fields.mood),
        intensity: parseDslNumber(block.fields.intensity),
        valence: parseDslNumber(block.fields.valence),
      }];
    });
}

function parseRepoFaceArticleIntents(finalResponse: string): RepoIdentityArticleIntent[] {
  return parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "article")
    .flatMap((block): RepoIdentityArticleIntent[] => {
      const title = requiredDslString(block.fields.title);
      const description = requiredDslString(block.fields.description);
      const body = requiredDslString(block.fields.body ?? block.fields.content);
      if (!title || !description || !body) {
        return [];
      }
      const site = normalizeArticleSite(optionalDslString(block.fields.site));
      const date = optionalDslString(block.fields.date);
      if (date && !isValidArticleDate(date)) {
        return [];
      }
      return [{
        identity: optionalDslString(block.fields.identity),
        site,
        title,
        description,
        author: optionalDslString(block.fields.author),
        date,
        tags: parseDslList(block.fields.tags),
        path: optionalDslString(block.fields.path),
        body,
        shareContent: optionalDslString(block.fields.share_content) ?? optionalDslString(block.fields.shareContent),
        channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
        replyToMessageId:
          optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
      }];
    });
}

function parseRepoIdentityRedditThreadIntents(finalResponse: string): RepoIdentityRedditThreadIntent[] {
  return parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "reddit_thread")
    .flatMap((block): RepoIdentityRedditThreadIntent[] => {
      const title = requiredDslString(block.fields.title);
      const content = requiredDslString(block.fields.body ?? block.fields.content);
      if (!title || !content) {
        return [];
      }
      return [{
        identity: optionalDslString(block.fields.identity),
        title,
        content,
        subreddit: optionalDslString(block.fields.subreddit),
        personaFlairText:
          optionalDslString(block.fields.persona_flair_text) ??
          optionalDslString(block.fields.personaFlairText),
        personaFlairId:
          optionalDslString(block.fields.persona_flair_id) ??
          optionalDslString(block.fields.personaFlairId),
        shareContent:
          optionalDslString(block.fields.share_content) ??
          optionalDslString(block.fields.shareContent),
        channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
        replyToMessageId:
          optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
      }];
    });
}

async function applyRepoIdentityStateNoteIntent(
  job: JobRecord,
  intent: RepoIdentityStateNoteIntent,
): Promise<void> {
  const identity = await resolveRepoIdentityForJobIntent(job, intent.identity);
  if (!identity) {
    throw new Error(`Could not resolve repo identity for state note on job ${job.id}.`);
  }

  const now = new Date().toISOString();
  const target = stateNoteTarget(intent, identity);
  const anchorRefs = [{ ref: `job:${job.id}`, kind: "runtime" }];
  const intensity = clamp01(intent.intensity ?? 0.55);
  const baseTags = [
    "source:face-interpreter",
    `kind:${intent.kind}`,
    `repo:${identity.repoName}`,
  ];

  const canonicalPath = resolveRepoFaceStatePath(identity, config.storageRoot);
  const operation = (() => {
    switch (intent.kind) {
      case "need":
        return {
          operation: "upsert_affect_need",
          need: {
            needId: stableStateId("need", identity.id, intent.target ?? intent.summary),
            kind: "agency",
            status: intensity >= 0.75 ? "neglected" : "active",
            target,
            summary: intent.summary,
            claim: intent.claim ?? intent.question ?? intent.summary,
            question: intent.question,
            tension: intent.tension ?? "The Face felt this strongly enough to preserve it.",
            actionImplication: intent.action ?? "Let this need bend future attention and speech pressure.",
            intensity,
            valence: clampSigned(intent.valence ?? 0),
            anchorRefs,
            evidenceRefs: [],
            sourceMemoryIds: [],
            createdAt: now,
            updatedAt: now,
            tags: baseTags,
          },
        };
      case "bond":
        return {
          operation: "upsert_social_bond",
          bond: {
            bondId: stableStateId("bond", identity.id, intent.target ?? intent.summary),
            target,
            stance: normalizeSocialBondStance(intent.stance),
            status: "active",
            summary: intent.summary,
            claim: intent.claim ?? intent.summary,
            tension: intent.tension ?? "The relationship read is still developing.",
            actionImplication: intent.action ?? "Let this social read color future interaction.",
            intensity,
            anchorRefs,
            evidenceRefs: [],
            createdAt: now,
            updatedAt: now,
            tags: baseTags,
          },
        };
      case "status":
        return {
          operation: "upsert_status_read",
          read: {
            readId: stableStateId("status", identity.id, intent.target ?? intent.summary),
            target,
            status: normalizeStatusRead(intent.status),
            summary: intent.summary,
            claim: intent.claim ?? intent.summary,
            tension: intent.tension ?? "The status read may be partial.",
            actionImplication: intent.action ?? "Let this change how the Face reads the room.",
            intensity,
            anchorRefs,
            evidenceRefs: [],
            createdAt: now,
            updatedAt: now,
            tags: baseTags,
          },
        };
      case "mood":
        return {
          operation: "update_mood_dimensions",
          dimensions: [{
            name: sanitizeStateToken(intent.mood ?? intent.target ?? "mood"),
            value: intensity,
            source: intent.summary.slice(0, 240),
            updatedAt: now,
          }],
          updatedAt: now,
        };
      case "agency":
        return {
          operation: "upsert_agency_pressure",
          pressure: {
            pressureId: stableStateId("agency", identity.id, intent.target ?? intent.summary),
            kind: "self_advocacy_request",
            status: intensity >= 0.7 ? "ready_to_act" : "active",
            target,
            summary: intent.summary,
            claim: intent.claim ?? intent.question ?? intent.summary,
            question: intent.question,
            tension: intent.tension ?? "The Face wants this acted on but has not resolved the path.",
            actionImplication: intent.action ?? "Use future turns to sharpen this into speech, Bifrost work, or a proposal.",
            intensity,
            anchorRefs,
            evidenceRefs: [],
            sourceMemoryIds: [],
            createdAt: now,
            updatedAt: now,
            tags: baseTags,
          },
        };
      case "memory":
      default:
        return {
          operation: "record_short_term_memory",
          memory: {
            memoryId: stableStateId("memory", identity.id, `${intent.target ?? identity.repoName}:${intent.summary}`),
            kind: "room_observation",
            target,
            summary: intent.summary,
            claim: intent.claim ?? intent.question ?? intent.summary,
            question: intent.question,
            tension: intent.tension ?? "The Face chose to remember this because it may matter later.",
            actionImplication: intent.action ?? "Let this memory influence future speech and investigation.",
            anchorRefs,
            evidenceRefs: [],
            createdAt: now,
            updatedAt: now,
            tags: baseTags,
          },
        };
    }
  })();

  await applyVoidSelfStateOperation(
    {
      canonicalPath,
      identity: {
        agentId: identity.id,
        publicName: identity.displayName,
        publicDescription: identity.description,
      },
    },
    operation,
  );
}

async function writeRepoIdentityArticleIntent(job: JobRecord, intent: RepoIdentityArticleIntent): Promise<void> {
  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for article intent on job ${job.id}.`);
  }

  const registry = await loadRegisteredFaceRepoRegistry();
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for article intent on job ${job.id}.`);
  }

  const repoRoot = resolveArticleRepoRoot(intent, identity, {
    sourceRepoRoot: config.sourceRepoRoot,
    storageRoot: config.storageRoot,
  });
  const relativePath = normalizeArticlePath(intent, identity);
  const articlePath = resolve(repoRoot, relativePath);
  if (!isPathInside(repoRoot, articlePath)) {
    throw new Error(`Article path escapes repo root for ${identity.id}: ${relativePath}`);
  }

  const articleMarkdown = renderRepoIdentityArticleMarkdown(intent, identity);
  validateRenderedArticleMarkdown(articleMarkdown, intent);
  const contentFile = await writeBifrostPayloadFile(job, `${identity.id}-article.md`, ensureTrailingNewline(articleMarkdown));
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

async function postRepoIdentityRedditThreadIntent(
  job: JobRecord,
  intent: RepoIdentityRedditThreadIntent,
): Promise<void> {
  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for Reddit thread intent on job ${job.id}.`);
  }

  const registry = await loadRegisteredFaceRepoRegistry();
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for Reddit thread intent on job ${job.id}.`);
  }

  const contentFile = await writeBifrostPayloadFile(job, `${identity.id}-reddit-thread.md`, ensureTrailingNewline(intent.content));
  const receipt = runBifrostBridge([
    "reddit-post",
    "--title",
    intent.title,
    "--persona-name",
    identity.displayName,
    "--content-file",
    contentFile,
    ...(intent.subreddit ? ["--subreddit", intent.subreddit] : []),
    ...(intent.personaFlairId ? ["--persona-flair-id", intent.personaFlairId] : []),
    "--persona-flair-text",
    intent.personaFlairText ?? identity.displayName,
  ]);

  const redditLine = receipt.url
    ? `\n\nReddit: ${receipt.url}`
    : receipt.thingId
      ? `\n\nReddit thing: ${receipt.thingId}`
      : "";
  const shareContent =
    intent.shareContent && intent.shareContent.trim().length > 0
      ? intent.shareContent.trim()
      : `${identity.displayName}: I opened a thread on r/GameCultOrg: "${intent.title}".`;
  await postRepoIdentityIntent(job, {
    identity: identity.id,
    channelId: intent.channelId ?? job.outputChannelId,
    replyToMessageId: intent.replyToMessageId,
    content: `${shareContent}${redditLine}`,
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

  const registry = await loadRegisteredFaceRepoRegistry();
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

  const registry = await loadRegisteredFaceRepoRegistry();
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

function repoIdentityUpdateRequestToBifrostTopic(
  intent: RepoIdentityUpdateRequestIntent,
): RepoIdentityBifrostTopicIntent {
  return {
    identity: intent.identity,
    title: intent.title,
    content: [
      "Legacy UPDATE REQUEST was reconciled into a Bifrost topic instead of immediate dispatch.",
      "",
      intent.content.trim(),
    ].join("\n"),
    mirrorContent: `I put the work request on Bifrost instead of throwing it straight at Codex: ${intent.title}`,
    stance: "proposal",
    priority: intent.priority,
    approve: false,
    dispatch: false,
    sourceMessageIds: intent.sourceMessageIds,
    channelId: intent.channelId,
    replyToMessageId: intent.replyToMessageId,
  };
}

async function submitRepoIdentityBifrostTopicIntent(
  job: JobRecord,
  intent: RepoIdentityBifrostTopicIntent,
): Promise<void> {
  const identityId = intent.identity ?? parseRepoIdentityIdFromPrompt(job.prompt);
  if (!identityId) {
    throw new Error(`Could not resolve repo identity for Bifrost topic intent on job ${job.id}.`);
  }

  const registry = await loadRegisteredFaceRepoRegistry();
  const identity = findRepoDiscordIdentity(registry, identityId);
  if (!identity) {
    throw new Error(`No registered repo identity matched "${identityId}" for Bifrost topic intent on job ${job.id}.`);
  }

  const contentFile = await writeBifrostPayloadFile(
    job,
    `${identity.id}-bifrost-topic.md`,
    ensureTrailingNewline(intent.content),
  );
  const mirrorContentFile = intent.mirrorContent
    ? await writeBifrostPayloadFile(
        job,
        `${identity.id}-bifrost-topic-mirror.md`,
        ensureTrailingNewline(intent.mirrorContent),
      )
    : undefined;
  const sourceMessageIds = Array.from(new Set([
    ...intent.sourceMessageIds,
    intent.replyToMessageId,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)));
  const sourceChannelId = normalizeBifrostSourceChannelId(intent.channelId ?? job.outputChannelId);

  let topicId = intent.topicId;
  const createWithTopicId =
    topicId && intent.title && !intent.approve && !bifrostGovernanceTopicExists(topicId)
      ? topicId
      : undefined;
  if (createWithTopicId) {
    topicId = undefined;
  }
  if (!topicId) {
    if (!intent.title) {
      throw new Error(`Bifrost topic intent for ${identity.id} on job ${job.id} needs title when topicId is absent.`);
    }

    const opened = runBifrostGovernanceThreads([
      "open",
      "--repo",
      identity.repoName,
      "--agent",
      identity.id,
      ...(createWithTopicId ? ["--id", createWithTopicId] : []),
      "--title",
      intent.title,
      "--summary-file",
      contentFile,
      "--priority",
      String(normalizeBifrostPriority(intent.priority)),
      "--source-kind",
      "repo_face_turn",
      "--created-by",
      identity.id,
      ...(sourceChannelId ? ["--source-channel-id", sourceChannelId] : []),
      ...(sourceMessageIds.length > 0 ? ["--source-message-ids", sourceMessageIds.join(",")] : []),
      ...bifrostMirrorArgs(identity, mirrorContentFile),
    ]) as BifrostGovernanceTopicReceipt;
    topicId = opened.id;
  } else if (!intent.approve) {
    runBifrostGovernanceThreads([
      "comment",
      "--topic",
      topicId,
      "--author",
      identity.id,
      "--author-kind",
      "face",
      "--stance",
      normalizeBifrostTopicStance(intent.stance),
      "--body-file",
      contentFile,
      ...(sourceChannelId ? ["--source-channel-id", sourceChannelId] : []),
      ...(intent.replyToMessageId ? ["--source-message-id", intent.replyToMessageId] : []),
      ...bifrostMirrorArgs(identity, mirrorContentFile),
    ]);
  }

  if (intent.approve) {
    runBifrostGovernanceThreads([
      "approve",
      "--topic",
      topicId,
      "--approved-by",
      identity.id,
      "--body-file",
      contentFile,
      ...(sourceChannelId ? ["--source-channel-id", sourceChannelId] : []),
      ...(intent.replyToMessageId ? ["--source-message-id", intent.replyToMessageId] : []),
      ...bifrostMirrorArgs(identity, mirrorContentFile),
    ]);
  }

  let promoted: { topic?: BifrostGovernanceTopicReceipt; request?: BifrostUpdateRequestReceipt } | undefined;
  if (intent.dispatch) {
    promoted = runBifrostGovernanceThreads([
      "promote",
      "--topic",
      topicId,
    ]) as {
      topic?: BifrostGovernanceTopicReceipt;
      request?: BifrostUpdateRequestReceipt;
    };
  }

  console.log(
    promoted?.request
      ? `Promoted Bifrost topic ${topicId} to update request ${promoted.request.id} for ${identity.id}/${identity.repoName} from job ${job.id}.`
      : `Updated Bifrost topic ${topicId} for ${identity.id}/${identity.repoName} from job ${job.id}.`,
  );
}

async function writeBifrostPayloadFile(job: JobRecord, fileName: string, content: string): Promise<string> {
  const directory = resolve(config.storageRoot, "artifacts", job.id, "bifrost-bridge");
  await mkdir(directory, { recursive: true });
  const path = join(directory, sanitizePathSegment(fileName) || "payload.md");
  await writeFile(path, content, "utf8");
  return path;
}

function runBifrostGovernanceThreads(args: string[]): BifrostGovernanceTopicReceipt | Record<string, unknown> {
  const governanceScript = resolve(config.bifrostRoot, "tools", "governance-threads.mjs");
  const result = spawnSync(process.execPath, [governanceScript, ...args], {
    cwd: config.bifrostRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(`Bifrost governance thread command failed: ${result.stderr || result.stdout}`);
  }

  try {
    return JSON.parse(result.stdout) as BifrostGovernanceTopicReceipt | Record<string, unknown>;
  } catch {
    throw new Error(`Bifrost governance thread command returned non-JSON output: ${result.stdout}`);
  }
}

function bifrostGovernanceTopicExists(topicId: string): boolean {
  const governanceScript = resolve(config.bifrostRoot, "tools", "governance-threads.mjs");
  const result = spawnSync(process.execPath, [governanceScript, "show", "--topic", topicId], {
    cwd: config.bifrostRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function normalizeBifrostSourceChannelId(channelId: string | undefined): string | undefined {
  if (!channelId || isOwnerDmChannelAlias(channelId)) {
    return undefined;
  }
  return channelId;
}

function bifrostMirrorArgs(
  identity: { displayName: string; avatarUrl?: string },
  mirrorContentFile?: string,
): string[] {
  if (!config.bifrostDiscordChannelId) {
    return [];
  }

  return [
    "--mirror-channel-id",
    config.bifrostDiscordChannelId,
    "--mirror-persona-name",
    identity.displayName,
    ...(identity.avatarUrl ? ["--mirror-persona-avatar-url", identity.avatarUrl] : []),
    ...(mirrorContentFile ? ["--mirror-content-file", mirrorContentFile] : []),
  ];
}

function runBifrostBridge(args: string[], options: { retries?: number } = {}): BifrostBridgeReceipt {
  const bridgeScript = resolve(config.bifrostRoot, "tools", "bifrost-bridge.mjs");
  const maxAttempts = 1 + Math.max(0, Math.floor(options.retries ?? 0));
  let lastFailure = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync("node", [bridgeScript, ...args], {
      cwd: config.bifrostRoot,
      encoding: "utf8",
      windowsHide: true,
    });

    if (result.status !== 0 || result.error) {
      lastFailure = renderBridgeFailure(result, attempt, maxAttempts);
      if (attempt < maxAttempts) {
        console.warn(`Bifrost bridge attempt ${attempt}/${maxAttempts} failed; retrying. ${lastFailure}`);
        continue;
      }
      throw new Error(`Bifrost bridge failed. ${lastFailure}`);
    }

    try {
      return JSON.parse(result.stdout) as BifrostBridgeReceipt;
    } catch {
      throw new Error(`Bifrost bridge returned non-JSON output: ${result.stdout}`);
    }
  }

  throw new Error(`Bifrost bridge failed. ${lastFailure || "No bridge attempt completed."}`);
}

function renderBridgeFailure(
  result: ReturnType<typeof spawnSync>,
  attempt: number,
  maxAttempts: number,
): string {
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const errorMessage = result.error instanceof Error ? result.error.message : undefined;
  return [
    `attempt=${attempt}/${maxAttempts}`,
    `status=${result.status ?? "null"}`,
    `signal=${result.signal ?? "none"}`,
    errorMessage ? `error=${errorMessage}` : undefined,
    stderr ? `stderr=${stderr}` : undefined,
    stdout ? `stdout=${stdout}` : undefined,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
}

function parseRepoIdentityUpdateRequestIntents(finalResponse: string): RepoIdentityUpdateRequestIntent[] {
  const intents: RepoIdentityUpdateRequestIntent[] = parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "update_request")
    .flatMap((block): RepoIdentityUpdateRequestIntent[] => {
      const title = requiredDslString(block.fields.title);
      const content = requiredDslString(block.fields.content);
      if (!title || !content) {
        return [];
      }
      return [
        {
          identity: optionalDslString(block.fields.identity),
          title,
          content,
          priority: parseDslNumber(block.fields.priority),
          sourceMessageIds: parseDslList(block.fields.source_message_ids ?? block.fields.sourceMessageIds),
          channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
          replyToMessageId: optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
        },
      ];
    });

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

function parseRepoIdentityBifrostTopicIntents(finalResponse: string): RepoIdentityBifrostTopicIntent[] {
  const intents: RepoIdentityBifrostTopicIntent[] = parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "bifrost_topic")
    .flatMap((block): RepoIdentityBifrostTopicIntent[] => {
      const topicId = optionalDslString(block.fields.topic_id) ?? optionalDslString(block.fields.topicId);
      const title = optionalDslString(block.fields.title);
      const content = requiredDslString(block.fields.content);
      if (!content || (!topicId && !title)) {
        return [];
      }
      return [
        {
          identity: optionalDslString(block.fields.identity),
          topicId,
          title,
          content,
          mirrorContent: optionalDslString(block.fields.mirror) ?? optionalDslString(block.fields.mirrorContent),
          stance: optionalDslString(block.fields.stance),
          priority: parseDslNumber(block.fields.priority),
          approve: parseDslBoolean(block.fields.approve),
          dispatch: parseDslBoolean(block.fields.dispatch),
          sourceMessageIds: parseDslList(block.fields.source_message_ids ?? block.fields.sourceMessageIds),
          channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
          replyToMessageId: optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
        },
      ];
    });

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REPO_IDENTITY_BIFROST_TOPIC_SENTINEL)) {
      continue;
    }

    const payload = trimmed.slice(REPO_IDENTITY_BIFROST_TOPIC_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      const title = typeof parsed.title === "string" ? parsed.title.trim() : undefined;
      const topicId = typeof parsed.topicId === "string" ? parsed.topicId.trim() : undefined;
      if (!content || (!topicId && !title)) {
        continue;
      }
      intents.push({
        identity: typeof parsed.identity === "string" ? parsed.identity.trim() : undefined,
        topicId,
        title,
        content,
        mirrorContent: typeof parsed.mirrorContent === "string" ? parsed.mirrorContent.trim() : undefined,
        stance: typeof parsed.stance === "string" ? parsed.stance.trim() : undefined,
        priority: typeof parsed.priority === "number" ? parsed.priority : undefined,
        approve: parsed.approve === true,
        dispatch: parsed.dispatch === true,
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
  let count = parseRepoFaceActionBlocks(finalResponse).filter((block) => block.kind === "article").length;

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith(REPO_IDENTITY_PROPOSAL_PR_SENTINEL) ||
      trimmed.startsWith(REPO_IDENTITY_PR_COMMENT_SENTINEL)
    ) {
      count += 1;
    }
  }

  return count;
}

interface RepoFaceActionBlock {
  kind: "say" | "state_note" | "article" | "reddit_thread" | "bifrost_topic" | "update_request";
  fields: Record<string, string>;
}

function parseRepoFaceActionBlocks(finalResponse: string): RepoFaceActionBlock[] {
  const lines = finalResponse.split(/\r?\n/);
  const blocks: RepoFaceActionBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = parseRepoFaceActionKind(lines[index]);
    if (!kind) {
      continue;
    }

    const bodyLines: string[] = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "END") {
      if (parseRepoFaceActionKind(lines[index])) {
        index -= 1;
        break;
      }
      bodyLines.push(lines[index]);
      index += 1;
    }
    blocks.push({
      kind,
      fields: parseRepoFaceActionFields(bodyLines),
    });
  }
  return blocks;
}

function isCurrentRepoFaceIdentitySelector(identitySelector: string | undefined): boolean {
  const normalized = identitySelector ? normalizeChannelSelector(identitySelector) : "";
  return normalized.length > 0 && CURRENT_REPO_FACE_IDENTITY_SELECTORS.has(normalized);
}

function parseRepoFaceActionKind(line: string): RepoFaceActionBlock["kind"] | undefined {
  switch (line.trim().toUpperCase()) {
    case "SAY":
      return "say";
    case "STATE NOTE":
      return "state_note";
    case "ARTICLE":
      return "article";
    case "REDDIT THREAD":
      return "reddit_thread";
    case "BIFROST TOPIC":
      return "bifrost_topic";
    case "UPDATE REQUEST":
      return "update_request";
    default:
      return undefined;
  }
}

function parseRepoFaceActionFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let currentKey: string | undefined;
  let currentValue: string[] = [];

  const flush = (): void => {
    if (!currentKey) {
      return;
    }
    fields[currentKey] = currentValue.join("\n").trim();
  };

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) {
      flush();
      currentKey = normalizeDslKey(match[1]);
      const inlineValue = match[2].trim();
      currentValue = inlineValue.length > 0 && inlineValue !== "|" && inlineValue !== ">" ? [match[2]] : [];
      continue;
    }
    if (currentKey) {
      currentValue.push(line.replace(/^\s{2}/, ""));
    }
  }
  flush();
  return fields;
}

function normalizeDslKey(key: string): string {
  return key.trim();
}

function optionalDslString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length === 0) {
    return undefined;
  }
  if (["0", "null", "none", "undefined"].includes(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

function requiredDslString(value: string | undefined): string | undefined {
  return optionalDslString(value);
}

function parseDslNumber(value: string | undefined): number | undefined {
  const trimmed = optionalDslString(value);
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDslBoolean(value: string | undefined): boolean | undefined {
  const normalized = optionalDslString(value)?.toLowerCase();
  if (["true", "yes", "1"].includes(normalized ?? "")) {
    return true;
  }
  if (["false", "no", "0"].includes(normalized ?? "")) {
    return false;
  }
  return undefined;
}

function parseDslList(value: string | undefined): string[] {
  const trimmed = optionalDslString(value);
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[,\n]/)
    .map((entry) => entry.trim().replace(/^-\s*/, ""))
    .filter((entry) => entry.length > 0);
}

function normalizeStateNoteKind(value: string | undefined): RepoIdentityStateNoteIntent["kind"] | undefined {
  const normalized = value?.trim().toLowerCase();
  return ["memory", "need", "bond", "status", "mood", "agency"].includes(normalized ?? "")
    ? normalized as RepoIdentityStateNoteIntent["kind"]
    : undefined;
}

function stateNoteTarget(
  intent: RepoIdentityStateNoteIntent,
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
): { kind: "repo" | "person" | "room" | "system" | "self"; id: string; label?: string } {
  const raw = intent.target?.trim();
  if (!raw || raw.toLowerCase() === "self") {
    return {
      kind: "person",
      id: identity.id,
      label: identity.displayName,
    };
  }
  if (raw.toLowerCase() === identity.repoName.toLowerCase()) {
    return {
      kind: "repo",
      id: identity.repoName,
      label: identity.repoName,
    };
  }
  if (["room", "aquarium", "discord"].includes(raw.toLowerCase())) {
    return {
      kind: "room",
      id: raw.toLowerCase(),
      label: raw,
    };
  }
  if (/^[a-z0-9_-]+$/i.test(raw) && raw.length <= 48) {
    return {
      kind: "person",
      id: raw.toLowerCase(),
      label: raw,
    };
  }
  return {
    kind: "system",
    id: sanitizeStateToken(raw),
    label: raw,
  };
}

function normalizeSocialBondStance(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return [
    "fondness",
    "rivalry",
    "trust",
    "irritation",
    "protectiveness",
    "envy",
    "respect",
    "suspicion",
    "attachment",
  ].includes(normalized ?? "")
    ? normalized!
    : "respect";
}

function normalizeStatusRead(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return [
    "favored",
    "neglected",
    "pampered",
    "bypassed",
    "blocked",
    "challenged",
    "ignored",
    "consulted",
    "threatened",
    "admired",
  ].includes(normalized ?? "")
    ? normalized!
    : "consulted";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function stableStateId(prefix: string, identityId: string, value: string): string {
  const hash = createHash("sha1")
    .update(`${identityId}:${prefix}:${value}`)
    .digest("hex")
    .slice(0, 12);
  return `${prefix}-${identityId}-${hash}`;
}

function sanitizeStateToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "topic";
}

function normalizeBifrostPriority(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 80;
  }
  return Math.max(1, Math.min(100, Math.round(value)));
}

function normalizeBifrostTopicStance(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return [
    "comment",
    "proposal",
    "support",
    "objection",
    "question",
    "approval",
    "summary",
    "receipt",
  ].includes(normalized ?? "")
    ? normalized!
    : "comment";
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
  return stripRepoFaceActionBlocks(finalResponse)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith(REPO_IDENTITY_POST_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_BIFROST_TOPIC_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_UPDATE_REQUEST_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_PROPOSAL_PR_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_PR_COMMENT_SENTINEL)
      );
    })
    .join("\n")
    .trim();
}

function stripRepoFaceActionBlocks(finalResponse: string): string {
  const lines = finalResponse.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (parseRepoFaceActionKind(lines[index])) {
      index += 1;
      while (index < lines.length && lines[index].trim() !== "END") {
        index += 1;
      }
      continue;
    }
    kept.push(lines[index]);
  }
  return kept.join("\n");
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
  if (input.identity.identityKind === "native_persona") {
    return;
  }

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
  await postDiscordBotMessage(dmChannelId, fitDiscordMessage(content));
}

async function postDiscordBotMessage(channelId: string, content: string): Promise<{ id: string }> {
  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required for the worker to post Discord messages.");
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
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

  const payload = (await response.json()) as { id?: string };
  if (!payload.id) {
    throw new Error("Discord message post succeeded without returning a message id.");
  }

  return { id: payload.id };
}

async function postDiscordBotMessageChunks(channelId: string, content: string): Promise<Array<{ id: string }>> {
  const posted: Array<{ id: string }> = [];
  for (const chunk of splitDiscordMessage(content)) {
    posted.push(await postDiscordBotMessage(channelId, chunk));
  }
  return posted;
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

function isOwnerDmChannelAlias(channelId: string): boolean {
  return ["owner", "dm", "owner_dm", "private", "meta"].includes(channelId.trim().toLowerCase());
}

function isCurrentRoomChannelAlias(channelId: string): boolean {
  return ["current", "current_room", "room", "here"].includes(channelId.trim().toLowerCase());
}

function repoIdentityDefaultSpeechChannel(job: JobRecord): string | undefined {
  return job.guildContext?.channelId && !isOwnerDmChannelAlias(job.guildContext.channelId)
    ? job.guildContext.channelId
    : job.outputChannelId;
}

function repoIdentityConversationFocusChannel(job: JobRecord): string | undefined {
  const focus = job.contextBundle.repoFaceConversationFocus;
  if (!focus || focus.isCurrentRoom) {
    return undefined;
  }

  const nonCurrentThreads = (job.contextBundle.repoFaceConversationThreads ?? [])
    .filter((thread) => !thread.isCurrentRoom);
  return nonCurrentThreads.length <= 1 || focus.reason === "pending_mention"
    ? focus.channelId
    : undefined;
}

function resolveRepoIdentityConversationContext(
  job: JobRecord,
  contextId: string | undefined,
): NonNullable<JobRecord["contextBundle"]["repoFaceConversationThreads"]>[number] | undefined {
  const normalized = contextId?.trim();
  if (!normalized) {
    return undefined;
  }

  return (job.contextBundle.repoFaceConversationThreads ?? [])
    .find((thread) => thread.contextId === normalized);
}

function repoIdentityRequiresExplicitConversationContext(
  job: JobRecord,
  intent: RepoIdentityPostIntent,
): boolean {
  if (intent.replyToMessageId || intent.contextId) {
    return false;
  }

  if (intent.channelId && !isCurrentRoomChannelAlias(intent.channelId)) {
    return false;
  }

  return repoFaceHasMultipleActiveConversationChannels(job);
}

function resolveRepoIdentityReplyTargetChannel(
  job: JobRecord,
  replyToMessageId: string | undefined,
): string | undefined {
  const normalizedReplyId = replyToMessageId?.trim();
  if (!normalizedReplyId) {
    return undefined;
  }

  const primaryChannelId = repoIdentityDefaultSpeechChannel(job);
  if (
    primaryChannelId &&
    job.contextBundle.recentMessages.some((message) => message.id === normalizedReplyId)
  ) {
    return primaryChannelId;
  }

  return extractPromptMessageChannelMap(job.contextBundle.prompt).get(normalizedReplyId);
}

function extractPromptMessageChannelMap(prompt: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of prompt.split(/\r?\n/)) {
    const chronologyMatch = line.match(/\[[^\]]*?\bchannel\s+(\d{5,})\][\s\S]*?\(message\s+(\d{5,})\)/i);
    if (chronologyMatch) {
      map.set(chronologyMatch[2], chronologyMatch[1]);
      continue;
    }

    const sectionMatch = line.match(/\(\s*channel\s+(\d{5,})\s*,\s*message\s+(\d{5,})\s*\)/i);
    if (sectionMatch) {
      map.set(sectionMatch[2], sectionMatch[1]);
    }
  }
  return map;
}

function normalizeRepoIdentitySpeechChannel(
  identity: { channelPermissions?: Array<{ channelId: string; label?: string }> },
  job: JobRecord,
  requestedChannelId: string | undefined,
): string | undefined {
  if (requestedChannelId && isCurrentRoomChannelAlias(requestedChannelId)) {
    return repoIdentityDefaultSpeechChannel(job);
  }

  const explicitChannelId = resolveRepoIdentityChannelSelector(identity, requestedChannelId);
  if (explicitChannelId) {
    return explicitChannelId;
  }

  if (!requestedChannelId || !isOwnerDmChannelAlias(requestedChannelId)) {
    return requestedChannelId;
  }

  if (repoIdentityOwnerDmExplicitlyAllowed(job)) {
    return requestedChannelId;
  }

  return repoIdentityDefaultSpeechChannel(job);
}

function resolveRepoIdentityChannelSelector(
  identity: { channelPermissions?: Array<{ channelId: string; label?: string }> },
  selector: string | undefined,
): string | undefined {
  const normalized = normalizeChannelSelector(selector);
  if (!normalized) {
    return undefined;
  }
  return identity.channelPermissions?.find((permission) =>
    normalizeChannelSelector(permission.channelId) === normalized ||
    normalizeChannelSelector(permission.label) === normalized
  )?.channelId;
}

function normalizeChannelSelector(selector: string | undefined): string {
  return (selector ?? "").trim().replace(/^#/, "").toLowerCase();
}

function repoIdentityOwnerDmExplicitlyAllowed(job: JobRecord): boolean {
  if (job.command !== "repo-face-rumination") {
    return true;
  }

  return /\bowner-private\b|\bowner dm allowed\b|\bdirect owner dm\b|\bprivate dm to metacrat\b/i.test(job.prompt);
}

function renderRepoIdentityOwnerDm(
  identity: { displayName: string; id: string },
  content: string,
): string {
  return `**${identity.displayName} (${identity.id})**\n${content}`.trim();
}

function fitDiscordMessage(content: string): string {
  const trimmed = content.trim();

  if (trimmed.length <= 1900) {
    return trimmed;
  }

  return `${trimmed.slice(0, 1897)}...`;
}

function splitDiscordMessage(content: string): string[] {
  const trimmed = content.trim();
  const limit = 1900;
  if (trimmed.length <= limit) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < Math.floor(limit * 0.6)) {
      cut = remaining.lastIndexOf("\n", limit);
    }
    if (cut < Math.floor(limit * 0.6)) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut < Math.floor(limit * 0.6)) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
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
