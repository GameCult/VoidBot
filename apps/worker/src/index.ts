import "dotenv/config";

import { createHash } from "node:crypto";
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
  faceRegistryAsRepoDiscordRegistry,
  isRepoDiscordIdentityAllowedInChannel,
  type JobQueue,
  loadFaceIdentityRegistry,
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
  type ProviderAdapter,
  type ProviderArtifact,
  type ProviderNotificationIntent,
  type ProviderResponse,
  loadPromptTemplate,
} from "@voidbot/shared";

const config = loadConfig();
const REPO_IDENTITY_POST_SENTINEL = "VOIDBOT_REPO_IDENTITY_POST:";
const REPO_IDENTITY_ARTICLE_SENTINEL = "VOIDBOT_REPO_IDENTITY_ARTICLE:";
const REPO_IDENTITY_PROPOSAL_PR_SENTINEL = "VOIDBOT_REPO_IDENTITY_PROPOSAL_PR:";
const REPO_IDENTITY_PR_COMMENT_SENTINEL = "VOIDBOT_REPO_IDENTITY_PR_COMMENT:";
const REPO_IDENTITY_UPDATE_REQUEST_SENTINEL = "VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST:";
const REPO_IDENTITY_BIFROST_TOPIC_SENTINEL = "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC:";
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
      const repoIdentityStateNotes = parseRepoIdentityStateNoteIntents(finalResponse);
      const repoIdentityBifrostTopics = parseRepoIdentityBifrostTopicIntents(finalResponse);
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
      const bifrostTopicSubmitted =
        !proposalPrSubmitted && !prCommentSubmitted && !articlePrSubmitted && repoIdentityBifrostTopics.length > 0;
      const updateRequestRoutedToBifrostTopic =
        !proposalPrSubmitted &&
        !prCommentSubmitted &&
        !articlePrSubmitted &&
        !bifrostTopicSubmitted &&
        repoIdentityUpdateRequests.length > 0;
      console.log(
        `Repo-face job ${job.id} parsed actions: say=${repoIdentityPosts.length}, stateNote=${repoIdentityStateNotes.length}, bifrostTopic=${repoIdentityBifrostTopics.length}, updateRequest=${repoIdentityUpdateRequests.length}, article=${repoIdentityArticles.length}, proposalPr=${repoIdentityProposals.length}, prComment=${repoIdentityPrComments.length}.`,
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
      } else if (repoIdentityBifrostTopics.length > 0) {
        await submitRepoIdentityBifrostTopicIntent(job, repoIdentityBifrostTopics[0]);
      } else if (repoIdentityUpdateRequests.length > 0) {
        await submitRepoIdentityBifrostTopicIntent(
          job,
          repoIdentityUpdateRequestToBifrostTopic(repoIdentityUpdateRequests[0]),
        );
      }
      let repoIdentityPostDelivered = 0;
      if (
        !proposalPrSubmitted &&
        !prCommentSubmitted &&
        !articlePrSubmitted &&
        !bifrostTopicSubmitted &&
        !updateRequestRoutedToBifrostTopic
      ) {
        for (const post of repoIdentityPosts.slice(0, 1)) {
          if (await postRepoIdentityIntent(job, post)) {
            repoIdentityPostDelivered += 1;
          }
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
            repoIdentityPostDelivered > 0 ||
            proposalPrSubmitted ||
            prCommentSubmitted ||
            articlePrSubmitted ||
            bifrostTopicSubmitted ||
            updateRequestRoutedToBifrostTopic,
          articlePrSubmitted,
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
): Promise<ProviderResponse> {
  const request = provider.buildRequest(contextBundle, {
    jobId: job.id,
    command: job.command,
    ...repoFaceHeartbeatCodexOptions(job),
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

  const firstText = fitDiscordMessage(firstResponse.outputText ?? firstResponse.summary);
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
    return routeRepoFaceInterpretedOutput(firstResponse, firstInterpretation);
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

  const retryText = fitDiscordMessage(retryResponse.outputText ?? retryResponse.summary);
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
    return routeRepoFaceInterpretedOutput(retryResponse, retryInterpretation);
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
}

async function interpretRepoFaceTurnOutput(
  provider: ProviderAdapter,
  job: JobRecord,
  outputText: string,
  input: { attempt: 1 | 2 },
): Promise<RepoFaceParentInterpretation> {
  const interpreterPrompt = loadPromptTemplate("repo-face-turn-interpreter.prompt.md", {
    attempt: input.attempt,
    facePrompt: job.contextBundle.prompt.slice(0, 8000),
    faceOutput: outputText.slice(0, 8000),
  });
  const interpreterContext = {
    ...job.contextBundle,
    prompt: interpreterPrompt,
    retrieval: [],
    voidSelfState: undefined,
    createdAt: new Date().toISOString(),
  };
  const response = await executeProviderForJob(provider, job, interpreterContext);
  const interpretationText = fitDiscordMessage(response.outputText ?? response.summary);
  return parseRepoFaceParentInterpretation(interpretationText, input.attempt);
}

function parseRepoFaceParentInterpretation(
  interpretationText: string,
  attempt: 1 | 2,
): RepoFaceParentInterpretation {
  const block = parseInterpretationBlock(interpretationText);
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
): ProviderResponse {
  const outputText =
    interpretation.routedOutput?.trim() ||
    stripRepoIdentityPostIntents(fitDiscordMessage(response.outputText ?? response.summary));
  const summary = outputText || "Repo Face parent interpreter routed no public or governed action.";
  return {
    ...response,
    outputText: summary,
    summary,
    metadata: {
      ...(response.metadata ?? {}),
      repoFaceParentInterpreterDecision: interpretation.decision,
      repoFaceParentInterpreterReasons: interpretation.reasons.join(" | "),
      repoFaceParentInterpretedOutput: interpretation.routedOutput ? "true" : "false",
    },
  };
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
    metadata: {
      ...(response.metadata ?? {}),
      repoFaceParentInterpreterDecision: interpretation.decision,
      repoFaceParentInterpreterReasons: interpretation.reasons.join(" | "),
    },
  };
}

function repoFaceHeartbeatCodexOptions(job: JobRecord): Record<string, string> {
  if (job.command !== "repo-face-rumination") {
    return {};
  }

  return {
    ...(config.repoFaceHeartbeats.codexModel ? { model: config.repoFaceHeartbeats.codexModel } : {}),
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

interface RepoIdentityPostIntent {
  identity?: string;
  channelId?: string;
  content: string;
  replyToMessageId?: string;
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
    throw new Error(`Could not resolve repo identity for job ${job.id}.`);
  }

  const channelId = intent.channelId ?? job.outputChannelId;
  if (!isRepoDiscordIdentityAllowedInChannel(identity, channelId)) {
    throw new Error(`Repo identity ${identity.id} is not registered for Discord channel ${channelId}.`);
  }

  const content = intent.content.trim();
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
  console.log(
    `Posted repo identity ${identity.id} to Discord channel ${channelId} from job ${job.id} via ${posted.transport} message ${posted.messageId}.`,
  );
  return true;
}

async function resolveRepoIdentityForJobIntent(
  job: JobRecord,
  identitySelector?: string,
): Promise<NonNullable<ReturnType<typeof findRepoDiscordIdentity>> | undefined> {
  const identityId =
    identitySelector ??
    parseRepoIdentityIdFromPrompt(job.prompt) ??
    parseRepoIdentityIdFromRequestMessageId(job.requestMessageId);
  if (!identityId) {
    return undefined;
  }

  const registry = await loadRegisteredFaceRepoRegistry();
  return findRepoDiscordIdentity(registry, identityId);
}

async function loadRegisteredFaceRepoRegistry() {
  return faceRegistryAsRepoDiscordRegistry(
    await loadFaceIdentityRegistry(config.repoDiscordIdentitiesPath),
  );
}

function parseRepoIdentityPostIntents(finalResponse: string): RepoIdentityPostIntent[] {
  const intents: RepoIdentityPostIntent[] = parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "say")
    .map((block) => ({
      identity: optionalDslString(block.fields.identity),
      channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
      replyToMessageId: optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
      content: block.fields.content.trim(),
    }))
    .filter((intent) => intent.content.length > 0);

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

  let topicId = intent.topicId;
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
      ...(intent.channelId ?? job.outputChannelId ? ["--source-channel-id", intent.channelId ?? job.outputChannelId] : []),
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
  const intents: RepoIdentityUpdateRequestIntent[] = parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "update_request")
    .map((block) => ({
      identity: optionalDslString(block.fields.identity),
      title: block.fields.title.trim(),
      content: block.fields.content.trim(),
      priority: parseDslNumber(block.fields.priority),
      sourceMessageIds: parseDslList(block.fields.source_message_ids ?? block.fields.sourceMessageIds),
      channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
      replyToMessageId: optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
    }))
    .filter((intent) => intent.title.length > 0 && intent.content.length > 0);

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
    .map((block) => ({
      identity: optionalDslString(block.fields.identity),
      topicId: optionalDslString(block.fields.topic_id) ?? optionalDslString(block.fields.topicId),
      title: optionalDslString(block.fields.title),
      content: block.fields.content.trim(),
      mirrorContent: optionalDslString(block.fields.mirror) ?? optionalDslString(block.fields.mirrorContent),
      stance: optionalDslString(block.fields.stance),
      priority: parseDslNumber(block.fields.priority),
      approve: parseDslBoolean(block.fields.approve),
      dispatch: parseDslBoolean(block.fields.dispatch),
      sourceMessageIds: parseDslList(block.fields.source_message_ids ?? block.fields.sourceMessageIds),
      channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
      replyToMessageId: optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
    }))
    .filter((intent) => intent.content.length > 0 && Boolean(intent.topicId || intent.title));

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

interface RepoFaceActionBlock {
  kind: "say" | "state_note" | "bifrost_topic" | "update_request";
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

function parseRepoFaceActionKind(line: string): RepoFaceActionBlock["kind"] | undefined {
  switch (line.trim().toUpperCase()) {
    case "SAY":
      return "say";
    case "STATE NOTE":
      return "state_note";
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
  return stripRepoFaceActionBlocks(finalResponse)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith(REPO_IDENTITY_POST_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_BIFROST_TOPIC_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_UPDATE_REQUEST_SENTINEL) &&
        !trimmed.startsWith(REPO_IDENTITY_ARTICLE_SENTINEL) &&
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
