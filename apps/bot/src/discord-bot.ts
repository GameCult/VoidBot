import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";

import { loadConfig } from "@voidbot/config";
import {
  buildVoidMcpServerConfig,
  ContextBuilder,
  OllamaSituationalSocialReadInferer,
  PermissionEngine,
  createStateStorage,
  faceRegistryAsRepoDiscordRegistry,
  findRepoDiscordIdentityByPersonaName,
  findRepoDiscordIdentityByRoleIds,
  findRepoDiscordIdentitiesByTextMentions,
  findRepoDiscordIdentityByTextAddress,
  isRepoDiscordIdentityAllowedInChannel,
  loadFaceIdentityRegistry,
  queueRepoFaceMention,
  exportPersonaFeedbackObservation,
  registerEpiphanyOperatorInteraction,
  submitEpiphanyOperatorRequest,
  type RepoDiscordIdentity,
  stripRepoIdentityTextAddress,
  loadStylePack,
  loadSystemMessageCatalog,
  VoidUsageRateLimiter,
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
} from "@voidbot/rag";
import { shouldIndexChannel } from "@voidbot/shared";

import {
  handleApproveJob,
  handleProfile,
  handlePrompt,
  handleRejectJob,
  handleReindexChannel,
  handleSearchHistory,
  handleSummarizeChannel,
  epiphanyOperatorCommandFromInteraction,
  isExactDiscordOwner,
  maybeRegisterCommands,
  parseProviderOverride,
  replyEphemeral,
} from "./discord-bot-handlers";
import { maybeMirrorOwnerAquariumMessageAsMetameVoice } from "./metame-owner-voice-bridge";
import { startRepoFaceVoicePlayback } from "./repo-face-voice-playback";
import { startEpiphanyOperatorDeliveryConsumer } from "./epiphany-operator-delivery-consumer";
import {
  buildActorFromInteraction,
  buildActorFromMessage,
  buildChannelIndexingTarget,
  buildGuildContextFromInteraction,
  buildGuildContextFromMessage,
  filterPromptEchoHistoryResults,
  formatArchivedMessageContext,
  formatHistoryResults,
  formatProviderStatuses,
  formatSourceResults,
  getRecentMessages,
  getRoleIdsFromInteraction,
  getRoleIdsFromMessage,
  ingestIfIndexed,
  materializeMessage,
  notifyOwnerOfBotIssue,
  rememberAmbientVoidReference,
  renderSystemMessage,
  searchHistoryWithArchiveFallback,
  stripBotMention,
} from "./discord-bot-support";

async function exportPersonaFeedbackWithRetry(input: Parameters<typeof exportPersonaFeedbackObservation>[0], config: Parameters<typeof exportPersonaFeedbackObservation>[1]): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { await exportPersonaFeedbackObservation(input, config); return; }
    catch (error) {
      console.error(`Persona feedback observation export failed (${attempt}/3) for Discord message ${input.messageId}:`, error);
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
    }
  }
}

export async function startBot(): Promise<void> {
  const config = loadConfig();

  if (!config.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required to start the bot.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ],
  });
  let repoDiscordIdentities = faceRegistryAsRepoDiscordRegistry(
    await loadFaceIdentityRegistry(config.repoDiscordIdentitiesPath),
  );
  repoDiscordIdentities = await ensureRepoIdentityRoles({
    botToken: config.botToken,
    guildId: config.developmentGuildId,
    registryPath: config.repoDiscordIdentitiesPath,
    identities: repoDiscordIdentities.identities,
  });
  const botDirectedRoleIds = [
    ...new Set([
      ...config.botTriggerRoleIds,
      ...repoDiscordIdentities.identities
        .map((identity) => identity.roleId)
        .filter((roleId): roleId is string => typeof roleId === "string" && roleId.length > 0),
    ]),
  ];

  const permissionEngine = new PermissionEngine(config.ownerDiscordId, {
    localLlmAllowPublic: config.localLlm.allowPublic,
  });
  const {
    jobQueue,
    auditLog,
    interactionMemory,
    voidUsageRateLimits,
  } = await createStateStorage({
    backend: config.stateStorageBackend,
    databaseDsn: config.databaseDsn,
    jobsFile: config.jobsFile,
    auditLogFile: config.auditLogFile,
    interactionMemoryFile: config.interactionMemoryFile,
    rateLimitStateFile: config.rateLimitStateFile,
  });
  const voidUsageRateLimiter = new VoidUsageRateLimiter(
    voidUsageRateLimits,
    config.rateLimits,
  );
  const contextBuilder = new ContextBuilder();
  const situationalSocialReadInferer = new OllamaSituationalSocialReadInferer({
    ollamaBaseUrl: config.localLlm.ollamaBaseUrl,
    ollamaModel: config.localLlm.socialReadOllamaModel,
    ollamaTimeoutMs: config.localLlm.ollamaTimeoutMs,
    ollamaKeepAlive: config.localLlm.ollamaKeepAlive,
    ollamaNumCtx: config.localLlm.ollamaNumCtx,
  });
  const baseSystemMessagesPath = resolve("config/system-messages.json");
  let activeStylePack = await loadStylePack(config.stylePackPath);
  let activeSystemMessages = await loadSystemMessageCatalog(
    config.systemMessagesPath,
    baseSystemMessagesPath,
  );
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
    personaMemoryPath: config.vectorStore.personaMemoryPath,
    sourceRoot: config.sourceVectorStoreRoot,
    qdrant: config.qdrant,
    historyEmbedder: embedder,
    sourceEmbedder: sourceQueryEmbedder,
    personaMemoryEmbedder: embedder,
  });
  const vectorStore = vectorStores.history;
  const sourceRetrievalStore = vectorStores.source;
  const personaMemoryStore = vectorStores.personaMemory;
  const retrievalService = new RetrievalService(vectorStore, sourceRetrievalStore, personaMemoryStore);
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
      model: config.codexModel,
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
    new OpenAiApiProvider({
      enabled: config.enabledProviders.includes("openai_api"),
      baseUrl: config.openAiApi.baseUrl,
      apiKey: config.openAiApi.apiKey,
      apiKeyFile: config.openAiApi.apiKeyFile,
      model: config.openAiApi.model,
      timeoutMs: config.openAiApi.timeoutMs,
      authHeader: config.openAiApi.authHeader,
      maxCompletionTokens: config.openAiApi.maxCompletionTokens,
    }),
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
          const results = filterPromptEchoHistoryResults(rawResults, input.query).slice(0, input.limit);

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
    startRepoFaceVoicePlayback(readyClient, config.repoFaceDiscordVoice);
    startEpiphanyOperatorDeliveryConsumer({
      applicationId: readyClient.application.id,
      requestStorePath: config.bifrostEpiphanyOperatorRequestStorePath,
      deliveryStorePath: config.bifrostEpiphanyOperatorDeliveryStorePath,
      checkpointStorePath: config.epiphanyOperatorDeliveryCheckpointStorePath,
      bifrostRoot: config.bifrostRoot,
      cultlibRoot: process.env.VOIDBOT_CULTLIB_ROOT,
      pollIntervalMs: config.epiphanyOperatorDeliveryPollIntervalMs,
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) {
      return;
    }

    const isDirectMessage = !message.inGuild();

    await safelyIngestIfIndexed("message-create",
      message,
      config.channelIndexing,
      ragPipeline,
      client.user?.id,
      botDirectedRoleIds,
    );
    await rememberAmbientVoidReference(message, client.user?.id, interactionMemory);
    await maybeMirrorOwnerAquariumMessageAsMetameVoice({
      message,
      registry: repoDiscordIdentities,
      config,
    });

    const roleAddressedRepoIdentity = isDirectMessage
      ? undefined
      : findRepoDiscordIdentityByRoleIds(
          repoDiscordIdentities,
          message.mentions.roles.keys(),
          message.channelId,
        );
    const roleAddressedRepoIdentities = isDirectMessage
      ? []
      : repoDiscordIdentities.identities.filter((identity) =>
          identity.roleId &&
          message.mentions.roles.has(identity.roleId),
        );
    const textAddressedRepoIdentity = isDirectMessage
      ? undefined
      : findRepoDiscordIdentityByTextAddress(
          repoDiscordIdentities,
          stripBotMention(message.content),
          message.channelId,
        );
    const textMentionedRepoIdentities = isDirectMessage
      ? []
      : findRepoDiscordIdentitiesByTextMentions(
          repoDiscordIdentities,
          stripBotMention(message.content),
          message.channelId,
        );
    const repliedRepoIdentity = isDirectMessage ||
      roleAddressedRepoIdentity ||
      textAddressedRepoIdentity
      ? undefined
      : await resolveRepliedRepoIdentity(message, repoDiscordIdentities);
    const addressedRepoIdentities = uniqueRepoIdentities([
      ...roleAddressedRepoIdentities,
      ...textMentionedRepoIdentities,
      ...(repliedRepoIdentity ? [repliedRepoIdentity] : []),
    ]);
    const broadcastAddressedRepoIdentities = !isDirectMessage && addressedRepoIdentities.length === 0 &&
      isRepoFaceBroadcastInvitation(stripBotMention(message.content))
      ? repoDiscordIdentities.identities.filter((identity) =>
          isRepoDiscordIdentityAllowedInChannel(identity, message.channelId),
        )
      : [];
    const pendingRepoIdentities = addressedRepoIdentities.length > 0
      ? addressedRepoIdentities
      : broadcastAddressedRepoIdentities;
    const addressedRepoIdentity = roleAddressedRepoIdentity ?? textAddressedRepoIdentity ?? repliedRepoIdentity;
    const isBotMentioned = Boolean(client.user && message.mentions.has(client.user));

    if (!client.user || (!isDirectMessage && !isBotMentioned && pendingRepoIdentities.length === 0)) {
      return;
    }

    const visiblePrompt = isDirectMessage
      ? message.content.trim()
      : addressedRepoIdentity
        ? stripRepoIdentityTextAddress(
            stripAddressingMentions(
              stripBotMention(message.content),
              roleAddressedRepoIdentity?.roleId,
            ),
            addressedRepoIdentity,
          ).trim() ||
            renderRepliedRepoIdentityPrompt(message, addressedRepoIdentity, repliedRepoIdentity)
        : stripBotMention(message.content).trim();

    try {
      if (pendingRepoIdentities.length > 0) {
        let queuedCount = 0;
        for (const identity of pendingRepoIdentities) {
          const identityVisiblePrompt = renderRepoIdentityVisiblePrompt({
            message,
            identity,
            roleAddressed: roleAddressedRepoIdentities.some((entry) => entry.id === identity.id),
            textAddressed: textAddressedRepoIdentity?.id === identity.id,
            replied: repliedRepoIdentity?.id === identity.id,
            broadcastAddressed: broadcastAddressedRepoIdentities.some((entry) => entry.id === identity.id),
          });
          if (!identityVisiblePrompt) {
            console.log(`Ignored empty repo Face mention ${message.id} for ${identity.id}.`);
            continue;
          }
          const queuedMention = await queueRepoFaceMention({
            statePath: config.repoFaceHeartbeats.statePath,
            identity,
            channelId: message.channelId,
            messageId: message.id,
            authorId: message.author.id,
            authorName: message.author.username,
            content: message.content,
            visiblePrompt: identityVisiblePrompt,
          });
          if (queuedMention.queued) {
            queuedCount += 1;
          }
          console.log(
            `Queued repo Face mention ${message.id} for ${identity.id} via CTB turn queue (${queuedMention.pendingCount} pending).`,
          );
          if (identity.remotePersonaFeedbackTarget && message.guildId) {
            const addressingMode = roleAddressedRepoIdentities.some((entry) => entry.id === identity.id)
              ? "role" : repliedRepoIdentity?.id === identity.id ? "reply"
                : broadcastAddressedRepoIdentities.some((entry) => entry.id === identity.id) ? "broadcast" : "text";
            void exportPersonaFeedbackWithRetry({
              guildId: message.guildId, channelId: message.channelId, messageId: message.id,
              observedAt: message.createdAt.toISOString(), authorId: message.author.id,
              authorName: message.author.username, addressingMode, content: identityVisiblePrompt,
              targetPersonaId: identity.remotePersonaFeedbackTarget.personaId,
              targetRepoName: identity.remotePersonaFeedbackTarget.repoName,
              targetRuntimeId: identity.remotePersonaFeedbackTarget.runtimeId,
            }, { storePath: config.bifrostPersonaFeedbackObservationStorePath, bifrostRoot: config.bifrostRoot, cultlibRoot: process.env.VOIDBOT_CULTLIB_ROOT, producerRuntimeId: "voidbot-yggdrasil" });
          }
        }
        if (queuedCount === 0) {
          console.log(`Repo Face mention ${message.id} matched existing pending obligations only.`);
        }
        return;
      }

      await handlePrompt({
        prompt: visiblePrompt || "Void was mentioned without a visible prompt; inspect recent room context and decide whether a response is warranted.",
        command: "ask",
        actor: buildActorFromMessage(message),
        roleIds: getRoleIdsFromMessage(message),
        guildContext: buildGuildContextFromMessage(message),
        outputChannelId: message.channelId,
        requestMessageId: message.id,
        channel: message.channel.isTextBased() ? message.channel : null,
        respond: async (content) => { await message.reply(content); },
        config,
        permissionEngine,
        contextBuilder,
        retrievalService,
        archiveRepository,
        sourceArchiveRepository,
        jobQueue,
        auditLog,
        interactionMemory,
        voidUsageRateLimiter,
        providerRegistry,
        situationalSocialReadInferer,
        stylePack: activeStylePack,
        systemMessages: activeSystemMessages,
      });
      console.log(`Routed Void mention ${message.id} through the normal bot prompt lane.`);
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

    await safelyIngestIfIndexed("message-update",
      materializedMessage,
      config.channelIndexing,
      ragPipeline,
      client.user?.id,
      botDirectedRoleIds,
    );
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
      const roleIds = getRoleIdsFromInteraction(interaction);
      const guildContext = buildGuildContextFromInteraction(interaction);

      switch (interaction.commandName) {
        case "epiphany": {
          await interaction.deferReply({ ephemeral: true });
          if (!isExactDiscordOwner(actor.id, config.ownerDiscordId)) {
            await replyEphemeral(
              interaction,
              "Refused: Epiphany operator requests require the exact configured Discord owner identity.",
            );
            break;
          }
          if (!interaction.guildId) {
            await replyEphemeral(
              interaction,
              "Refused: Epiphany operator requests require their exact Discord organization provenance.",
            );
            break;
          }
          const issuedAt = new Date().toISOString();
          await registerEpiphanyOperatorInteraction(
            {
              requestId: interaction.id,
              applicationId: interaction.applicationId,
              interactionToken: interaction.token,
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              registeredAt: issuedAt,
            },
            {
              checkpointStorePath: config.epiphanyOperatorDeliveryCheckpointStorePath,
              bifrostRoot: config.bifrostRoot,
              cultlibRoot: process.env.VOIDBOT_CULTLIB_ROOT,
            },
          );
          await replyEphemeral(
            interaction,
            `Epiphany operator request \`${interaction.id}\` is pending Bifrost admission. This request grants no Mind, Hands, release, deployment, or local execution authority.`,
          );
          const request = await submitEpiphanyOperatorRequest(
            {
              interactionId: interaction.id,
              actorDiscordId: actor.id,
              guildId: interaction.guildId,
              channelId: interaction.channelId,
              command: epiphanyOperatorCommandFromInteraction(interaction),
              issuedAt,
            },
            {
              storePath: config.bifrostEpiphanyOperatorRequestStorePath,
              bifrostRoot: config.bifrostRoot,
              cultlibRoot: process.env.VOIDBOT_CULTLIB_ROOT,
              producerRuntimeId: "voidbot-yggdrasil",
            },
          );
          if (request.requestId !== interaction.id) throw new Error("Epiphany request identity changed after interaction registration.");
          break;
        }
        case "ask":
          const requestedProvider = parseProviderOverride(
            interaction.options.getString("provider", false),
          );
          await interaction.deferReply({ ephemeral: true });
          await handlePrompt({
            prompt: interaction.options.getString("question", true),
            command: "ask",
            actor,
            roleIds,
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
            archiveRepository,
            sourceArchiveRepository,
            jobQueue,
            auditLog,
            interactionMemory,
            voidUsageRateLimiter,
            providerRegistry,
            situationalSocialReadInferer,
            stylePack: activeStylePack,
            systemMessages: activeSystemMessages,
            forceProvider: requestedProvider,
          });
          break;
        case "queue-codex":
          await interaction.deferReply({ ephemeral: true });
          await handlePrompt({
            prompt: interaction.options.getString("prompt", true),
            command: "queue-codex",
            actor,
            roleIds,
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
            archiveRepository,
            sourceArchiveRepository,
            jobQueue,
            auditLog,
            interactionMemory,
            voidUsageRateLimiter,
            providerRegistry,
            situationalSocialReadInferer,
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
        case "profile":
          await handleProfile({
            interaction,
            actor,
            interactionMemory,
            auditLog,
            systemMessages: activeSystemMessages,
          });
          break;
        case "search-history":
          await handleSearchHistory(
            interaction,
            retrievalService,
            archiveRepository,
            activeSystemMessages,
          );
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
            client.user?.id,
            botDirectedRoleIds,
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
          activeSystemMessages = await loadSystemMessageCatalog(
            config.systemMessagesPath,
            baseSystemMessagesPath,
          );
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

async function safelyIngestIfIndexed(
  context: string,
  ...args: Parameters<typeof ingestIfIndexed>
): Promise<void> {
  try {
    await ingestIfIndexed(...args);
  } catch (error) {
    console.error(`[${context}] Discord archive ingest failed; continuing without indexing.`, error);
  }
}

async function resolveRepliedRepoIdentity(
  message: Message,
  registry: { identities: RepoDiscordIdentity[] },
): Promise<RepoDiscordIdentity | undefined> {
  if (!message.reference?.messageId) {
    return undefined;
  }

  try {
    const referenced = await message.fetchReference();
    const personaName = referenced.webhookId
      ? referenced.author.username
      : referenced.member?.displayName ?? referenced.author.globalName ?? referenced.author.username;

    return findRepoDiscordIdentityByPersonaName(registry, personaName, message.channelId);
  } catch (error) {
    console.warn(
      `Could not resolve referenced message ${message.reference.messageId} for repo Face reply routing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function renderRepliedRepoIdentityPrompt(
  message: Message,
  addressedRepoIdentity: RepoDiscordIdentity,
  repliedRepoIdentity: RepoDiscordIdentity | undefined,
): string {
  const content = message.content.trim();

  if (content.length > 0) {
    return content;
  }

  if (repliedRepoIdentity?.id === addressedRepoIdentity.id) {
    return `A human replied directly to ${addressedRepoIdentity.displayName}'s previous message without visible text. Inspect the replied-to exchange and decide whether a response is warranted.`;
  }

  return "";
}

function renderRepoIdentityVisiblePrompt(input: {
  message: Message;
  identity: RepoDiscordIdentity;
  roleAddressed: boolean;
  textAddressed: boolean;
  replied: boolean;
  broadcastAddressed: boolean;
}): string {
  const strippedBotMention = stripBotMention(input.message.content);
  if (input.roleAddressed || input.textAddressed) {
    const strippedAddress = stripRepoIdentityTextAddress(
      stripAddressingMentions(strippedBotMention, input.roleAddressed ? input.identity.roleId : undefined),
      input.identity,
    ).trim();
    if (strippedAddress.length > 0) {
      return strippedAddress;
    }
  }

  if (input.broadcastAddressed && strippedBotMention.trim().length > 0) {
    return `The room was explicitly invited to answer. For ${input.identity.displayName}, this invitation is live: ${strippedBotMention.trim()}`;
  }

  if (input.message.content.trim().length > 0) {
    return strippedBotMention.trim();
  }

  return renderRepliedRepoIdentityPrompt(
    input.message,
    input.identity,
    input.replied ? input.identity : undefined,
  );
}

function isRepoFaceBroadcastInvitation(content: string): boolean {
  const normalized = collapseWhitespace(content).toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  return [
    /\b(everyone|everybody|all of you|anyone|anybody|the swarm|you all|y'all)\b/,
    /\bhow (are|is) (everyone|everybody|you all|y'all)\b/,
    /\bwhat about (your|everyone's|everybody's) (minds?|bodies?|feelings?)\b/,
    /\banything i can do to help\b/,
  ].some((pattern) => pattern.test(normalized));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueRepoIdentities(identities: RepoDiscordIdentity[]): RepoDiscordIdentity[] {
  const seen = new Set<string>();
  const result: RepoDiscordIdentity[] = [];
  for (const identity of identities) {
    const key = identity.id.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(identity);
  }
  return result;
}

async function ensureRepoIdentityRoles(options: {
  botToken: string;
  guildId?: string;
  registryPath: string;
  identities: RepoDiscordIdentity[];
}): Promise<{ identities: RepoDiscordIdentity[] }> {
  const identitiesMissingRoles = options.identities.filter((identity) =>
    identity.identityKind !== "native_persona" && !identity.roleId);

  if (identitiesMissingRoles.length === 0) {
    return { identities: options.identities };
  }

  if (!options.guildId) {
    console.warn(
      `Repo Discord identities missing roles, but DISCORD_GUILD_ID is not configured: ${
        identitiesMissingRoles.map((identity) => identity.id).join(", ")
      }`,
    );
    return { identities: options.identities };
  }

  try {
    const existingRoles = await fetchGuildRoles(options.botToken, options.guildId);
    const nextIdentities = [...options.identities];
    let changed = false;

    for (const identity of identitiesMissingRoles) {
      const existingRole = existingRoles.find((role) => role.name === identity.displayName);
      const roleId = existingRole?.id ?? await createRepoIdentityRole(
        options.botToken,
        options.guildId,
        identity.displayName,
      );
      const index = nextIdentities.findIndex((entry) => entry.id === identity.id);

      if (index !== -1) {
        nextIdentities[index] = {
          ...nextIdentities[index],
          roleId,
        };
        changed = true;
      }
    }

    if (changed) {
      await writeRepoIdentityRegistry(options.registryPath, nextIdentities);
    }

    return { identities: nextIdentities };
  } catch (error) {
    console.warn(
      `Failed to ensure repo identity Discord roles: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { identities: options.identities };
  }
}

async function fetchGuildRoles(
  botToken: string,
  guildId: string,
): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
    method: "GET",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Discord role lookup failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as Array<{ id?: string; name?: string }>;
  return payload
    .filter((role): role is { id: string; name: string } => Boolean(role.id && role.name));
}

async function createRepoIdentityRole(
  botToken: string,
  guildId: string,
  name: string,
): Promise<string> {
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mentionable: true,
      hoist: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Discord role creation failed for ${name}: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as { id?: string };
  if (!payload.id) {
    throw new Error(`Discord role creation for ${name} returned no role id.`);
  }

  return payload.id;
}

async function writeRepoIdentityRegistry(
  registryPath: string,
  identities: RepoDiscordIdentity[],
): Promise<void> {
  let existing: unknown;

  try {
    existing = JSON.parse(stripLeadingBom(await readFile(registryPath, "utf8"))) as unknown;
  } catch {
    existing = {};
  }

  const payload = Array.isArray(existing)
    ? identities
    : {
        ...(isRecord(existing) ? existing : {}),
        identities,
      };
  await writeFile(registryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function stripAddressingMentions(content: string, roleId?: string): string {
  if (!roleId) {
    return content;
  }

  return content.replace(new RegExp(`<@&${escapeRegExp(roleId)}>`, "g"), "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
