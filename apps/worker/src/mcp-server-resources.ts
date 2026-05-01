import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { DEFAULT_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";

import { type VoidbotMcpContext } from "./mcp-server-context";
import {
  formatArchivedMessage,
  formatHistoryResults,
  formatSourceResults,
  getRequiredVariable,
  jsonResource,
  parseOptionalInt,
} from "./mcp-server-shared";

export function registerVoidbotResources(
  server: McpServer,
  context: VoidbotMcpContext,
): void {
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
      const repos = await context.sourceArchiveRepository.listRepoSummaries();
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
      const results = await context.retrievalService.searchHistory(
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
      const anchor = await context.archiveRepository.get(messageId);

      if (!anchor) {
        return jsonResource(uri, {
          found: false,
          messageId,
          messages: [],
        });
      }

      const messages = await context.archiveRepository.listContextWindow(messageId, 2, 2);

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
      const results = await context.retrievalService.searchRepositorySources(
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
      const results = await context.retrievalService.searchRepositorySources(
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
      const document = await context.sourceArchiveRepository.get(sourceId);

      if (!document) {
        return jsonResource(uri, {
          found: false,
          sourceId,
          chunks: [],
        });
      }

      const chunks = context.sourceDocumentIngester.buildContextWindow(
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
}
