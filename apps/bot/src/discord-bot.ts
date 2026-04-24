import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  type CacheType,
  type ChatInputCommandInteraction,
  type Message,
  type PartialMessage,
  type TextBasedChannel,
} from "discord.js";

import { loadConfig } from "@voidbot/config";
import {
  buildVoidMcpServerConfig,
  ContextBuilder,
  FileAuditLog,
  FileBackedJobQueue,
  FileInteractionMemoryBank,
  PermissionEngine,
  loadStylePack,
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
  createTextEmbedder,
  createVectorStores,
  FileMessageArchiveRepository,
  FileSourceDocumentArchiveRepository,
  HistoryIngester,
  RagPipeline,
  RetrievalService,
  SourceDocumentIngester,
  type ArchivedMessageRecord,
} from "@voidbot/rag";
import {
  type Actor,
  type ArchivedMessage,
  type ChannelIndexingPolicy,
  type ChannelIndexingTarget,
  type CommandName,
  type GuildContext,
  type JobRecord,
  type ProviderName,
  type SourceGroundingHint,
  type SourceMessage,
  type StylePack,
  isProviderName,
  shouldIndexChannel,
} from "@voidbot/shared";

const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask VoidBot a question.")
    .addStringOption((option) =>
      option.setName("question").setDescription("What do you want to ask?").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("Override the provider instead of using auto-selection.")
        .setRequired(false)
        .addChoices(
          { name: "Auto", value: "auto" },
          { name: "Owner Codex", value: "owner_codex" },
          { name: "Local LLM", value: "local_llm" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("queue-codex")
    .setDescription("Force a fuller owner-only Codex handoff.")
    .addStringOption((option) =>
      option.setName("prompt").setDescription("The owner workflow prompt.").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("approve-job")
    .setDescription("Approve a queued job or post its final response.")
    .addStringOption((option) =>
      option.setName("job-id").setDescription("The job id to approve.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("response")
        .setDescription("Optional final response to publish when the job is awaiting post approval.")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("reject-job")
    .setDescription("Reject a queued job.")
    .addStringOption((option) =>
      option.setName("job-id").setDescription("The job id to reject.").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Optional rejection reason.").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("provider-status")
    .setDescription("Show current provider availability for you."),
  new SlashCommandBuilder()
    .setName("search-history")
    .setDescription("Search indexed channel history.")
    .addStringOption((option) =>
      option.setName("query").setDescription("What to search for.").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("summarize-channel")
    .setDescription("Summarize recent messages in this channel."),
  new SlashCommandBuilder()
    .setName("reindex-channel")
    .setDescription("Reindex the current indexed channel."),
  new SlashCommandBuilder()
    .setName("set-style")
    .setDescription("Reload the configured style pack from disk."),
];

export async function startBot(): Promise<void> {
  const config = loadConfig();

  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required to start the bot.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const permissionEngine = new PermissionEngine(config.ownerDiscordId, {
    localLlmAllowPublic: config.localLlm.allowPublic,
  });
  const jobQueue = new FileBackedJobQueue(config.jobsFile);
  const auditLog = new FileAuditLog(config.auditLogFile);
  const interactionMemory = new FileInteractionMemoryBank(config.interactionMemoryFile);
  const contextBuilder = new ContextBuilder();
  let activeStylePack = await loadStylePack(config.stylePackPath);
  let activeSystemMessages = await loadSystemMessageCatalog(config.systemMessagesPath);
  const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
  const sourceArchiveRepository = new FileSourceDocumentArchiveRepository(
    config.ragSourceArchivePath,
  );
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
  const vectorStore = vectorStores.history;
  const sourceRetrievalStore = vectorStores.source;
  const retrievalService = new RetrievalService(vectorStore, sourceRetrievalStore);
  const historyIngester = new HistoryIngester();
  const sourceDocumentIngester = new SourceDocumentIngester();
  const ragPipeline = new RagPipeline(archiveRepository, historyIngester, vectorStore);
  const providerRegistry = new ProviderRegistry([
    new OwnerCodexProvider({
      ownerDiscordId: config.ownerDiscordId,
      enabled: config.enabledProviders.includes("owner_codex"),
      mode: config.ownerCodexMode,
      executable: config.codexExecutable,
      executableArgs: config.codexExecArgs,
      reasoningEffort: config.codexModelReasoningEffort,
      timeoutMs: config.codexExecTimeoutMs,
      workingDirectory: process.cwd(),
      historyLookup: retrievalService,
      handoffNoticeBuilder: (jobId) =>
        renderSystemMessage(activeSystemMessages, "owner_codex.handoff_notice", {
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
          const results = await retrievalService.searchHistory(input.query, input.limit, {
            guildId: input.guildId,
            channelId: input.channelId,
            authorId: input.authorId,
          });

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
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`VoidBot connected as ${readyClient.user.tag}.`);
    await maybeRegisterCommands(config.botToken!, config.applicationId, config.developmentGuildId);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) {
      return;
    }

    await ingestIfIndexed(message, config.channelIndexing, ragPipeline);
    await rememberAmbientVoidReference(message, client.user?.id, interactionMemory);

    if (!client.user || !message.mentions.has(client.user)) {
      return;
    }

    const prompt = stripBotMention(message.content).trim();

    if (!prompt) {
      await message.reply(renderSystemMessage(activeSystemMessages, "mention.missing_prompt"));
      return;
    }

    try {
      await handlePrompt({
        prompt,
        command: "ask",
        actor: buildActorFromMessage(message),
        guildContext: buildGuildContextFromMessage(message),
        outputChannelId: message.channelId,
        requestMessageId: message.id,
        channel: message.channel.isTextBased() ? message.channel : null,
        respond: async (content) => {
          await message.reply(content);
        },
        config,
        permissionEngine,
        contextBuilder,
        retrievalService,
        sourceArchiveRepository,
        jobQueue,
        auditLog,
        interactionMemory,
        providerRegistry,
        stylePack: activeStylePack,
        systemMessages: activeSystemMessages,
        silentOwnerQueueAck: true,
      });
    } catch (error) {
      console.error(error);
      await notifyOwnerOfBotIssue(
        client,
        config.ownerDiscordId,
        renderSystemMessage(activeSystemMessages, "job.owner.queue_failed_dm", {
          channelName:
            "name" in message.channel && message.channel.name
              ? message.channel.name
              : message.channelId,
          errorMessage:
            error instanceof Error ? error.message : "Unexpected bot-side failure.",
        }),
      );
    }
  });

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    const materializedMessage = await materializeMessage(newMessage);

    if (!materializedMessage || materializedMessage.author.bot) {
      return;
    }

    await ingestIfIndexed(materializedMessage, config.channelIndexing, ragPipeline);
    await rememberAmbientVoidReference(
      materializedMessage,
      client.user?.id,
      interactionMemory,
    );
  });

  client.on(Events.MessageDelete, async (message) => {
    if (!shouldIndexChannel(config.channelIndexing, buildChannelIndexingTarget(message.channel))) {
      return;
    }

    await ragPipeline.markDeleted(message.id);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      const actor = buildActorFromInteraction(interaction);
      const guildContext = buildGuildContextFromInteraction(interaction);

      switch (interaction.commandName) {
        case "ask":
          const requestedProvider = parseProviderOverride(
            interaction.options.getString("provider", false),
          );
          await handlePrompt({
            prompt: interaction.options.getString("question", true),
            command: "ask",
            actor,
            guildContext,
            outputChannelId: interaction.channelId,
            requestMessageId: interaction.id,
            channel: interaction.channel?.isTextBased() ? interaction.channel : null,
            respond: async (content) => {
              await replyEphemeral(interaction, content);
            },
            config,
            permissionEngine,
            contextBuilder,
            retrievalService,
            sourceArchiveRepository,
            jobQueue,
            auditLog,
            interactionMemory,
            providerRegistry,
            stylePack: activeStylePack,
            systemMessages: activeSystemMessages,
            forceProvider: requestedProvider,
          });
          break;
        case "queue-codex":
          await handlePrompt({
            prompt: interaction.options.getString("prompt", true),
            command: "queue-codex",
            actor,
            guildContext,
            outputChannelId: interaction.channelId,
            requestMessageId: interaction.id,
            channel: interaction.channel?.isTextBased() ? interaction.channel : null,
            respond: async (content) => {
              await replyEphemeral(interaction, content);
            },
            config,
            permissionEngine,
            contextBuilder,
            retrievalService,
            sourceArchiveRepository,
            jobQueue,
            auditLog,
            interactionMemory,
            providerRegistry,
            stylePack: activeStylePack,
            systemMessages: activeSystemMessages,
            forceProvider: "owner_codex",
          });
          break;
        case "approve-job":
          await handleApproveJob({
            interaction,
            client,
            actor,
            jobQueue,
            auditLog,
            permissionEngine,
            systemMessages: activeSystemMessages,
          });
          break;
        case "reject-job":
          await handleRejectJob({
            interaction,
            actor,
            jobQueue,
            auditLog,
            permissionEngine,
            systemMessages: activeSystemMessages,
          });
          break;
        case "provider-status":
          await replyEphemeral(
            interaction,
            formatProviderStatuses(
              providerRegistry.listStatuses(actor, guildContext),
              activeSystemMessages,
            ),
          );
          break;
        case "search-history":
          await handleSearchHistory(interaction, retrievalService, activeSystemMessages);
          break;
        case "summarize-channel":
          await handleSummarizeChannel(interaction, activeSystemMessages);
          break;
        case "reindex-channel":
          await handleReindexChannel(
            interaction,
            actor,
            config.channelIndexing,
            permissionEngine,
            ragPipeline,
            activeSystemMessages,
          );
          break;
        case "set-style":
          if (!permissionEngine.canManageConfiguration(actor)) {
            await replyEphemeral(
              interaction,
              renderSystemMessage(activeSystemMessages, "config.set_style.forbidden"),
            );
            break;
          }

          activeStylePack = await loadStylePack(config.stylePackPath);
          activeSystemMessages = await loadSystemMessageCatalog(config.systemMessagesPath);
          await replyEphemeral(
            interaction,
            activeStylePack
              ? renderSystemMessage(activeSystemMessages, "config.set_style.reloaded", {
                  stylePackName: activeStylePack.name,
                  stylePackPath: config.stylePackPath,
                  systemMessagesPath: config.systemMessagesPath,
                })
              : renderSystemMessage(activeSystemMessages, "config.set_style.style_missing", {
                  stylePackPath: config.stylePackPath,
                  systemMessagesPath: config.systemMessagesPath,
                }),
          );
          break;
        default:
          await replyEphemeral(
            interaction,
            renderSystemMessage(activeSystemMessages, "command.unimplemented"),
          );
      }
    } catch (error) {
      console.error(error);

      const message =
        error instanceof Error
          ? renderSystemMessage(activeSystemMessages, "error.with_message", {
              errorMessage: error.message,
            })
          : renderSystemMessage(activeSystemMessages, "error.generic");

      await replyEphemeral(interaction, message);
    }
  });

  await client.login(config.botToken);
}

interface PromptHandlerOptions {
  prompt: string;
  command: CommandName;
  actor: Actor;
  guildContext: GuildContext;
  outputChannelId: string;
  requestMessageId?: string;
  channel: TextBasedChannel | null;
  respond: (content: string) => Promise<void>;
  config: ReturnType<typeof loadConfig>;
  permissionEngine: PermissionEngine;
  contextBuilder: ContextBuilder;
  retrievalService: RetrievalService;
  sourceArchiveRepository: FileSourceDocumentArchiveRepository;
  jobQueue: FileBackedJobQueue;
  auditLog: FileAuditLog;
  interactionMemory: FileInteractionMemoryBank;
  providerRegistry: ProviderRegistry;
  stylePack?: StylePack;
  systemMessages: SystemMessageCatalog;
  forceProvider?: ProviderName;
  silentOwnerQueueAck?: boolean;
}

async function handlePrompt(options: PromptHandlerOptions): Promise<void> {
      const interactionMemory = await options.interactionMemory.recordInteraction({
        actorId: options.actor.id,
        actorName: options.actor.displayName,
        sourceKind: "direct_prompt",
        guildId: options.guildContext.guildId,
        channelId: options.guildContext.channelId,
        channelName: options.guildContext.channelName,
        command: options.command,
    prompt: options.prompt,
    eventId: options.requestMessageId,
  });
  const providerName =
    options.forceProvider ?? pickProvider(options.actor, options.guildContext, options.providerRegistry);

  if (!providerName) {
    await options.respond(
      renderSystemMessage(options.systemMessages, "provider.none_available"),
    );
    return;
  }

  const provider = options.providerRegistry.get(providerName);

  if (!provider) {
    await options.respond(
      renderSystemMessage(options.systemMessages, "provider.missing_registration", {
        providerName,
      }),
    );
    return;
  }

  const access = options.permissionEngine.canUseProvider(options.actor, providerName);

  if (!access.allowed) {
    await options.respond(
      access.reasonKey
        ? renderSystemMessage(options.systemMessages, access.reasonKey)
        : renderSystemMessage(options.systemMessages, "provider.access_denied.generic"),
    );
    return;
  }

  const recentMessages = await getRecentMessages(options.channel, 10);
  const sourceGrounding = inferSourceGroundingHint(
    options.prompt,
    await options.sourceArchiveRepository.listRepoSummaries(),
  );
  const shouldAttachInitialRetrieval =
    !provider.getCapabilities().includes("tool_driven_retrieval") &&
    (shouldIndexChannel(options.config.channelIndexing, buildChannelIndexingTarget(options.channel)) ||
      providerName !== "owner_codex");
  const retrieval = shouldAttachInitialRetrieval
    ? await options.retrievalService.search(options.prompt, 5, {
        guildId: options.guildContext.guildId,
        corpusKind: "discord_history",
      })
    : [];
  const contextBundle = options.contextBuilder.build({
    prompt: options.prompt,
    actor: options.actor,
    guildContext: options.guildContext,
    recentMessages,
    retrieval,
    interactionMemory,
    sourceGrounding,
    stylePack: options.stylePack,
  });

  if (providerName === "owner_codex") {
    const runApprovalRequired = options.config.ownerCodexMode === "manual_package";
    const postApprovalRequired = options.config.ownerCodexMode === "manual_package";
    const { job, created } = await options.jobQueue.createJob({
      command: options.command,
      provider: "owner_codex",
      runApprovalRequired,
      postApprovalRequired,
      requester: options.actor,
      guildContext: options.guildContext,
      prompt: options.prompt,
      contextBundle,
      outputChannelId: options.outputChannelId,
      requestMessageId: options.requestMessageId,
      initialState: runApprovalRequired ? "awaiting_approval" : "approved",
    });

    if (!created) {
      return;
    }

    await options.auditLog.record({
      type: "job.queued",
      actorId: options.actor.id,
      jobId: job.id,
      provider: "owner_codex",
      details: {
        command: options.command,
        channelId: options.outputChannelId,
        runApprovalRequired,
        postApprovalRequired,
      },
    });

    if (runApprovalRequired) {
      await options.respond(
        renderSystemMessage(options.systemMessages, "job.owner.awaiting_run_approval", {
          jobId: job.id,
        }),
      );
      return;
    }

    if (!options.silentOwnerQueueAck) {
      await options.respond(
        renderSystemMessage(options.systemMessages, "job.owner.auto_queued", {
          jobId: job.id,
        }),
      );
    }
    return;
  }

  const response = await provider.execute(provider.buildRequest(contextBundle));

  await options.auditLog.record({
    type: "provider.responded",
    actorId: options.actor.id,
    provider: providerName,
    details: {
      command: options.command,
      summary: response.summary,
    },
  });

  await options.respond(response.outputText ?? response.summary);
}

async function handleApproveJob(options: {
  interaction: ChatInputCommandInteraction<CacheType>;
  client: Client;
  actor: Actor;
  jobQueue: FileBackedJobQueue;
  auditLog: FileAuditLog;
  permissionEngine: PermissionEngine;
  systemMessages: SystemMessageCatalog;
}): Promise<void> {
  const jobId = options.interaction.options.getString("job-id", true);
  const response = options.interaction.options.getString("response", false);
  const job = await options.jobQueue.getJob(jobId);

  if (!job) {
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "job.not_found", { jobId }),
    );
    return;
  }

  if (!options.permissionEngine.canApproveJob(options.actor, job)) {
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "job.approval_forbidden"),
    );
    return;
  }

  if (job.state === "awaiting_approval") {
    await options.jobQueue.approveRun(jobId, options.actor.id);
    await options.auditLog.record({
      type: "job.run_approved",
      actorId: options.actor.id,
      jobId,
      provider: job.provider,
      details: {},
    });
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "job.run_approved", { jobId }),
    );
    return;
  }

  if (job.state === "awaiting_post_approval") {
    if (!response) {
      await replyEphemeral(
        options.interaction,
        renderSystemMessage(options.systemMessages, "job.post_approval.needs_response"),
      );
      return;
    }

    await postFinalResponse(options.client, job, response);
    await options.jobQueue.completeJob(jobId, options.actor.id, response);
    await options.auditLog.record({
      type: "job.post_approved",
      actorId: options.actor.id,
      jobId,
      provider: job.provider,
      details: {
        publishedLength: response.length,
      },
    });
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "job.post_approved", { jobId }),
    );
    return;
  }

  await replyEphemeral(
    options.interaction,
    renderSystemMessage(options.systemMessages, "job.no_action_for_state", {
      jobId,
      jobState: job.state,
    }),
  );
}

async function handleRejectJob(options: {
  interaction: ChatInputCommandInteraction<CacheType>;
  actor: Actor;
  jobQueue: FileBackedJobQueue;
  auditLog: FileAuditLog;
  permissionEngine: PermissionEngine;
  systemMessages: SystemMessageCatalog;
}): Promise<void> {
  const jobId = options.interaction.options.getString("job-id", true);
  const reason = options.interaction.options.getString("reason", false) ?? undefined;
  const job = await options.jobQueue.getJob(jobId);

  if (!job) {
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "job.not_found", { jobId }),
    );
    return;
  }

  if (!options.permissionEngine.canApproveJob(options.actor, job)) {
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "job.rejection_forbidden"),
    );
    return;
  }

  await options.jobQueue.rejectJob(jobId, options.actor.id, reason);
  await options.auditLog.record({
    type: "job.rejected",
    actorId: options.actor.id,
    jobId,
    provider: job.provider,
    details: {
      reason,
    },
  });
  await replyEphemeral(
    options.interaction,
    renderSystemMessage(options.systemMessages, "job.rejected", { jobId }),
  );
}

async function handleSearchHistory(
  interaction: ChatInputCommandInteraction<CacheType>,
  retrievalService: RetrievalService,
  systemMessages: SystemMessageCatalog,
): Promise<void> {
  const query = interaction.options.getString("query", true);
  const results = await retrievalService.searchHistory(query, 5, {
    guildId: interaction.guildId ?? undefined,
  });

  if (results.length === 0) {
    await replyEphemeral(interaction, renderSystemMessage(systemMessages, "history.no_results"));
    return;
  }

  const body = results
    .map((result, index) => `${index + 1}. (${result.score.toFixed(2)}) ${truncate(result.text, 180)}`)
    .join("\n");

  await replyEphemeral(
    interaction,
    `${renderSystemMessage(systemMessages, "history.results_intro")}\n${body}`,
  );
}

async function handleSummarizeChannel(
  interaction: ChatInputCommandInteraction<CacheType>,
  systemMessages: SystemMessageCatalog,
): Promise<void> {
  const messages = await getRecentMessages(interaction.channel?.isTextBased() ? interaction.channel : null, 15);

  if (messages.length === 0) {
    await replyEphemeral(
      interaction,
      renderSystemMessage(systemMessages, "summarize.no_messages"),
    );
    return;
  }

  const summary = messages
    .slice(-8)
    .map((message) => `- ${message.authorName}: ${truncate(message.content, 100)}`)
    .join("\n");

  await replyEphemeral(
    interaction,
    `${renderSystemMessage(systemMessages, "summarize.results_intro")}\n${summary}`,
  );
}

async function handleReindexChannel(
  interaction: ChatInputCommandInteraction<CacheType>,
  actor: Actor,
  channelIndexing: ChannelIndexingPolicy,
  permissionEngine: PermissionEngine,
  ragPipeline: RagPipeline,
  systemMessages: SystemMessageCatalog,
): Promise<void> {
  if (!permissionEngine.canReindex(actor)) {
    await replyEphemeral(interaction, renderSystemMessage(systemMessages, "reindex.forbidden"));
    return;
  }

  if (
    !shouldIndexChannel(
      channelIndexing,
      buildChannelIndexingTarget(interaction.channel?.isTextBased() ? interaction.channel : null),
    )
  ) {
    await replyEphemeral(
      interaction,
      renderSystemMessage(systemMessages, "reindex.excluded"),
    );
    return;
  }

  if (!interaction.channel?.isTextBased()) {
    await replyEphemeral(
      interaction,
      renderSystemMessage(systemMessages, "reindex.unsupported_channel"),
    );
    return;
  }

  const fetched = await interaction.channel.messages.fetch({ limit: 100 });
  const archivedMessages = [...fetched.values()].map(convertDiscordMessageToArchive);
  const result = await ragPipeline.upsertMessages(archivedMessages);

  await replyEphemeral(
    interaction,
    renderSystemMessage(systemMessages, "reindex.completed", {
      archivedMessages: archivedMessages.length,
      createdMessages: result.createdMessages,
      updatedMessages: result.updatedMessages,
      unchangedMessages: result.unchangedMessages,
      indexedChunks: result.indexedChunks,
    }),
  );
}

function buildActorFromMessage(message: Message): Actor {
  return {
    id: message.author.id,
    displayName: message.author.displayName ?? message.author.username,
    isAdmin: message.member?.permissions.has(PermissionsBitField.Flags.Administrator) ?? false,
    isBot: message.author.bot,
  };
}

function buildActorFromInteraction(interaction: ChatInputCommandInteraction<CacheType>): Actor {
  return {
    id: interaction.user.id,
    displayName: interaction.user.displayName ?? interaction.user.username,
    isAdmin:
      interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ?? false,
    isBot: interaction.user.bot,
  };
}

function buildGuildContextFromMessage(message: Message): GuildContext {
  return {
    guildId: message.guildId ?? undefined,
    guildName: message.guild?.name,
    channelId: message.channelId,
    channelName: "name" in message.channel ? message.channel.name ?? undefined : undefined,
    threadId: message.channel.type === ChannelType.PublicThread ? message.channel.id : undefined,
  };
}

function buildGuildContextFromInteraction(
  interaction: ChatInputCommandInteraction<CacheType>,
): GuildContext {
  return {
    guildId: interaction.guildId ?? undefined,
    guildName: interaction.guild?.name,
    channelId: interaction.channelId,
    channelName:
      interaction.channel && "name" in interaction.channel ? interaction.channel.name ?? undefined : undefined,
    threadId:
      interaction.channel?.type === ChannelType.PublicThread ? interaction.channel.id : undefined,
  };
}

async function ingestIfIndexed(
  message: Message,
  channelIndexing: ChannelIndexingPolicy,
  ragPipeline: RagPipeline,
): Promise<void> {
  if (!shouldIndexChannel(channelIndexing, buildChannelIndexingTarget(message.channel))) {
    return;
  }

  await ragPipeline.upsertMessages([convertDiscordMessageToArchive(message)]);
}

async function rememberAmbientVoidReference(
  message: Message,
  botUserId: string | undefined,
  interactionMemory: FileInteractionMemoryBank,
): Promise<void> {
  if (!isAmbientVoidReference(message, botUserId)) {
    return;
  }

  await interactionMemory.recordInteraction({
    actorId: message.author.id,
    actorName: message.author.displayName ?? message.author.username,
    sourceKind: "ambient_mention",
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    channelName: "name" in message.channel ? message.channel.name ?? undefined : undefined,
    prompt: message.content,
    eventId: message.id,
    timestamp: (message.editedAt ?? message.createdAt).toISOString(),
  });
}

function buildChannelIndexingTarget(
  channel: TextBasedChannel | null | undefined,
): ChannelIndexingTarget {
  if (!channel) {
    return {};
  }

  const target: ChannelIndexingTarget = {
    channelId: channel.id,
    channelName: "name" in channel ? channel.name ?? undefined : undefined,
  };

  if (channel.isThread()) {
    target.parentChannelId = channel.parentId ?? undefined;
    target.parentChannelName =
      channel.parent && "name" in channel.parent ? channel.parent.name ?? undefined : undefined;
  }

  return target;
}

function convertDiscordMessageToArchive(message: Message): ArchivedMessage {
  const metadata: Record<string, string> = {
    jumpUrl: message.url,
  };

  if ("name" in message.channel && message.channel.name) {
    metadata.channelName = message.channel.name;
  }

  if (message.channel.isThread()) {
    if (message.channel.parentId) {
      metadata.parentChannelId = message.channel.parentId;
    }

    if (message.channel.parent && "name" in message.channel.parent && message.channel.parent.name) {
      metadata.parentChannelName = message.channel.parent.name;
    }
  }

  return {
    id: message.id,
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.author.displayName ?? message.author.username,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString(),
    threadId: message.channel.isThread() ? message.channel.id : undefined,
    attachments:
      message.attachments.size > 0
        ? [...message.attachments.values()].map(
            (attachment) => attachment.url ?? attachment.proxyURL ?? attachment.name,
          )
        : undefined,
    metadata,
  };
}

function convertDiscordMessageToSource(message: Message): SourceMessage {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.author.displayName ?? message.author.username,
    content: message.content,
    timestamp: message.createdAt.toISOString(),
  };
}

async function getRecentMessages(
  channel: TextBasedChannel | null,
  limit: number,
): Promise<SourceMessage[]> {
  if (!channel || !("messages" in channel)) {
    return [];
  }

  const fetched = await channel.messages.fetch({ limit });

  return [...fetched.values()]
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(convertDiscordMessageToSource);
}

async function materializeMessage(
  message: Message | PartialMessage,
): Promise<Message | undefined> {
  if (!message.partial) {
    return message;
  }

  try {
    return await message.fetch();
  } catch {
    return undefined;
  }
}

function pickProvider(
  actor: Actor,
  guildContext: GuildContext,
  providerRegistry: ProviderRegistry,
): ProviderName | undefined {
  const ownerCodex = providerRegistry.get("owner_codex");

  if (ownerCodex?.isAllowedForActor(actor, guildContext)) {
    return "owner_codex";
  }

  const openAi = providerRegistry.get("openai_api");

  if (openAi?.isAllowedForActor(actor, guildContext)) {
    return "openai_api";
  }

  const local = providerRegistry.get("local_llm");

  if (local?.isAllowedForActor(actor, guildContext)) {
    return "local_llm";
  }

  return undefined;
}

function parseProviderOverride(value: string | null): ProviderName | undefined {
  if (!value || value === "auto") {
    return undefined;
  }

  return isProviderName(value) ? value : undefined;
}

async function maybeRegisterCommands(
  botToken: string,
  applicationId?: string,
  developmentGuildId?: string,
): Promise<void> {
  if (!applicationId || !developmentGuildId) {
    console.log("Skipping slash command registration because DISCORD_APPLICATION_ID or DISCORD_GUILD_ID is missing.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(botToken);

  await rest.put(Routes.applicationGuildCommands(applicationId, developmentGuildId), {
    body: commandDefinitions.map((command) => command.toJSON()),
  });

  console.log(`Registered ${commandDefinitions.length} guild slash commands for ${developmentGuildId}.`);
}

async function replyEphemeral(
  interaction: ChatInputCommandInteraction<CacheType>,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }

  await interaction.reply({ content, ephemeral: true });
}

function stripBotMention(content: string): string {
  return content.replace(/<@!?(\d+)>/g, "").trim();
}

function inferSourceGroundingHint(
  prompt: string,
  repoSummaries: Array<{ repoName: string }>,
): SourceGroundingHint {
  const normalized = ` ${normalizeForMatching(prompt)} `;
  const reasons = new Set<string>();
  const matchedRepoNames = new Set<string>();

  for (const repo of repoSummaries) {
    for (const alias of buildRepoAliases(repo.repoName)) {
      if (alias.length < 4) {
        continue;
      }

      if (normalized.includes(` ${alias} `)) {
        matchedRepoNames.add(repo.repoName);
      }
    }
  }

  if (matchedRepoNames.size > 0) {
    reasons.add("matched indexed repo/project name");
  }

  const genericSourceCues = [
    " repo ",
    " repository ",
    " repositories ",
    " codebase ",
    " source ",
    " sources ",
    " lore ",
    " vault ",
    " canon ",
    " file ",
    " files ",
    " docs ",
    " documentation ",
    " module ",
    " implementation ",
    " project ",
    " projects ",
  ];

  if (genericSourceCues.some((cue) => normalized.includes(cue))) {
    reasons.add("contains source/lore cue");
  }

  return {
    required: reasons.size > 0,
    reasons: [...reasons],
    matchedRepoNames: [...matchedRepoNames].sort(),
  };
}

function buildRepoAliases(repoName: string): string[] {
  const normalizedRepo = repoName.replace(/[_-]+/g, " ").trim();
  const lower = normalizeForMatching(normalizedRepo);
  const compact = normalizeForMatching(repoName);
  const words = splitPascalCase(normalizedRepo)
    .flatMap((part) => part.split(/\s+/))
    .map((part) => normalizeForMatching(part))
    .filter((part) => part.length > 0);
  const aliases = new Set<string>([lower, compact, words.join(" ")]);

  for (const word of words) {
    if (word.length >= 4) {
      aliases.add(word);
    }
  }

  return [...aliases].filter((alias) => alias.length > 0);
}

function splitPascalCase(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAmbientVoidReference(
  message: Message,
  botUserId: string | undefined,
): boolean {
  const content = message.content.trim();

  if (content.length === 0) {
    return false;
  }

  if (botUserId && message.mentions.users.has(botUserId)) {
    return false;
  }

  if (/\bvoidbot\b/i.test(content)) {
    return true;
  }

  if (!/\bvoid\b/i.test(content)) {
    return false;
  }

  const normalized = ` ${content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

  if (
    normalized.includes(" the void ") ||
    normalized.includes(" into the void ") ||
    normalized.includes(" return void ") ||
    normalized.includes(" void function ") ||
    normalized.includes(" void pointer ") ||
    normalized.includes(" non void ")
  ) {
    return false;
  }

  return true;
}

function formatProviderStatuses(
  statuses: ReturnType<ProviderRegistry["listStatuses"]>,
  systemMessages: SystemMessageCatalog,
): string {
  return [
    renderSystemMessage(systemMessages, "provider_status.intro"),
    statuses
      .map((status) => {
        const state = status.enabled ? "enabled" : "disabled";
        const access = status.allowed ? "allowed" : "blocked";
        return `${status.name}: ${state}, ${access}, capabilities=${status.capabilities.join(", ")}`;
      })
      .join("\n"),
  ].join("\n");
}

function renderSystemMessage(
  systemMessages: SystemMessageCatalog,
  key: string,
  variables: Record<string, string | number | boolean | null | undefined> = {},
): string {
  return systemMessages.render(key, variables);
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

async function postFinalResponse(client: Client, job: JobRecord, finalResponse: string): Promise<void> {
  const channel = await client.channels.fetch(job.outputChannelId);

  if (!canSendMessages(channel)) {
    throw new Error(`Channel ${job.outputChannelId} is not available for publishing.`);
  }

  await channel.send(finalResponse);
}

async function notifyOwnerOfBotIssue(
  client: Client,
  ownerDiscordId: string,
  content: string,
): Promise<void> {
  try {
    const owner = await client.users.fetch(ownerDiscordId);
    await owner.send(truncate(content, 1900));
  } catch (error) {
    console.error(
      `Failed to DM owner about bot-side issue: ${
        error instanceof Error ? error.message : "Unexpected notification failure."
      }`,
    );
  }
}

function truncate(input: string, limit: number): string {
  if (input.length <= limit) {
    return input;
  }

  return `${input.slice(0, limit - 3)}...`;
}

function canSendMessages(
  channel: Awaited<ReturnType<Client["channels"]["fetch"]>>,
): channel is TextBasedChannel & { send: (content: string) => Promise<unknown> } {
  return (
    channel !== null &&
    channel.isTextBased() &&
    "send" in channel &&
    typeof channel.send === "function"
  );
}
