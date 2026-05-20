import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";

import { loadConfig } from "@voidbot/config";
import {
  buildVoidMcpServerConfig,
  ContextBuilder,
  OllamaSituationalSocialReadInferer,
  PermissionEngine,
  createStateStorage,
  ensureRepoFaceInitialized,
  findRepoDiscordIdentityByRoleIds,
  findRepoDiscordIdentityByTextAddress,
  loadRepoDiscordIdentityRegistry,
  queueAgentHeartbeatMention,
  queueRepoFaceMention,
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
  maybeRegisterCommands,
  parseProviderOverride,
  replyEphemeral,
} from "./discord-bot-handlers";
import {
  buildActorFromInteraction,
  buildChannelIndexingTarget,
  buildGuildContextFromInteraction,
  filterPromptEchoHistoryResults,
  formatArchivedMessageContext,
  formatHistoryResults,
  formatProviderStatuses,
  formatSourceResults,
  getRecentMessages,
  getRoleIdsFromInteraction,
  ingestIfIndexed,
  materializeMessage,
  notifyOwnerOfBotIssue,
  rememberAmbientVoidReference,
  renderSystemMessage,
  searchHistoryWithArchiveFallback,
  stripBotMention,
} from "./discord-bot-support";

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
  let repoDiscordIdentities = await loadRepoDiscordIdentityRegistry(
    config.repoDiscordIdentitiesPath,
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
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) {
      return;
    }

    const isDirectMessage = !message.inGuild();

    await ingestIfIndexed(
      message,
      config.channelIndexing,
      ragPipeline,
      client.user?.id,
      botDirectedRoleIds,
    );
    await rememberAmbientVoidReference(message, client.user?.id, interactionMemory);

    const roleAddressedRepoIdentity = isDirectMessage
      ? undefined
      : findRepoDiscordIdentityByRoleIds(
          repoDiscordIdentities,
          message.mentions.roles.keys(),
          message.channelId,
        );
    const textAddressedRepoIdentity = isDirectMessage
      ? undefined
      : findRepoDiscordIdentityByTextAddress(
          repoDiscordIdentities,
          stripBotMention(message.content),
          message.channelId,
        );
    const addressedRepoIdentity = roleAddressedRepoIdentity ?? textAddressedRepoIdentity;
    const isBotMentioned = Boolean(client.user && message.mentions.has(client.user));

    if (!client.user || (!isDirectMessage && !isBotMentioned && !addressedRepoIdentity)) {
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
          ).trim()
        : stripBotMention(message.content).trim();

    try {
      if (addressedRepoIdentity) {
        if (!visiblePrompt) {
          console.log(`Ignored empty repo Face mention ${message.id} for ${addressedRepoIdentity.id}.`);
          return;
        }
        const faceInitialization = await ensureRepoFaceInitialized({
          identity: addressedRepoIdentity,
          storageRoot: config.storageRoot,
          sourceRepoRoot: config.sourceRepoRoot,
          epiphanyAgentRoot: config.epiphanyAgentRoot,
          workspaceRoot: process.cwd(),
          birthMode: config.repoFaceBirthMode,
          birthExecutor: config.repoFaceBirthExecutor,
        });
        const queuedMention = await queueRepoFaceMention({
          statePath: config.repoFaceHeartbeats.statePath,
          identity: addressedRepoIdentity,
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          authorName: message.author.username,
          content: message.content,
          visiblePrompt,
        });
        console.log(
          `Queued repo Face mention ${message.id} for ${addressedRepoIdentity.id} via heartbeat CTB (${queuedMention.pendingCount} pending). Birth status: ${
            faceInitialization.birthStatusPath ?? faceInitialization.skippedReason ?? "unknown"
          }`,
        );
        return;
      }

      const queuedMention = await queueAgentHeartbeatMention({
        statePath: config.repoFaceHeartbeats.statePath,
        identityId: "void",
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorName: message.author.username,
        content: message.content,
        visiblePrompt: visiblePrompt || "Void was mentioned without a visible prompt; inspect recent room context and decide whether a response is warranted.",
      });
      console.log(
        `Queued Void mention ${message.id} via heartbeat CTB (${queuedMention.pendingCount} pending).`,
      );
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

    await ingestIfIndexed(
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

async function ensureRepoIdentityRoles(options: {
  botToken: string;
  guildId?: string;
  registryPath: string;
  identities: RepoDiscordIdentity[];
}): Promise<{ identities: RepoDiscordIdentity[] }> {
  const identitiesMissingRoles = options.identities.filter((identity) => !identity.roleId);

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
