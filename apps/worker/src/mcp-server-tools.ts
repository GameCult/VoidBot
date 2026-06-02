import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import net from "node:net";

import { DEFAULT_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";
import { searchHistoryWithArchiveFallback } from "@voidbot/rag";
import {
  applyRepoFacePostFatigueAfterSpeech,
  applyVoidSelfStateOperation,
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
  type OdinEndpointArgs,
  type OdinSurfaceArgs,
  type ApplyRepoFaceStateOperationArgs,
  type PostDiscordMessageArgs,
  type PostRepoIdentityMessageArgs,
  type RepoFaceStateArgs,
  type RuntimeInfoArgs,
  type SearchHistoryArgs,
  type SearchSourcesArgs,
  type SourceContextArgs,
  formatArchivedMessage,
  formatHistoryResults,
  formatSourceResults,
  applyRepoFaceStateOperationInputSchema,
  messageContextInputSchema,
  notifyOwnerInputSchema,
  odinEndpointInputSchema,
  odinSurfaceInputSchema,
  postDiscordMessageInputSchema,
  postRepoIdentityMessageInputSchema,
  repoFaceStateInputSchema,
  renderJsonBlock,
  runtimeInfoInputSchema,
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

const DEFAULT_ODIN_BASE_URL = "http://127.0.0.1:8797";

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
    "list_odin_providers",
    {
      title: "List Odin Providers",
      description:
        "List Eve/CultUI providers currently advertised through Odin. This is read-only Verse discovery; use it to learn which provider-owned surfaces Odin can see.",
      inputSchema: odinEndpointInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: OdinEndpointArgs): Promise<CallToolResult> => {
      const odinBaseUrl = normalizeOdinBaseUrl(input.odinBaseUrl);
      const catalog = await fetchOdinProviderCatalog(odinBaseUrl);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinBaseUrl,
              providerCount: catalog.providers.length,
              providers: catalog.providers,
            }),
          },
        ],
        structuredContent: {
          odinBaseUrl,
          providerCount: catalog.providers.length,
          providers: catalog.providers,
        },
      };
    },
  );

  registerIfAllowed(
    "list_odin_verses",
    {
      title: "List Odin Verses",
      description:
        "Read Odin's current all-seer surface and list the Verse/service nodes it publishes. This is read-only; Odin remains the registry owner.",
      inputSchema: odinEndpointInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: OdinEndpointArgs): Promise<CallToolResult> => {
      const odinBaseUrl = normalizeOdinBaseUrl(input.odinBaseUrl);
      const snapshot = await fetchOdinDeckSnapshot(odinBaseUrl);
      const verses = summarizeOdinVerses(snapshot);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinBaseUrl,
              providerId: snapshot.providerId,
              title: snapshot.title,
              version: snapshot.version,
              updatedAt: snapshot.updatedAt,
              verseCount: verses.length,
              verses,
            }),
          },
        ],
        structuredContent: {
          odinBaseUrl,
          providerId: snapshot.providerId,
          title: snapshot.title,
          version: snapshot.version,
          updatedAt: snapshot.updatedAt,
          verseCount: verses.length,
          verses,
        },
      };
    },
  );

  registerIfAllowed(
    "get_odin_surface",
    {
      title: "Get Odin Surface",
      description:
        "Read Odin's current all-seer Eve/CultUI surface, or ask Odin for one provider surface by providerId. Use this for read-only interface inspection, not command execution.",
      inputSchema: odinSurfaceInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: OdinSurfaceArgs): Promise<CallToolResult> => {
      const odinBaseUrl = normalizeOdinBaseUrl(input.odinBaseUrl);
      const snapshot = await fetchOdinDeckSnapshot(odinBaseUrl, input.providerId);
      const surfaceSummary = summarizeOdinSurface(snapshot);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinBaseUrl,
              providerId: snapshot.providerId,
              title: snapshot.title,
              version: snapshot.version,
              updatedAt: snapshot.updatedAt,
              selectedNodeId: snapshot.selectedNodeId,
              surface: surfaceSummary,
            }),
          },
        ],
        structuredContent: {
          odinBaseUrl,
          providerId: snapshot.providerId,
          title: snapshot.title,
          version: snapshot.version,
          updatedAt: snapshot.updatedAt,
          selectedNodeId: snapshot.selectedNodeId,
          surface: surfaceSummary,
        },
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

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              identity: identityForToolResult(resolved.identity, resolved.face),
              faceStatePath: resolved.faceStatePath,
              summary: rendered.summary,
              typedState,
            }),
          },
        ],
        structuredContent: {
          identity: identityForToolResult(resolved.identity, resolved.face),
          faceStatePath: resolved.faceStatePath,
          summary: rendered.summary,
          typedState,
        },
      };
    },
  );

  registerIfAllowed(
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

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              applied: true,
              identity: identityForToolResult(resolved.identity, resolved.face),
              faceStatePath: resolved.faceStatePath,
              result,
            }),
          },
        ],
        structuredContent: {
          applied: true,
          identity: identityForToolResult(resolved.identity, resolved.face),
          faceStatePath: resolved.faceStatePath,
          result,
        },
      };
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

function normalizeOdinBaseUrl(value: string | undefined): string {
  return (value ?? process.env.ODIN_BASE_URL ?? DEFAULT_ODIN_BASE_URL).replace(/\/+$/, "");
}

async function fetchOdinProviderCatalog(odinBaseUrl: string): Promise<{ providers: Array<Record<string, unknown>> }> {
  const response = await fetch(`${odinBaseUrl}/eve/deck/providers`);
  if (!response.ok) {
    throw new Error(`Odin provider catalog failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as { providers?: unknown };
  const providers = Array.isArray(payload.providers)
    ? payload.providers.filter(isRecord)
    : [];
  return { providers };
}

async function fetchOdinDeckSnapshot(
  odinBaseUrl: string,
  providerId?: string,
): Promise<Record<string, unknown>> {
  const deckUrl = new URL(odinBaseUrl);
  deckUrl.protocol = deckUrl.protocol === "https:" ? "wss:" : "ws:";
  deckUrl.pathname = "/eve/deck";
  deckUrl.search = "";
  const socket = await openWebSocketSnapshotSocket(deckUrl);
  try {
    if (providerId) {
      sendClientWebSocketText(socket, JSON.stringify({ type: "open-provider", providerId }));
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const message = await readServerWebSocketText(socket, 3000);
      const parsed = JSON.parse(message) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      if (!providerId || parsed.providerId === providerId) {
        return parsed;
      }
    }
    throw new Error(providerId
      ? `Odin did not publish provider ${providerId} in the snapshot window.`
      : "Odin did not publish a deck snapshot.");
  } finally {
    socket.destroy();
  }
}

function summarizeOdinVerses(snapshot: Record<string, unknown>) {
  const root = getSurfaceRoot(snapshot);
  const children = Array.isArray(root?.children) ? root.children.filter(isRecord) : [];
  return children
    .filter((child) => child.kind === "verse")
    .map((child) => {
      const props = isRecord(child.props) ? child.props : {};
      const services = Array.isArray(props.services)
        ? props.services.filter(isRecord).map((service) => ({
            id: stringValue(service.id),
            name: stringValue(service.name),
            state: stringValue(service.state),
            detail: stringValue(service.detail),
          }))
        : [];
      return {
        id: stringValue(props.verseId) || stringValue(child.id),
        title: stringValue(props.title),
        role: stringValue(props.role),
        status: stringValue(props.status),
        capabilities: Array.isArray(props.capabilities) ? props.capabilities.map(String) : [],
        serviceCount: services.length,
        services,
      };
    });
}

function summarizeOdinSurface(snapshot: Record<string, unknown>) {
  const root = getSurfaceRoot(snapshot);
  const children = Array.isArray(root?.children) ? root.children.filter(isRecord) : [];
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.filter(isRecord) : [];
  const interfaces = children
    .filter((child) => child.kind === "interface")
    .map((child) => {
      const props = isRecord(child.props) ? child.props : {};
      return {
        id: stringValue(child.id),
        providerId: stringValue(props.providerId),
        title: stringValue(props.title),
        status: stringValue(props.status),
        detail: stringValue(props.detail),
        source: stringValue(props.source),
        version: props.version ?? null,
        updatedAt: stringValue(props.updatedAt),
        rootKind: child.children && Array.isArray(child.children) && isRecord(child.children[0])
          ? stringValue(child.children[0].kind)
          : "",
      };
    });
  const observationStreams = children
    .filter((child) => child.kind === "pane" && isRecord(child.props) && child.props.title === "Device Observation Streams")
    .flatMap((pane) => Array.isArray(pane.children) ? pane.children.filter(isRecord) : [])
    .filter((child) => child.kind === "observation-stream")
    .map((child) => {
      const props = isRecord(child.props) ? child.props : {};
      return {
        id: stringValue(child.id),
        deviceId: stringValue(props.deviceId),
        streamId: stringValue(props.streamId),
        kind: stringValue(props.kind),
        state: stringValue(props.state),
        latestAt: stringValue(props.latestAt),
      };
    });

  return {
    schema: isRecord(snapshot.surface) ? stringValue(snapshot.surface.schema) : "",
    rootId: stringValue(root?.id),
    rootKind: stringValue(root?.kind),
    title: isRecord(root?.props) ? stringValue(root.props.title) : "",
    summary: isRecord(root?.props) ? stringValue(root.props.summary) : "",
    nodeCount: nodes.length,
    childCount: children.length,
    interfaceCount: interfaces.length,
    interfaces,
    observationStreamCount: observationStreams.length,
    observationStreams,
  };
}

function getSurfaceRoot(snapshot: Record<string, unknown>): Record<string, unknown> | undefined {
  const surface = isRecord(snapshot.surface) ? snapshot.surface : undefined;
  return isRecord(surface?.root) ? surface.root : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function openWebSocketSnapshotSocket(url: URL): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (url.protocol === "wss:") {
      reject(new Error("Odin WSS is not supported by this lightweight MCP snapshot client yet."));
      return;
    }
    const port = Number(url.port || 80);
    const socket = net.createConnection({ host: url.hostname, port, timeout: 3000 });
    const key = crypto.randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    socket.on("connect", () => {
      socket.write([
        `GET ${url.pathname || "/eve/deck"} HTTP/1.1`,
        `Host: ${url.hostname}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", function onHandshake(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker < 0) {
        return;
      }
      const header = buffer.subarray(0, marker).toString("latin1");
      if (!header.startsWith("HTTP/1.1 101")) {
        reject(new Error(header.split(/\r?\n/)[0] || "Odin websocket handshake failed"));
        socket.destroy();
        return;
      }
      socket.off("data", onHandshake);
      socket.unshift(buffer.subarray(marker + 4));
      resolve(socket);
    });
    socket.on("timeout", () => {
      reject(new Error("Odin websocket connection timed out"));
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

function sendClientWebSocketText(socket: net.Socket, text: string): void {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const header = [0x81];
  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  } else {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));
    header.push(0x80 | 127, ...length);
  }
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
}

function readServerWebSocketText(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => cleanup(new Error("Timed out waiting for Odin deck frame")), timeoutMs);
    function cleanup(error?: Error, value?: string) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve(value ?? "");
      }
    }
    function onError(error: Error) {
      cleanup(error);
    }
    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = tryReadWebSocketFrame(buffer);
      if (!frame) {
        return;
      }
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x1) {
        cleanup(undefined, frame.payload.toString("utf8"));
      } else if (frame.opcode === 0x8) {
        cleanup(new Error("Odin websocket closed"));
      }
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function tryReadWebSocketFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) {
    return null;
  }
  const opcode = buffer[0] & 0x0f;
  const masked = Boolean(buffer[1] & 0x80);
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) {
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  let payload = buffer.subarray(offset, offset + length);
  if (mask) {
    payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  }
  return { opcode, payload, consumed: offset + length };
}
