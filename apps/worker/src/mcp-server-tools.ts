import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";
import { searchHistoryWithArchiveFallback } from "@voidbot/rag";

import { type VoidbotMcpContext } from "./mcp-server-context";
import { openOwnerDmChannel, postDiscordMessage } from "./mcp-server-discord";
import {
  type ListIndexedReposArgs,
  type MessageContextArgs,
  type NotifyOwnerArgs,
  type PostDiscordMessageArgs,
  type SearchHistoryArgs,
  type SearchSourcesArgs,
  type SourceContextArgs,
  formatArchivedMessage,
  formatHistoryResults,
  formatSourceResults,
  messageContextInputSchema,
  notifyOwnerInputSchema,
  postDiscordMessageInputSchema,
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
        "Post a message to a Discord channel or thread as Void. Use this for constructive proactive participation, moderation nudges, or replies when speaking in-channel would genuinely help. Set replyToMessageId to reply to a specific message; omit it for a fresh post.",
      inputSchema: postDiscordMessageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: PostDiscordMessageArgs): Promise<CallToolResult> => {
      const { channelId, content, replyToMessageId } = input;

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
      );

      return {
        content: [
          {
            type: "text",
            text: replyToMessageId
              ? `Posted a reply in Discord channel ${channelId} as message ${posted.id}.`
              : `Posted a message in Discord channel ${channelId} as message ${posted.id}.`,
          },
        ],
        structuredContent: {
          sent: true,
          channelId,
          messageId: posted.id,
          replyToMessageId: replyToMessageId ?? null,
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
