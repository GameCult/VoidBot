import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";
import { searchHistoryWithArchiveFallback } from "@voidbot/rag";
import {
  applyRepoFacePostFatigueAfterSpeech,
  applyVoidSelfStateOperation,
  buildGameCultPersonaStateFromVoidSelfState,
  buildVoidSelfStateContext,
  faceRegistryAsRepoDiscordRegistry,
  findRepoDiscordIdentity,
  isRepoDiscordIdentityAllowedInChannel,
  loadFaceIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  renderFaceIdentityDoctrine,
  resolveFaceStatePath,
  resolveRepoFaceStatePath,
  VOID_SELF_STATE_SCHEMA_DOCUMENT_TYPES,
  VOID_SELF_STATE_SCHEMA_FINGERPRINT,
} from "@voidbot/core";

import { type VoidbotMcpContext } from "./mcp-server-context";
import { openOwnerDmChannel, postDiscordMessage } from "./mcp-server-discord";
import {
  type ListIndexedReposArgs,
  type MessageContextArgs,
  type NotifyOwnerArgs,
  type ApplyRepoFaceStateOperationArgs,
  type PostDiscordMessageArgs,
  type ReadWebpageArgs,
  type PostRepoIdentityMessageArgs,
  type RepoFaceStateArgs,
  type RuntimeInfoArgs,
  type SearchHistoryArgs,
  type SearchSourcesArgs,
  type SearchWebArgs,
  type SourceContextArgs,
  formatArchivedMessage,
  formatHistoryResults,
  formatSourceResults,
  applyRepoFaceStateOperationInputSchema,
  messageContextInputSchema,
  notifyOwnerInputSchema,
  postDiscordMessageInputSchema,
  postRepoIdentityMessageInputSchema,
  readWebpageInputSchema,
  repoFaceStateInputSchema,
  renderJsonBlock,
  runtimeInfoInputSchema,
  searchHistoryInputSchema,
  searchSourcesInputSchema,
  searchWebInputSchema,
  sourceContextInputSchema,
} from "./mcp-server-shared";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const OPEN_WORLD_READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function isMcpToolAllowed(name: string): boolean {
  const raw = process.env.VOIDBOT_MCP_TOOL_ALLOWLIST?.trim();
  if (!raw) {
    return true;
  }

  const allowed = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  return allowed.has(name);
}

export function registerVoidbotTools(
  server: McpServer,
  context: VoidbotMcpContext,
): void {
  const registerIfAllowed = (...args: any[]): void => {
    const [name] = args;
    if (!isMcpToolAllowed(name)) {
      return;
    }
    (server.registerTool as any)(...args);
  };

  registerIfAllowed(
    "get_voidbot_runtime_info",
    {
      title: "Get VoidBot Runtime Info",
      description:
        "Return the running VoidBot MCP server runtime and typed self-state schema identity. Use this to detect stale MCP processes after schema changes.",
      inputSchema: runtimeInfoInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (_input: RuntimeInfoArgs): Promise<CallToolResult> => {
      const runtimeInfo = {
        serverName: "voidbot",
        serverVersion: "0.1.0",
        pid: process.pid,
        workspaceRoot: process.cwd(),
        selfStateSchemaFingerprint: VOID_SELF_STATE_SCHEMA_FINGERPRINT,
        selfStateDocumentTypes: VOID_SELF_STATE_SCHEMA_DOCUMENT_TYPES,
      };

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock(runtimeInfo),
          },
        ],
        structuredContent: runtimeInfo,
      };
    },
  );

  registerIfAllowed(
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

  registerIfAllowed(
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

  registerIfAllowed(
    "search_web",
    {
      title: "Search The Web",
      description:
        "Search the public internet for fresh outside references, examples, cultural material, technical terms, and unfamiliar concepts. Use this as the Face's local Eyes when repo/archive memory feels too narrow. Treat results as leads, not durable truth.",
      inputSchema: searchWebInputSchema,
      annotations: OPEN_WORLD_READ_ONLY_ANNOTATIONS,
    },
    async (input: SearchWebArgs): Promise<CallToolResult> => {
      const results = await searchWeb(input.query, input.limit ?? 5);

      return {
        content: [
          {
            type: "text",
            text:
              results.length > 0
                ? renderJsonBlock({
                    query: input.query,
                    resultCount: results.length,
                    results,
                  })
                : `No public web results were found for "${input.query}".`,
          },
        ],
        structuredContent: {
          query: input.query,
          resultCount: results.length,
          results,
        },
      };
    },
  );

  registerIfAllowed(
    "read_webpage",
    {
      title: "Read Webpage",
      description:
        "Fetch a public HTTP(S) webpage and return bounded plain text. Use after search_web or when a Discord link needs actual page context. Treat fetched pages as open-world leads, not durable truth.",
      inputSchema: readWebpageInputSchema,
      annotations: OPEN_WORLD_READ_ONLY_ANNOTATIONS,
    },
    async (input: ReadWebpageArgs): Promise<CallToolResult> => {
      const page = await readWebpage(input.url, input.maxChars ?? 6000);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock(page),
          },
        ],
        structuredContent: page,
      };
    },
  );

  registerIfAllowed(
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

  registerIfAllowed(
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

  registerIfAllowed(
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

  registerIfAllowed(
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

  registerIfAllowed(
    "list_repo_discord_identities",
    {
      title: "List Repo Discord Identities",
      description:
        "List registered repo identities that can be addressed by Discord roles and speak through the shared webhook persona pipe.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (): Promise<CallToolResult> => {
      const faceRegistry = await loadFaceIdentityRegistry(context.config.repoDiscordIdentitiesPath);
      const registry = faceRegistryAsRepoDiscordRegistry(faceRegistry);
      const identities = registry.identities.map((identity) => ({
        id: identity.id,
        repoName: identity.repoName,
        repoPath: identity.repoPath ?? null,
        displayName: identity.displayName,
        roleId: identity.roleId ?? null,
        mention: identity.roleId ? `<@&${identity.roleId}>` : null,
        allowedChannelIds: identity.allowedChannelIds,
        faceStatePath: resolveRepoFaceStatePath(identity, context.config.storageRoot),
        hasAvatarUrl: Boolean(identity.avatarUrl),
        description: identity.description ?? null,
      }));
      const epiphanies = faceRegistry.epiphanies.map((epiphany) => ({
        id: epiphany.id,
        displayName: epiphany.displayName,
        description: epiphany.description ?? null,
        repoNames: epiphany.repoNames,
        jurisdictions: epiphany.jurisdictions,
        faces: epiphany.faces.map((face) => face.id),
      }));
      const faces = faceRegistry.faces.map((face) => ({
        id: face.id,
        displayName: face.displayName,
        epiphanyId: face.epiphanyId,
        epiphanyDisplayName: face.epiphanyDisplayName,
        roleId: face.roleId ?? null,
        mention: face.roleId ? `<@&${face.roleId}>` : null,
        allowedChannelIds: face.allowedChannelIds,
        grants: face.grants,
        jurisdictions: [...face.inheritedJurisdictions, ...face.jurisdictions],
        faceStatePath: resolveFaceStatePath(face, context.config.storageRoot),
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
                    epiphanyCount: epiphanies.length,
                    epiphanies,
                    faceCount: faces.length,
                    faces,
                  })
                : "No repo Discord identities are registered.",
          },
        ],
        structuredContent: {
          identityCount: identities.length,
          identities,
          epiphanyCount: epiphanies.length,
          epiphanies,
          faceCount: faces.length,
          faces,
        },
      };
    },
  );

  registerIfAllowed(
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
      const registry = faceRegistryAsRepoDiscordRegistry(
        await loadFaceIdentityRegistry(context.config.repoDiscordIdentitiesPath),
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
      await recordRepoIdentityDeliveryReceipt({
        context,
        identity,
        channelId,
        content,
        replyToMessageId,
        messageId: posted.id,
        transport: posted.transport,
      });

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

  registerIfAllowed(
    "huginn_read_persona_state",
    {
      title: "Huginn Read Persona State",
      description:
        "Huginn-owned Persona state inspection for a registered repo identity. Reads the repo Face typed .cc state, emits the gamecult.persona_state.v0 projection, and leaves canonical authority with the source state file. Huginn is the runtime steward; VoidBot is only the legacy MCP carrier.",
      inputSchema: repoFaceStateInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: RepoFaceStateArgs): Promise<CallToolResult> => {
      return readPersonaStateForTool(context, input);
    },
  );

  registerIfAllowed(
    "read_repo_face_state",
    {
      title: "Read Repo Face State",
      description:
        "Compatibility alias for huginn_read_persona_state. Prefer the Huginn-owned tool when inspecting Persona state; VoidBot only hosts the MCP runtime.",
      inputSchema: repoFaceStateInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: RepoFaceStateArgs): Promise<CallToolResult> => {
      return readPersonaStateForTool(context, input);
    },
  );

  registerIfAllowed(
    "huginn_apply_persona_state_operation",
    {
      title: "Huginn Apply Persona State Operation",
      description:
        "Huginn-stewarded mutation path for registered Persona/Face state. Applies one typed state operation to the source repo Face .cc file; use this for memory, incubation, agency pressure, candidate actions/interventions, and receipts. Do not edit the state file directly.",
      inputSchema: applyRepoFaceStateOperationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: ApplyRepoFaceStateOperationArgs): Promise<CallToolResult> => {
      return applyPersonaStateOperationForTool(context, input);
    },
  );

  registerIfAllowed(
    "apply_repo_face_state_operation",
    {
      title: "Apply Repo Face State Operation",
      description:
        "Compatibility alias for huginn_apply_persona_state_operation. Prefer the Huginn-owned tool for Persona-state operations; the typed source state remains the authority.",
      inputSchema: applyRepoFaceStateOperationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: ApplyRepoFaceStateOperationArgs): Promise<CallToolResult> => {
      return applyPersonaStateOperationForTool(context, input);
    },
  );

  registerIfAllowed(
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

async function searchWeb(
  query: string,
  limit: number,
): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  const requestedLimit = Math.max(1, Math.min(8, Math.trunc(limit)));
  try {
    const mojeekResults = parseMojeekResults(await fetchMojeekHtml(query), requestedLimit);
    if (mojeekResults.length > 0) {
      return mojeekResults;
    }
  } catch {
    // Fall through to other public search surfaces.
  }

  try {
    const duckDuckGoResults = parseDuckDuckGoResults(await fetchDuckDuckGoHtml(query), requestedLimit);
    if (duckDuckGoResults.length > 0) {
      return duckDuckGoResults;
    }
  } catch {
    // Fall through to Bing before reporting failure.
  }

  const bingUrl = new URL("https://www.bing.com/search");
  bingUrl.searchParams.set("q", query);

  const bingResponse = await fetch(bingUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VoidBot Face Eyes/0.1; +https://github.com/GameCult/VoidBot)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!bingResponse.ok) {
    throw new Error(`Web search failed: ${bingResponse.status} ${bingResponse.statusText}`);
  }

  return parseBingResults(await bingResponse.text(), requestedLimit);
}

async function readWebpage(
  rawUrl: string,
  maxChars: number,
): Promise<Record<string, unknown>> {
  const url = parsePublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VoidBot Face Eyes/0.1; +https://github.com/GameCult/VoidBot)",
        Accept: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  const finalUrl = parsePublicHttpUrl(response.url || url);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    throw new Error(`Webpage fetch failed for ${finalUrl}: ${response.status} ${response.statusText}`);
  }
  if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`Webpage fetch refused non-text content at ${finalUrl}: ${contentType || "unknown content type"}`);
  }

  const bytes = await readBoundedResponseBytes(response, 512_000);
  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const title = extractHtmlTitle(rawText);
  const text = contentType.toLowerCase().includes("text/plain")
    ? normalizeWhitespace(rawText)
    : htmlToPlainText(rawText);
  const boundedMaxChars = Math.max(500, Math.min(12_000, Math.trunc(maxChars)));
  const excerpt = text.slice(0, boundedMaxChars);

  return {
    url: finalUrl,
    contentType,
    title: title || null,
    text: excerpt,
    truncated: text.length > excerpt.length || bytes.length >= 512_000,
    characterCount: text.length,
  };
}

function parsePublicHttpUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https webpages can be fetched: ${rawUrl}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  ) {
    throw new Error(`Refusing to fetch non-public webpage host: ${hostname}`);
  }
  parsed.hash = "";
  return parsed.toString();
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) {
      break;
    }
    const remaining = maxBytes - total;
    const chunk = value.length > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.length;
    if (value.length > remaining) {
      break;
    }
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeWhitespace(stripHtml(match[1] ?? "")) : undefined;
}

function htmlToPlainText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  return normalizeWhitespace(stripHtml(withoutNoise));
}

async function fetchMojeekHtml(query: string): Promise<string> {
  const url = new URL("https://www.mojeek.com/search");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VoidBot Face Eyes/0.1; +https://github.com/GameCult/VoidBot)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Web search failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function parseMojeekResults(
  html: string,
  limit: number,
): Array<{ title: string; url: string; snippet?: string }> {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];
  const resultPattern = /<!--rs--><li[^>]*>[\s\S]*?<h2>\s*<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>[\s\S]*?<p class="s">([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;

  while ((match = resultPattern.exec(html)) && results.length < limit) {
    const rawUrl = decodeHtml(match[1] ?? "");
    const title = normalizeWhitespace(stripHtml(match[2] ?? ""));
    const snippet = normalizeWhitespace(stripHtml(match[3] ?? ""));
    if (title && rawUrl) {
      results.push({
        title,
        url: rawUrl,
        ...(snippet ? { snippet } : {}),
      });
    }
  }

  return results;
}

function parseBingResults(
  html: string,
  limit: number,
): Array<{ title: string; url: string; snippet?: string }> {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];
  const resultPattern = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)(?=<li class="b_algo"|<li class="b_ans"|<div id="b_pag"|<\/ol>)/gi;
  let match: RegExpExecArray | null;

  while ((match = resultPattern.exec(html)) && results.length < limit) {
    const rawUrl = decodeHtml(match[1] ?? "");
    const title = normalizeWhitespace(stripHtml(match[2] ?? ""));
    const body = match[3] ?? "";
    const snippetMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? normalizeWhitespace(stripHtml(snippetMatch[1] ?? "")) : undefined;
    const resolvedUrl = normalizeBingResultUrl(rawUrl);
    if (!title || !resolvedUrl) {
      continue;
    }
    results.push({
      title,
      url: resolvedUrl,
      ...(snippet ? { snippet } : {}),
    });
  }

  return results;
}

function normalizeBingResultUrl(rawUrl: string): string | undefined {
  try {
    const decodedRawUrl = decodeHtml(rawUrl);
    const parsed = new URL(decodedRawUrl);
    const encodedTarget = parsed.searchParams.get("u")
      ?? decodedRawUrl.match(/[?&]u=([^&]+)/)?.[1];
    if (!encodedTarget) {
      return parsed.toString();
    }
    const normalized = decodeURIComponent(encodedTarget).startsWith("a1")
      ? decodeURIComponent(encodedTarget).slice(2)
      : decodeURIComponent(encodedTarget);
    return decodeBase64Url(normalized);
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

async function fetchDuckDuckGoHtml(query: string): Promise<string> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VoidBot Face Eyes/0.1; +https://github.com/GameCult/VoidBot)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Web search failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function parseDuckDuckGoResults(
  html: string,
  limit: number,
): Array<{ title: string; url: string; snippet?: string }> {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];
  const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = resultPattern.exec(html)) && results.length < limit) {
    const rawUrl = decodeHtml(match[1] ?? "");
    const title = normalizeWhitespace(stripHtml(match[2] ?? ""));
    const snippet = normalizeWhitespace(stripHtml(match[3] ?? ""));
    const resolvedUrl = normalizeDuckDuckGoResultUrl(rawUrl);
    if (title && resolvedUrl) {
      results.push({
        title,
        url: resolvedUrl,
        ...(snippet ? { snippet } : {}),
      });
    }
  }

  return results;
}

function normalizeDuckDuckGoResultUrl(rawUrl: string): string | undefined {
  try {
    const parsed = rawUrl.startsWith("//") ? new URL(`https:${rawUrl}`) : new URL(rawUrl);
    const redirected = parsed.searchParams.get("uddg");
    const resolved = redirected ? decodeURIComponent(redirected) : parsed.toString();
    if (resolved.includes("duckduckgo.com/y.js?")) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " "));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

async function readPersonaStateForTool(
  context: VoidbotMcpContext,
  input: RepoFaceStateArgs,
): Promise<CallToolResult> {
  const resolved = await resolveRepoIdentityForTool(context, input.identity);

  if (!resolved.identity) {
    return resolved.error;
  }

  const typedState = await loadVoidSelfStateTypedDocuments({
    canonicalPath: resolved.faceStatePath,
    identity: {
      agentId: resolved.identity.id,
      publicName: resolved.identity.displayName,
      publicDescription: resolved.identity.description,
    },
  });
  const rendered = buildVoidSelfStateContext(typedState, {
    sourcePath: resolved.faceStatePath,
    identity: {
      agentId: resolved.identity.id,
      publicName: resolved.identity.displayName,
      publicDescription: resolved.identity.description,
    },
  });
  const personaState = buildGameCultPersonaStateFromVoidSelfState(typedState, {
    sourceDocumentId: resolved.faceStatePath,
    identity: resolved.identity,
  });
  const payload = {
    steward: personaStateStewardForTool(),
    host: personaStateHostForTool(),
    identity: identityForToolResult(resolved.identity, resolved.face),
    faceStatePath: resolved.faceStatePath,
    summary: rendered.summary,
    personaState,
    typedState,
  };

  return {
    content: [
      {
        type: "text",
        text: renderJsonBlock(payload),
      },
    ],
    structuredContent: payload,
  };
}

async function applyPersonaStateOperationForTool(
  context: VoidbotMcpContext,
  input: ApplyRepoFaceStateOperationArgs,
): Promise<CallToolResult> {
  const resolved = await resolveRepoIdentityForTool(context, input.identity);

  if (!resolved.identity) {
    return resolved.error;
  }

  const result = await applyVoidSelfStateOperation(
    {
      canonicalPath: resolved.faceStatePath,
      identity: {
        agentId: resolved.identity.id,
        publicName: resolved.identity.displayName,
        publicDescription: resolved.identity.description,
      },
    },
    input.operation,
  );
  const payload = {
    applied: true,
    steward: personaStateStewardForTool(),
    host: personaStateHostForTool(),
    identity: identityForToolResult(resolved.identity, resolved.face),
    faceStatePath: resolved.faceStatePath,
    result,
  };

  return {
    content: [
      {
        type: "text",
        text: renderJsonBlock(payload),
      },
    ],
    structuredContent: payload,
  };
}

function personaStateStewardForTool() {
  return {
    id: "huginn",
    displayName: "Huginn",
    repoName: "CultCacheTS",
    role: "persona_state_runtime_steward",
    contract: "gamecult.persona_state.v0",
    cultMeshProviderId: "cultcache.huginn.inspector",
  };
}

function personaStateHostForTool() {
  return {
    service: "voidbot",
    role: "legacy_mcp_carrier",
  };
}

async function resolveRepoIdentityForTool(
  context: VoidbotMcpContext,
  identitySelector: string,
): Promise<
  | {
      identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>;
      face?: Awaited<ReturnType<typeof loadFaceIdentityRegistry>>["faces"][number];
      faceStatePath: string;
    }
  | {
      identity?: undefined;
      error: CallToolResult;
    }
> {
  const faceRegistry = await loadFaceIdentityRegistry(context.config.repoDiscordIdentitiesPath);
  const registry = faceRegistryAsRepoDiscordRegistry(faceRegistry);
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
    face: faceRegistry.faces.find((face) => face.id === identity.id),
    faceStatePath: resolveRepoFaceStatePath(identity, context.config.storageRoot),
  };
}

async function recordRepoIdentityDeliveryReceipt(input: {
  context: VoidbotMcpContext;
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>;
  channelId: string;
  content: string;
  replyToMessageId?: string;
  messageId: string;
  transport: "bot" | "webhook";
}): Promise<void> {
  await applyVoidSelfStateOperation(
    {
      canonicalPath: resolveRepoFaceStatePath(input.identity, input.context.config.storageRoot),
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
      storageRoot: input.context.config.storageRoot,
      heartbeatStatePath: input.context.config.repoFaceHeartbeats.statePath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not apply repo Face post fatigue for ${input.identity.id}: ${message}`);
  }
}

function identityForToolResult(
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  face?: Awaited<ReturnType<typeof loadFaceIdentityRegistry>>["faces"][number],
) {
  return {
    id: identity.id,
    repoName: identity.repoName,
    displayName: identity.displayName,
    roleId: identity.roleId ?? null,
    mention: identity.roleId ? `<@&${identity.roleId}>` : null,
    epiphanyId: face?.epiphanyId ?? identity.repoName,
    epiphanyDisplayName: face?.epiphanyDisplayName ?? identity.repoName,
    grants: face?.grants ?? [],
    jurisdictions: face ? [...face.inheritedJurisdictions, ...face.jurisdictions] : [],
    doctrine: face ? renderFaceIdentityDoctrine(face) : null,
  };
}
