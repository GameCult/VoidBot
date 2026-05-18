import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";
import { searchHistoryWithArchiveFallback } from "@voidbot/rag";
import {
  applyVoidSelfStateOperation,
  buildVoidSelfStateContext,
  findRepoDiscordIdentity,
  isRepoDiscordIdentityAllowedInChannel,
  loadRepoDiscordIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  resolveRepoFaceStatePath,
} from "@voidbot/core";

import { type VoidbotMcpContext } from "./mcp-server-context";
import { openOwnerDmChannel, postDiscordMessage } from "./mcp-server-discord";
import {
  type ListIndexedReposArgs,
  type MessageContextArgs,
  type NotifyOwnerArgs,
  type ApplyRepoFaceStateOperationArgs,
  type PostDiscordMessageArgs,
  type PostRepoIdentityMessageArgs,
  type RepoFaceStateArgs,
  type SearchHistoryArgs,
  type SearchSourcesArgs,
  type SourceContextArgs,
  formatArchivedMessage,
  formatHistoryResults,
  formatSourceResults,
  applyRepoFaceStateOperationInputSchema,
  messageContextInputSchema,
  notifyOwnerInputSchema,
  postDiscordMessageInputSchema,
  postRepoIdentityMessageInputSchema,
  repoFaceStateInputSchema,
  renderJsonBlock,
  searchHistoryInputSchema,
  searchSourcesInputSchema,
  sourceContextInputSchema,
} from "./mcp-server-shared";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerVoidbotTools(
  server: McpServer,
  context: VoidbotMcpContext,
): void {
  server.registerTool(
    "search_history",
    {
      title: "Search Discord History",
      description:
        "Search archived Discord history with semantic retrieval. Use this for historical discussion, decisions, preferences, and prior conversations.",
      inputSchema: searchHistoryInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: SearchHistoryArgs): Promise<CallToolResult> => {
      const { query, limit, guildId, channelId, authorId } = input;
      const results = await searchHistoryWithArchiveFallback({
        retrievalService: context.retrievalService,
        archiveRepository: context.archiveRepository,
        query,
        limit: limit ?? DEFAULT_RETRIEVAL_RESULT_LIMIT,
        guildId,
        channelId,
        authorId,
      });
      const formattedResults = formatHistoryResults(results);

      return {
        content: [
          {
            type: "text",
            text:
              formattedResults.length > 0
                ? renderJsonBlock({
                    query,
                    resultCount: formattedResults.length,
                    results: formattedResults,
                  })
                : `No archived Discord history matched "${query}".`,
          },
        ],
        structuredContent: {
          query,
          resultCount: formattedResults.length,
          results: formattedResults,
        },
      };
    },
  );

  server.registerTool(
    "list_indexed_repos",
    {
      title: "List Indexed Repositories",
      description:
        "List the indexed source and lore repositories currently available to search. Use this when you want valid repoName filters for search_sources.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (_input: ListIndexedReposArgs): Promise<CallToolResult> => {
      const repos = await context.sourceArchiveRepository.listRepoSummaries();

      return {
        content: [
          {
            type: "text",
            text:
              repos.length > 0
                ? renderJsonBlock({
                    repoCount: repos.length,
                    repos,
                  })
                : "No indexed source repositories are currently available.",
          },
        ],
        structuredContent: {
          repoCount: repos.length,
          repos,
        },
      };
    },
  );

  server.registerTool(
    "search_sources",
    {
      title: "Search Repository Sources",
      description:
        "Search indexed source trees and lore repositories with semantic retrieval. Use this for code structure, implementation details, lore references, and repo-local documentation. Omit repoName to search across all indexed repos, or call list_indexed_repos first if you need valid repoName options.",
      inputSchema: searchSourcesInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: SearchSourcesArgs): Promise<CallToolResult> => {
      const { query, limit, repoName, pathPrefix, language } = input;
      const results = await context.retrievalService.searchRepositorySources(
        query,
        limit ?? DEFAULT_RETRIEVAL_RESULT_LIMIT,
        {
          repoName,
          pathPrefix,
          language,
        },
      );
      const formattedResults = formatSourceResults(results);

      return {
        content: [
          {
            type: "text",
            text:
              formattedResults.length > 0
                ? renderJsonBlock({
                    query,
                    resultCount: formattedResults.length,
                    results: formattedResults,
                  })
                : `No indexed source documents matched "${query}".`,
          },
        ],
        structuredContent: {
          query,
          resultCount: formattedResults.length,
          results: formattedResults,
        },
      };
    },
  );

  server.registerTool(
    "get_source_context",
    {
      title: "Get Source Context",
      description:
        "Fetch a surrounding chunk window from an indexed source document. Use after search_sources when you need adjacent code, prose, or lore context inside a file.",
      inputSchema: sourceContextInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: SourceContextArgs): Promise<CallToolResult> => {
      const { sourceId, chunkIndex, before, after } = input;
      const document = await context.sourceArchiveRepository.get(sourceId);

      if (!document) {
        return {
          content: [
            {
              type: "text",
              text: `No indexed source document with ID ${sourceId} was found.`,
            },
          ],
          structuredContent: {
            found: false,
            sourceId,
            chunks: [],
          },
          isError: true,
        };
      }

      const chunks = context.sourceDocumentIngester.buildContextWindow(
        document,
        chunkIndex ?? 0,
        before ?? 1,
        after ?? 1,
      );
      const anchorIndex =
        chunks.find((chunk) => chunk.chunkIndex === (chunkIndex ?? 0))?.chunkIndex ??
        chunks[0]?.chunkIndex ??
        0;
      const formattedChunks = chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        chunkIndex: chunk.chunkIndex,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        isAnchor: chunk.chunkIndex === anchorIndex,
        text: chunk.text,
      }));

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              found: true,
              sourceId,
              repoName: document.repoName,
              path: document.path,
              language: document.language,
              count: formattedChunks.length,
              chunks: formattedChunks,
            }),
          },
        ],
        structuredContent: {
          found: true,
          sourceId,
          repoName: document.repoName,
          path: document.path,
          language: document.language,
          count: formattedChunks.length,
          chunks: formattedChunks,
        },
      };
    },
  );

  server.registerTool(
    "get_message_context",
    {
      title: "Get Message Context",
      description:
        "Fetch the surrounding conversation window for a specific archived Discord message ID. Use after search_history when you need neighboring context or thread flow.",
      inputSchema: messageContextInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: MessageContextArgs): Promise<CallToolResult> => {
      const { messageId, before, after } = input;
      const anchor = await context.archiveRepository.get(messageId);

      if (!anchor) {
        return {
          content: [
            {
              type: "text",
              text: `No archived message with ID ${messageId} was found.`,
            },
          ],
          structuredContent: {
            found: false,
            messageId,
            messages: [],
          },
          isError: true,
        };
      }

      const messages = await context.archiveRepository.listContextWindow(
        messageId,
        before ?? 4,
        after ?? 4,
      );
      const formattedMessages = messages.map((message) => formatArchivedMessage(message, messageId));

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              found: true,
              messageId,
              count: formattedMessages.length,
              messages: formattedMessages,
            }),
          },
        ],
        structuredContent: {
          found: true,
          messageId,
          count: formattedMessages.length,
          messages: formattedMessages,
        },
      };
    },
  );

  server.registerTool(
    "post_discord_message",
    {
      title: "Post Discord Message",
      description:
        "Post a message to a Discord channel or thread. Use this for constructive proactive participation, moderation nudges, or replies when speaking in-channel would genuinely help. Set replyToMessageId to reply to a specific message; omit it for a fresh post. Supply personaName and optional personaAvatarUrl when an agent should speak through the shared webhook pipe as itself instead of the base bot identity.",
      inputSchema: postDiscordMessageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: PostDiscordMessageArgs): Promise<CallToolResult> => {
      const { channelId, content, replyToMessageId, personaName, personaAvatarUrl } = input;

      if (!context.config.botToken) {
        return {
          content: [
            {
              type: "text",
              text: "DISCORD_BOT_TOKEN is not configured, so Discord posting is unavailable.",
            },
          ],
          structuredContent: {
            sent: false,
            reason: "missing_bot_token",
            channelId,
          },
          isError: true,
        };
      }

      const posted = await postDiscordMessage(
        context.config.botToken,
        channelId,
        content,
        replyToMessageId,
        {
          personaName,
          personaAvatarUrl,
        },
      );

      return {
        content: [
          {
            type: "text",
            text:
              replyToMessageId
                ? `Posted a reply in Discord channel ${channelId} as message ${posted.id} via ${posted.transport}.`
                : `Posted a message in Discord channel ${channelId} as message ${posted.id} via ${posted.transport}.`,
          },
        ],
        structuredContent: {
          sent: true,
          channelId,
          messageId: posted.id,
          transport: posted.transport,
          personaName: personaName ?? null,
          personaAvatarUrl: personaAvatarUrl ?? null,
          replyToMessageId: replyToMessageId ?? null,
        },
      };
    },
  );

  server.registerTool(
    "list_repo_discord_identities",
    {
      title: "List Repo Discord Identities",
      description:
        "List registered repo identities that can be addressed by Discord roles and speak through the shared webhook persona pipe.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (): Promise<CallToolResult> => {
      const registry = await loadRepoDiscordIdentityRegistry(
        context.config.repoDiscordIdentitiesPath,
      );
      const identities = registry.identities.map((identity) => ({
        id: identity.id,
        repoName: identity.repoName,
        displayName: identity.displayName,
        roleId: identity.roleId ?? null,
        mention: identity.roleId ? `<@&${identity.roleId}>` : null,
        allowedChannelIds: identity.allowedChannelIds,
        hasAvatarUrl: Boolean(identity.avatarUrl),
        description: identity.description ?? null,
      }));

      return {
        content: [
          {
            type: "text",
            text:
              identities.length > 0
                ? renderJsonBlock({
                    identityCount: identities.length,
                    identities,
                  })
                : "No repo Discord identities are registered.",
          },
        ],
        structuredContent: {
          identityCount: identities.length,
          identities,
        },
      };
    },
  );

  server.registerTool(
    "post_repo_identity_message",
    {
      title: "Post Repo Identity Message",
      description:
        "Post in Discord as a registered repo identity. The identity's Discord role is the mention target; this tool speaks through the shared webhook persona pipe using the registered display name and avatar.",
      inputSchema: postRepoIdentityMessageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: PostRepoIdentityMessageArgs): Promise<CallToolResult> => {
      const { identity: identitySelector, channelId, content, replyToMessageId } = input;
      const registry = await loadRepoDiscordIdentityRegistry(
        context.config.repoDiscordIdentitiesPath,
      );
      const identity = findRepoDiscordIdentity(registry, identitySelector);

      if (!identity) {
        return {
          content: [
            {
              type: "text",
              text: `No registered repo Discord identity matched "${identitySelector}".`,
            },
          ],
          structuredContent: {
            sent: false,
            reason: "unknown_identity",
            identity: identitySelector,
          },
          isError: true,
        };
      }

      if (!isRepoDiscordIdentityAllowedInChannel(identity, channelId)) {
        return {
          content: [
            {
              type: "text",
              text: `Repo identity ${identity.id} is not registered for Discord channel ${channelId}.`,
            },
          ],
          structuredContent: {
            sent: false,
            reason: "channel_not_allowed",
            identity: identity.id,
            channelId,
            allowedChannelIds: identity.allowedChannelIds,
          },
          isError: true,
        };
      }

      if (!context.config.botToken) {
        return {
          content: [
            {
              type: "text",
              text: "DISCORD_BOT_TOKEN is not configured, so Discord posting is unavailable.",
            },
          ],
          structuredContent: {
            sent: false,
            reason: "missing_bot_token",
            channelId,
            identity: identity.id,
          },
          isError: true,
        };
      }

      const posted = await postDiscordMessage(
        context.config.botToken,
        channelId,
        content,
        replyToMessageId,
        {
          personaName: identity.displayName,
          personaAvatarUrl: identity.avatarUrl,
        },
      );

      return {
        content: [
          {
            type: "text",
            text: replyToMessageId
              ? `Posted a reply in Discord channel ${channelId} as ${identity.displayName} (${identity.id}) message ${posted.id} via ${posted.transport}.`
              : `Posted a message in Discord channel ${channelId} as ${identity.displayName} (${identity.id}) message ${posted.id} via ${posted.transport}.`,
          },
        ],
        structuredContent: {
          sent: true,
          channelId,
          messageId: posted.id,
          transport: posted.transport,
          identity: identity.id,
          repoName: identity.repoName,
          personaName: identity.displayName,
          roleId: identity.roleId ?? null,
          mention: identity.roleId ? `<@&${identity.roleId}>` : null,
          replyToMessageId: replyToMessageId ?? null,
        },
      };
    },
  );

  server.registerTool(
    "read_repo_face_state",
    {
      title: "Read Repo Face State",
      description:
        "Read the typed persistent Face state for a registered repo identity. Face state uses the same typed operation machinery as Void, but the state file belongs to the repo identity.",
      inputSchema: repoFaceStateInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: RepoFaceStateArgs): Promise<CallToolResult> => {
      const resolved = await resolveRepoIdentityForTool(context, input.identity);

      if (!resolved.identity) {
        return resolved.error;
      }

      const typedState = await loadVoidSelfStateTypedDocuments({
        canonicalPath: resolved.faceStatePath,
      });
      const rendered = buildVoidSelfStateContext(typedState, {
        sourcePath: resolved.faceStatePath,
      });

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              identity: identityForToolResult(resolved.identity),
              faceStatePath: resolved.faceStatePath,
              summary: rendered.summary,
              typedState,
            }),
          },
        ],
        structuredContent: {
          identity: identityForToolResult(resolved.identity),
          faceStatePath: resolved.faceStatePath,
          summary: rendered.summary,
          typedState,
        },
      };
    },
  );

  server.registerTool(
    "apply_repo_face_state_operation",
    {
      title: "Apply Repo Face State Operation",
      description:
        "Apply one typed state operation to a registered repo identity's Face state. Use this for Face memory, incubation, agency pressure, candidate interventions, and receipts; do not edit the Face state file directly.",
      inputSchema: applyRepoFaceStateOperationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: ApplyRepoFaceStateOperationArgs): Promise<CallToolResult> => {
      const resolved = await resolveRepoIdentityForTool(context, input.identity);

      if (!resolved.identity) {
        return resolved.error;
      }

      const result = await applyVoidSelfStateOperation(
        { canonicalPath: resolved.faceStatePath },
        input.operation,
      );

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              applied: true,
              identity: identityForToolResult(resolved.identity),
              faceStatePath: resolved.faceStatePath,
              result,
            }),
          },
        ],
        structuredContent: {
          applied: true,
          identity: identityForToolResult(resolved.identity),
          faceStatePath: resolved.faceStatePath,
          result,
        },
      };
    },
  );

  server.registerTool(
    "notify_owner",
    {
      title: "Notify Owner",
      description:
        "Send a Discord DM to the configured owner. Use for completion notices, progress updates, or when explicitly asked to ping them.",
      inputSchema: notifyOwnerInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: NotifyOwnerArgs): Promise<CallToolResult> => {
      const { message } = input;
      if (!context.config.botToken) {
        return {
          content: [
            {
              type: "text",
              text: "DISCORD_BOT_TOKEN is not configured, so notifications are unavailable.",
            },
          ],
          structuredContent: {
            sent: false,
            reason: "missing_bot_token",
          },
          isError: true,
        };
      }

      const dmChannelId = await openOwnerDmChannel(context.config.botToken, context.config.ownerDiscordId);
      const posted = await postDiscordMessage(context.config.botToken, dmChannelId, message);

      return {
        content: [
          {
            type: "text",
            text: `Sent a Discord DM to the owner as message ${posted.id}.`,
          },
        ],
        structuredContent: {
          sent: true,
          channelId: dmChannelId,
          messageId: posted.id,
        },
      };
    },
  );
}

async function resolveRepoIdentityForTool(
  context: VoidbotMcpContext,
  identitySelector: string,
): Promise<
  | {
      identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>;
      faceStatePath: string;
    }
  | {
      identity?: undefined;
      error: CallToolResult;
    }
> {
  const registry = await loadRepoDiscordIdentityRegistry(
    context.config.repoDiscordIdentitiesPath,
  );
  const identity = findRepoDiscordIdentity(registry, identitySelector);

  if (!identity) {
    return {
      error: {
        content: [
          {
            type: "text",
            text: `No registered repo Discord identity matched "${identitySelector}".`,
          },
        ],
        structuredContent: {
          found: false,
          reason: "unknown_identity",
          identity: identitySelector,
        },
        isError: true,
      },
    };
  }

  return {
    identity,
    faceStatePath: resolveRepoFaceStatePath(identity, context.config.storageRoot),
  };
}

function identityForToolResult(identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>) {
  return {
    id: identity.id,
    repoName: identity.repoName,
    displayName: identity.displayName,
    roleId: identity.roleId ?? null,
    mention: identity.roleId ? `<@&${identity.roleId}>` : null,
  };
}
