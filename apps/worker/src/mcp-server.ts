import { resolve } from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { config as loadDotenv } from "dotenv";
import { z } from "zod/v3";

import { loadConfig } from "@voidbot/config";
import {
  DEFAULT_RETRIEVAL_RESULT_LIMIT,
  MAX_RETRIEVAL_RESULT_LIMIT,
  type RetrievalResult,
} from "@voidbot/shared";
import {
  createTextEmbedder,
  createVectorStores,
  FileMessageArchiveRepository,
  FileSourceDocumentArchiveRepository,
  RetrievalService,
  SourceDocumentIngester,
  type ArchivedMessageRecord,
} from "@voidbot/rag";

const workspaceRoot = resolve(process.env.VOIDBOT_WORKSPACE_ROOT ?? process.cwd());
loadDotenv({ path: resolve(workspaceRoot, ".env") });
process.chdir(workspaceRoot);

const config = loadConfig();
const archiveRepository = new FileMessageArchiveRepository(config.ragArchivePath);
const sourceArchiveRepository = new FileSourceDocumentArchiveRepository(config.ragSourceArchivePath);
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
const retrievalService = new RetrievalService(
  historyVectorStore,
  sourceVectorStore,
);
const sourceDocumentIngester = new SourceDocumentIngester();

const server = new McpServer(
  {
    name: "voidbot",
    version: "0.1.0",
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

const searchHistoryInputSchema = {
  query: z.string().min(1).max(240),
  limit: z.number().int().min(1).max(MAX_RETRIEVAL_RESULT_LIMIT).optional(),
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  authorId: z.string().min(1).optional(),
};

const messageContextInputSchema = {
  messageId: z.string().min(1),
  before: z.number().int().min(0).max(20).optional(),
  after: z.number().int().min(0).max(20).optional(),
};

const notifyOwnerInputSchema = {
  message: z.string().min(1).max(1800),
};

const searchSourcesInputSchema = {
  query: z.string().min(1).max(240),
  limit: z.number().int().min(1).max(MAX_RETRIEVAL_RESULT_LIMIT).optional(),
  repoName: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
};

const sourceContextInputSchema = {
  sourceId: z.string().min(1),
  chunkIndex: z.number().int().min(0).optional(),
  before: z.number().int().min(0).max(20).optional(),
  after: z.number().int().min(0).max(20).optional(),
};

interface SearchHistoryArgs {
  query: string;
  limit?: number;
  guildId?: string;
  channelId?: string;
  authorId?: string;
}

interface MessageContextArgs {
  messageId: string;
  before?: number;
  after?: number;
}

interface NotifyOwnerArgs {
  message: string;
}

interface ListIndexedReposArgs {
  [key: string]: never;
}

interface SearchSourcesArgs {
  query: string;
  limit?: number;
  repoName?: string;
  pathPrefix?: string;
  language?: string;
}

interface SourceContextArgs {
  sourceId: string;
  chunkIndex?: number;
  before?: number;
  after?: number;
}

server.registerResource(
  "indexed_repos",
  "voidbot://repos/indexed",
  {
    title: "Indexed Repositories",
    description:
      "List the indexed source and lore repositories currently available to search.",
    mimeType: "application/json",
  },
  async (uri) => {
    const repos = await sourceArchiveRepository.listRepoSummaries();
    return jsonResource(uri, {
      repoCount: repos.length,
      repos,
    });
  },
);

server.registerResource(
  "retrieval_guide",
  "voidbot://retrieval/guide",
  {
    title: "Retrieval Guide",
    description:
      "Quick guide to the available semantic-search resource templates for history, source, and lore retrieval.",
    mimeType: "application/json",
  },
  async (uri) =>
    jsonResource(uri, {
      resources: [
        {
          uri: "voidbot://repos/indexed",
          purpose: "List indexed source and lore repos.",
        },
      ],
      templates: [
        {
          uriTemplate: "voidbot://history/search/{query}",
          purpose: "Semantic search across archived Discord history.",
        },
        {
          uriTemplate: "voidbot://history/context/{messageId}",
          purpose: "Fetch a surrounding conversation window around one archived message.",
        },
        {
          uriTemplate: "voidbot://sources/search/{query}",
          purpose: "Semantic search across all indexed source trees and lore repositories.",
        },
        {
          uriTemplate: "voidbot://sources/repo/{repoName}/search/{query}",
          purpose: "Semantic search scoped to one indexed source or lore repository.",
        },
        {
          uriTemplate: "voidbot://sources/context/{sourceId}/{chunkIndex}",
          purpose: "Fetch a chunk window around one indexed source or lore document.",
        },
      ],
    }),
);

server.registerResource(
  "history_search",
  new ResourceTemplate("voidbot://history/search/{query}", { list: undefined }),
  {
    title: "History Search",
    description:
      "Semantic search across archived Discord history.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const query = getRequiredVariable(variables, "query", "history search");
    const results = await retrievalService.searchHistory(
      query,
      DEFAULT_RETRIEVAL_RESULT_LIMIT,
    );

    return jsonResource(uri, {
      query,
      resultCount: results.length,
      results: formatHistoryResults(results),
    });
  },
);

server.registerResource(
  "history_context",
  new ResourceTemplate("voidbot://history/context/{messageId}", { list: undefined }),
  {
    title: "History Context",
    description:
      "Fetch the surrounding conversation window for one archived Discord message ID.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const messageId = getRequiredVariable(variables, "messageId", "history context");
    const anchor = await archiveRepository.get(messageId);

    if (!anchor) {
      return jsonResource(uri, {
        found: false,
        messageId,
        messages: [],
      });
    }

    const messages = await archiveRepository.listContextWindow(messageId, 2, 2);

    return jsonResource(uri, {
      found: true,
      messageId,
      count: messages.length,
      messages: messages.map((message) => formatArchivedMessage(message, messageId)),
    });
  },
);

server.registerResource(
  "source_search",
  new ResourceTemplate("voidbot://sources/search/{query}", { list: undefined }),
  {
    title: "Source Search",
    description:
      "Semantic search across all indexed source trees and lore repositories.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const query = getRequiredVariable(variables, "query", "source search");
    const results = await retrievalService.searchRepositorySources(
      query,
      DEFAULT_RETRIEVAL_RESULT_LIMIT,
    );

    return jsonResource(uri, {
      query,
      resultCount: results.length,
      results: formatSourceResults(results),
    });
  },
);

server.registerResource(
  "source_search_repo",
  new ResourceTemplate("voidbot://sources/repo/{repoName}/search/{query}", { list: undefined }),
  {
    title: "Repository-Scoped Source Search",
    description:
      "Semantic search across one indexed source tree or lore repository.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const repoName = getRequiredVariable(variables, "repoName", "repo-scoped source search");
    const query = getRequiredVariable(variables, "query", "repo-scoped source search");
    const results = await retrievalService.searchRepositorySources(
      query,
      DEFAULT_RETRIEVAL_RESULT_LIMIT,
      {
        repoName,
      },
    );

    return jsonResource(uri, {
      query,
      resultCount: results.length,
      results: formatSourceResults(results),
    });
  },
);

server.registerResource(
  "source_context",
  new ResourceTemplate("voidbot://sources/context/{sourceId}/{chunkIndex}", { list: undefined }),
  {
    title: "Source Context",
    description:
      "Fetch a surrounding chunk window from one indexed source or lore document.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const sourceId = getRequiredVariable(variables, "sourceId", "source context");
    const chunkIndex = parseOptionalInt(variables.chunkIndex) ?? 0;
    const document = await sourceArchiveRepository.get(sourceId);

    if (!document) {
      return jsonResource(uri, {
        found: false,
        sourceId,
        chunks: [],
      });
    }

    const chunks = sourceDocumentIngester.buildContextWindow(
      document,
      chunkIndex,
      1,
      1,
    );
    const anchorIndex =
      chunks.find((chunk) => chunk.chunkIndex === chunkIndex)?.chunkIndex ??
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

    return jsonResource(uri, {
      found: true,
      sourceId,
      repoName: document.repoName,
      path: document.path,
      language: document.language,
      count: formattedChunks.length,
      chunks: formattedChunks,
    });
  },
);

server.registerTool(
  "search_history",
  {
    title: "Search Discord History",
    description:
      "Search archived Discord history with semantic retrieval. Use this for historical discussion, decisions, preferences, and prior conversations.",
    inputSchema: searchHistoryInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input: SearchHistoryArgs): Promise<CallToolResult> => {
    const { query, limit, guildId, channelId, authorId } = input;
    const results = await retrievalService.searchHistory(query, limit ?? DEFAULT_RETRIEVAL_RESULT_LIMIT, {
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (_input: ListIndexedReposArgs): Promise<CallToolResult> => {
    const repos = await sourceArchiveRepository.listRepoSummaries();

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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input: SearchSourcesArgs): Promise<CallToolResult> => {
    const { query, limit, repoName, pathPrefix, language } = input;
    const results = await retrievalService.searchRepositorySources(
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input: SourceContextArgs): Promise<CallToolResult> => {
    const { sourceId, chunkIndex, before, after } = input;
    const document = await sourceArchiveRepository.get(sourceId);

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

    const chunks = sourceDocumentIngester.buildContextWindow(
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (input: MessageContextArgs): Promise<CallToolResult> => {
    const { messageId, before, after } = input;
    const anchor = await archiveRepository.get(messageId);

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

    const messages = await archiveRepository.listContextWindow(
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
    if (!config.botToken) {
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

    const dmChannelId = await openOwnerDmChannel(config.botToken, config.ownerDiscordId);
    const posted = await postDiscordMessage(config.botToken, dmChannelId, message);

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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  console.error("MCP server failed:", error);
  process.exit(1);
});

function formatArchivedMessage(
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

function renderJsonBlock(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function jsonResource(uri: URL, payload: Record<string, unknown>) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function getRequiredVariable(
  variables: Record<string, string | string[]>,
  key: string,
  context: string,
): string {
  const value = getOptionalVariable(variables, key);

  if (!value) {
    throw new Error(`Missing required ${key} for ${context}.`);
  }

  return value;
}

function getOptionalVariable(
  variables: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const value = variables[key];

  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOptionalInt(value: string | string[] | undefined): number | undefined {
  const normalized = Array.isArray(value) ? value[0] : value;

  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatHistoryResults(results: RetrievalResult[]) {
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

function formatSourceResults(results: RetrievalResult[]) {
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

async function openOwnerDmChannel(botToken: string, recipientId: string): Promise<string> {
  const response = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient_id: recipientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to open Discord DM channel: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord DM channel creation returned no channel id.");
  }

  return payload.id;
}

async function postDiscordMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<{ id: string }> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      allowed_mentions: {
        parse: [],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post Discord message: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord message post returned no message id.");
  }

  return { id: payload.id };
}
