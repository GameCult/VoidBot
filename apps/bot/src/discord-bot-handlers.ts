import {
  REST,
  Routes,
  SlashCommandBuilder,
  type CacheType,
  type ChatInputCommandInteraction,
  type Client,
  type TextBasedChannel,
} from "discord.js";

import type { AppConfig } from "@voidbot/config";
import {
  ContextBuilder,
  extractDirectPromptPronounEvidence,
  type OllamaSituationalSocialReadInferer,
  PermissionEngine,
  type AuditLog,
  type InteractionMemoryBank,
  type JobQueue,
  type SystemMessageCatalog,
  type VoidUsageRateLimiter,
} from "@voidbot/core";
import type { ProviderRegistry } from "@voidbot/providers";
import {
  FileSourceDocumentArchiveRepository,
  RagPipeline,
  RetrievalService,
} from "@voidbot/rag";
import {
  type Actor,
  type CommandName,
  type GuildContext,
  type InteractionMemoryProfile,
  type JobRecord,
  type ProviderName,
  type StylePack,
  isProviderName,
  shouldIndexChannel,
} from "@voidbot/shared";

import {
  buildChannelIndexingTarget,
  canSendMessages,
  convertDiscordMessageToArchive,
  getRecentMessages,
  inferSourceGroundingHint,
  renderRateLimitMessage,
  renderSystemMessage,
  renderInteractionProfileDisclosure,
  sendDirectMessage,
  sendChunkedChannelMessage,
  splitDiscordContent,
  truncate,
} from "./discord-bot-support";

export const commandDefinitions = [
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
    .setName("profile")
    .setDescription("DM your current Void profile read to you."),
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

export interface PromptHandlerOptions {
  prompt: string;
  command: CommandName;
  actor: Actor;
  roleIds: string[];
  guildContext: GuildContext;
  outputChannelId: string;
  requestMessageId?: string;
  channel: TextBasedChannel | null;
  respond: (content: string) => Promise<void>;
  config: AppConfig;
  permissionEngine: PermissionEngine;
  contextBuilder: ContextBuilder;
  retrievalService: RetrievalService;
  sourceArchiveRepository: FileSourceDocumentArchiveRepository;
  jobQueue: JobQueue;
  auditLog: AuditLog;
  interactionMemory: InteractionMemoryBank;
  voidUsageRateLimiter: VoidUsageRateLimiter;
  providerRegistry: ProviderRegistry;
  situationalSocialReadInferer?: OllamaSituationalSocialReadInferer;
  stylePack?: StylePack;
  systemMessages: SystemMessageCatalog;
  forceProvider?: ProviderName;
  silentOwnerQueueAck?: boolean;
}

export async function handlePrompt(options: PromptHandlerOptions): Promise<void> {
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

  const rateLimitDecision = await options.voidUsageRateLimiter.consume({
    actorId: options.actor.id,
    roleIds: options.roleIds,
    command: options.command,
    provider: providerName,
    guildId: options.guildContext.guildId,
    channelId: options.guildContext.channelId,
  });

  if (!rateLimitDecision.allowed) {
    await options.auditLog.record({
      type: "rate_limit.denied",
      actorId: options.actor.id,
      provider: providerName,
      details: {
        command: options.command,
        reason: rateLimitDecision.reason,
        dailyCount: rateLimitDecision.dailyCount,
        dailyLimit: rateLimitDecision.policy.dailyLimit ?? null,
        cooldownSeconds: rateLimitDecision.policy.cooldownSeconds ?? null,
        retryAfterSeconds: rateLimitDecision.retryAfterSeconds ?? null,
        resetsAt: rateLimitDecision.resetsAt ?? null,
        modifier: rateLimitDecision.policy.modifier,
        matchedSubjects: rateLimitDecision.policy.matchedSubjects,
      },
    });
    await options.respond(renderRateLimitMessage(options.systemMessages, rateLimitDecision));
    return;
  }

  const rememberedInteraction = await options.interactionMemory.recordInteraction({
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
  let interactionMemory =
    rememberedInteraction.totalInteractions > 0 ? rememberedInteraction : undefined;

  const recentMessages = await getRecentMessages(options.channel, 10);
  const situationalSocialRead = await inferSituationalSocialRead(options, {
    recentMessages,
    interactionMemory,
  });
  const directPromptPronounEvidence = extractDirectPromptPronounEvidence(
    options.prompt,
  );
  const combinedPronounEvidence = [
    ...directPromptPronounEvidence,
    ...(situationalSocialRead?.pronounEvidence ?? []),
  ];

  if (combinedPronounEvidence.length > 0) {
    interactionMemory =
      (await options.interactionMemory.recordPronounEvidence(
        options.actor.id,
        options.actor.displayName,
        combinedPronounEvidence,
      )) ?? interactionMemory;
  }

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
    situationalSocialRead,
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
      outputPreview: truncate(response.outputText ?? response.summary, 500),
    },
  });

  await options.respond(response.outputText ?? response.summary);
}

export async function handleApproveJob(options: {
  interaction: ChatInputCommandInteraction<CacheType>;
  client: Client;
  actor: Actor;
  jobQueue: JobQueue;
  auditLog: AuditLog;
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

export async function handleRejectJob(options: {
  interaction: ChatInputCommandInteraction<CacheType>;
  actor: Actor;
  jobQueue: JobQueue;
  auditLog: AuditLog;
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

export async function handleSearchHistory(
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

export async function handleSummarizeChannel(
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

export async function handleProfile(options: {
  interaction: ChatInputCommandInteraction<CacheType>;
  actor: Actor;
  interactionMemory: InteractionMemoryBank;
  auditLog: AuditLog;
  systemMessages: SystemMessageCatalog;
}): Promise<void> {
  const profile = await options.interactionMemory.getProfile(options.actor.id);
  const disclosure = renderInteractionProfileDisclosure(
    options.actor.displayName,
    profile,
  );

  if (!options.interaction.inGuild()) {
    await replyEphemeral(options.interaction, disclosure);
    return;
  }

  try {
    await sendDirectMessage(options.interaction.user, disclosure);
    await options.auditLog.record({
      type: "profile.dm_sent",
      actorId: options.actor.id,
      details: {
        command: "profile",
        channelId: options.interaction.channelId,
        channelName:
          options.interaction.channel && "name" in options.interaction.channel
            ? options.interaction.channel.name ?? null
            : null,
      },
    });
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "profile.dm_sent"),
    );
  } catch (error) {
    await options.auditLog.record({
      type: "profile.dm_failed",
      actorId: options.actor.id,
      details: {
        command: "profile",
        channelId: options.interaction.channelId,
        channelName:
          options.interaction.channel && "name" in options.interaction.channel
            ? options.interaction.channel.name ?? null
            : null,
        errorMessage:
          error instanceof Error ? error.message : "Unexpected DM delivery failure.",
      },
    });
    await replyEphemeral(
      options.interaction,
      renderSystemMessage(options.systemMessages, "profile.dm_failed"),
    );
  }
}

export async function handleReindexChannel(
  interaction: ChatInputCommandInteraction<CacheType>,
  actor: Actor,
  channelIndexing: AppConfig["channelIndexing"],
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

export function parseProviderOverride(value: string | null): ProviderName | undefined {
  if (!value || value === "auto") {
    return undefined;
  }

  return isProviderName(value) ? value : undefined;
}

export async function maybeRegisterCommands(
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

export async function replyEphemeral(
  interaction: ChatInputCommandInteraction<CacheType>,
  content: string,
): Promise<void> {
  const chunks = splitDiscordContent(content);

  if (interaction.replied) {
    for (const chunk of chunks) {
      await interaction.followUp({ content: chunk, ephemeral: true });
    }

    return;
  }

  if (interaction.deferred) {
    await interaction.editReply({ content: chunks[0] });

    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, ephemeral: true });
    }

    return;
  }

  await interaction.reply({ content: chunks[0], ephemeral: true });

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ephemeral: true });
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

async function postFinalResponse(client: Client, job: JobRecord, finalResponse: string): Promise<void> {
  const channel = await client.channels.fetch(job.outputChannelId);

  if (!canSendMessages(channel)) {
    throw new Error(`Channel ${job.outputChannelId} is not available for publishing.`);
  }

  await sendChunkedChannelMessage(channel, finalResponse);
}

async function inferSituationalSocialRead(
  options: PromptHandlerOptions,
  input: {
    recentMessages: Awaited<ReturnType<typeof getRecentMessages>>;
    interactionMemory?: InteractionMemoryProfile;
  },
) {
  if (!options.situationalSocialReadInferer) {
    return undefined;
  }

  try {
    const read = await options.situationalSocialReadInferer.infer({
      prompt: options.prompt,
      actor: options.actor,
      recentMessages: input.recentMessages,
      interactionMemory: input.interactionMemory,
    });

    if (!read) {
      return undefined;
    }

    await options.auditLog.record({
      type: "situational_social_read.inferred",
      actorId: options.actor.id,
      provider: "local_llm",
      details: {
        command: options.command,
        channelId: options.guildContext.channelId,
        channelName: options.guildContext.channelName ?? null,
        promptExcerpt: truncate(options.prompt, 280),
        recentMessageCount: input.recentMessages.length,
        model: options.config.localLlm.ollamaModel,
        summary: read.summary,
        roomTone: read.roomTone,
        speakerCurrentRead: read.speakerCurrentRead,
        socialFrame: read.socialFrame,
        responseGuidance: read.responseGuidance,
        supportingSignals: read.supportingSignals,
        pronounEvidence: read.pronounEvidence,
      },
    });

    return read;
  } catch (error) {
    await options.auditLog.record({
      type: "situational_social_read.failed",
      actorId: options.actor.id,
      provider: "local_llm",
      details: {
        command: options.command,
        channelId: options.guildContext.channelId,
        channelName: options.guildContext.channelName ?? null,
        promptExcerpt: truncate(options.prompt, 280),
        model: options.config.localLlm.ollamaModel,
        errorMessage:
          error instanceof Error ? error.message : "Unexpected situational social read failure.",
      },
    });

    return undefined;
  }
}
