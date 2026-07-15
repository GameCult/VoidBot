import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { DEFAULT_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";
import { searchHistoryWithArchiveFallback } from "@voidbot/rag";
import {
  applyRepoFacePostFatigueAfterSpeech,
  createRepoFaceSharedDocument,
  applyVoidSelfStateOperation,
  buildVoidSelfStateContext,
  faceRegistryAsRepoDiscordRegistry,
  findRepoDiscordIdentity,
  isRepoDiscordIdentityAllowedInChannel,
  loadFaceIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  listRepoFaceSharedDocuments,
  renderFaceIdentityDoctrine,
  resolveFaceStatePath,
  resolveRepoFaceStatePath,
  resolveRepoFaceSharedDocumentsPath,
  updateRepoFaceSharedDocument,
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
  type OdinInterfaceCommandArgs,
  type OdinInterfaceContextArgs,
  type OdinSurfaceArgs,
  type ApplyRepoFaceStateOperationArgs,
  type CreateSharedDocumentArgs,
  type PostDiscordMessageArgs,
  type PostRepoIdentityMessageArgs,
  type RepoFaceStateArgs,
  type ReadSharedDocumentArgs,
  type RuntimeInfoArgs,
  type SearchHistoryArgs,
  type SearchSourcesArgs,
  type SourceContextArgs,
  type UpdateSharedDocumentArgs,
  formatArchivedMessage,
  formatHistoryResults,
  formatSourceResults,
  applyRepoFaceStateOperationInputSchema,
  createSharedDocumentInputSchema,
  messageContextInputSchema,
  notifyOwnerInputSchema,
  odinEndpointInputSchema,
  odinInterfaceCommandInputSchema,
  odinInterfaceContextInputSchema,
  odinSurfaceInputSchema,
  postDiscordMessageInputSchema,
  postRepoIdentityMessageInputSchema,
  repoFaceStateInputSchema,
  readSharedDocumentInputSchema,
  renderJsonBlock,
  runtimeInfoInputSchema,
  searchHistoryInputSchema,
  searchSourcesInputSchema,
  sourceContextInputSchema,
  updateSharedDocumentInputSchema,
} from "./mcp-server-shared";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DEFAULT_ODIN_STORE_PATH = path.resolve(process.cwd(), "..", "Odin", "scratch", "odin", "odin.ccmp");
const ODIN_SURFACE_KEY = "surface:gamecult.network.status";

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
      const odinStorePath = resolveOdinStorePath(input.odinStorePath);
      const catalog = await fetchOdinProviderCatalog(odinStorePath);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinStorePath,
              providerCount: catalog.providers.length,
              providers: catalog.providers,
            }),
          },
        ],
        structuredContent: {
          odinStorePath,
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
      const odinStorePath = resolveOdinStorePath(input.odinStorePath);
      const snapshot = await fetchOdinSnapshot(odinStorePath);
      const verses = summarizeOdinVerses(snapshot);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinStorePath,
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
          odinStorePath,
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
      const odinStorePath = resolveOdinStorePath(input.odinStorePath);
      const snapshot = await fetchOdinSnapshot(odinStorePath, input.providerId);
      const surfaceSummary = summarizeOdinSurface(snapshot);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinStorePath,
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
          odinStorePath,
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
    "load_odin_interface_context",
    {
      title: "Load Odin Interface Context",
      description:
        "Load one provider-owned CultMesh/Eve interface visible through Odin and lower it into compact text, tree, and command context for an agent. This is token-efficient TUI access, not raw dashboard dumping.",
      inputSchema: odinInterfaceContextInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: OdinInterfaceContextArgs): Promise<CallToolResult> => {
      const odinStorePath = resolveOdinStorePath(input.odinStorePath);
      const loaded = await loadOdinProviderInterface(odinStorePath, input.providerId);
      const contextSummary = summarizeProviderInterface(loaded, {
        maxTextItems: input.maxTextItems ?? 32,
        maxTreeItems: input.maxTreeItems ?? 80,
      });

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinStorePath,
              ...contextSummary,
            }),
          },
        ],
        structuredContent: {
          odinStorePath,
          ...contextSummary,
        },
      };
    },
  );

  registerIfAllowed(
    "invoke_odin_interface_command",
    {
      title: "Invoke Odin Interface Command",
      description:
        "Inspect a provider-owned Eve/CultUI command boundary discovered via Odin. The command must be advertised by the provider interface; execution requires a CultMesh command document path and no longer tunnels through provider WebSockets.",
      inputSchema: odinInterfaceCommandInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: OdinInterfaceCommandArgs): Promise<CallToolResult> => {
      const odinStorePath = resolveOdinStorePath(input.odinStorePath);
      const loaded = await loadOdinProviderInterface(odinStorePath, input.providerId);
      const command = findAdvertisedCommand(loaded, input.command);

      if (!command) {
        return {
          content: [
            {
              type: "text",
              text: `Provider ${input.providerId} does not advertise command "${input.command}". Load the interface context first and use one of its advertised commands.`,
            },
          ],
          structuredContent: {
            sent: false,
            reason: "command_not_advertised",
            providerId: input.providerId,
            command: input.command,
            advertisedCommands: extractProviderCommands(loaded).map((entry) => entry.command),
          },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              sent: false,
              reason: "cultmesh_command_transport_required",
              providerId: input.providerId,
              source: loaded.source,
              command: input.command,
              advertisedCommand: command,
            }),
          },
        ],
        structuredContent: {
          sent: false,
          reason: "cultmesh_command_transport_required",
          providerId: input.providerId,
          source: loaded.source,
          command: input.command,
        },
        isError: true,
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
    "read_shared_document",
    {
      title: "Read Shared Document",
      description:
        "List shared typed documents, or read one by documentId. These documents are visible to every repo Face and carry revision and author provenance.",
      inputSchema: readSharedDocumentInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: ReadSharedDocumentArgs): Promise<CallToolResult> => {
      const storePath = resolveRepoFaceSharedDocumentsPath(context.config.storageRoot);
      const documents = await listRepoFaceSharedDocuments(storePath);
      const requestedDocumentId = input.documentId?.trim().toLowerCase();
      const selected = requestedDocumentId
        ? documents.find((document) => document.documentId === requestedDocumentId)
        : undefined;
      if (input.documentId && !selected) {
        return {
          content: [{ type: "text", text: `Shared document "${input.documentId}" was not found.` }],
          structuredContent: { found: false, documentId: input.documentId },
          isError: true,
        };
      }
      const result = input.documentId ? { storePath, document: selected } : { storePath, documents };
      return {
        content: [{ type: "text", text: renderJsonBlock(result) }],
        structuredContent: result,
      };
    },
  );

  registerIfAllowed(
    "create_shared_document",
    {
      title: "Create Shared Document",
      description:
        "Create one shared typed document visible to every repo Face. The active Face identity is stamped by the server; arbitrary filesystem writes are not exposed.",
      inputSchema: createSharedDocumentInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CreateSharedDocumentArgs): Promise<CallToolResult> => {
      const actor = await resolveActiveRepoFaceForSharedTool(context);
      if (!actor.identity) {
        return actor.error;
      }
      const storePath = resolveRepoFaceSharedDocumentsPath(context.config.storageRoot);
      const document = await createRepoFaceSharedDocument({
        canonicalPath: storePath,
        documentId: input.documentId,
        title: input.title,
        body: input.body,
        actorId: actor.identity.id,
      });
      return {
        content: [{ type: "text", text: renderJsonBlock({ created: true, storePath, document }) }],
        structuredContent: { created: true, storePath, document },
      };
    },
  );

  registerIfAllowed(
    "update_shared_document",
    {
      title: "Update Shared Document",
      description:
        "Replace one shared typed document body using its expected revision. Stale writes fail instead of overwriting another Face's update.",
      inputSchema: updateSharedDocumentInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: UpdateSharedDocumentArgs): Promise<CallToolResult> => {
      const actor = await resolveActiveRepoFaceForSharedTool(context);
      if (!actor.identity) {
        return actor.error;
      }
      const storePath = resolveRepoFaceSharedDocumentsPath(context.config.storageRoot);
      const document = await updateRepoFaceSharedDocument({
        canonicalPath: storePath,
        documentId: input.documentId,
        title: input.title,
        body: input.body,
        expectedVersion: input.expectedVersion,
        actorId: actor.identity.id,
      });
      return {
        content: [{ type: "text", text: renderJsonBlock({ updated: true, storePath, document }) }],
        structuredContent: { updated: true, storePath, document },
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

async function resolveActiveRepoFaceForSharedTool(context: VoidbotMcpContext) {
  const identity = process.env.VOIDBOT_REPO_FACE_IDENTITY?.trim();
  if (!identity) {
    return {
      error: {
        content: [{ type: "text" as const, text: "Shared document mutation requires an active repo Face identity." }],
        structuredContent: { applied: false, reason: "missing_active_face_identity" },
        isError: true,
      },
    };
  }
  return resolveRepoIdentityForTool(context, identity);
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

function resolveOdinStorePath(value: string | undefined): string {
  return path.resolve(value ?? process.env.ODIN_CULTMESH_STORE ?? DEFAULT_ODIN_STORE_PATH);
}

async function fetchOdinProviderCatalog(odinStorePath: string): Promise<{ providers: Array<Record<string, unknown>> }> {
  const snapshot = await fetchOdinSnapshot(odinStorePath);
  const providers = summarizeOdinSurface(snapshot).interfaces.map((entry) => ({
    id: entry.providerId,
    title: entry.title,
    status: entry.status,
    detail: entry.detail,
    source: entry.source,
    updatedAt: entry.updatedAt,
  }));
  return { providers };
}

async function fetchOdinSnapshot(
  odinStorePath: string,
  providerId?: string,
): Promise<Record<string, unknown>> {
  const allSeer = await readOdinAllSeerSurface(odinStorePath);
  if (!providerId) {
    return allSeer;
  }
  const provider = providerStateFromOdinSurface(allSeer, providerId);
  if (!provider) {
    throw new Error(`Odin CultMesh store does not currently expose provider interface ${providerId}.`);
  }
  return provider;
}

async function readOdinAllSeerSurface(odinStorePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(odinStorePath)) {
    throw new Error(`Odin CultMesh store is missing: ${odinStorePath}`);
  }
  const { inspectCultCacheBytes } = loadCultCacheInspector();
  const inspection = inspectCultCacheBytes(odinStorePath, readFileSync(odinStorePath));
  const surfaceRecord = inspection.records.find((entry) =>
    entry.schemaId === "gamecult.eve.surface_state.v1"
    && entry.key === ODIN_SURFACE_KEY
  );
  const record = isRecord(surfaceRecord?.payloadPreview) ? surfaceRecord.payloadPreview : null;
  if (!record) {
    throw new Error(`Odin CultMesh store does not contain ${ODIN_SURFACE_KEY}.`);
  }
  return record;
}

function loadCultCacheInspector(): {
  inspectCultCacheBytes: (
    filePath: string,
    bytes: Uint8Array,
  ) => { records: Array<{ key: string; schemaId: string; payloadPreview: unknown }> };
} {
  const packageJsonCandidates = [
    path.resolve(process.cwd(), "vendor", "cultcache-ts", "package.json"),
    path.resolve(process.cwd(), "node_modules", "cultcache-ts", "package.json"),
    path.resolve(process.cwd(), "..", "CultLib", "packages", "cultcache-ts", "package.json"),
  ];

  for (const packageJson of packageJsonCandidates) {
    try {
      const requireFromCandidate = createRequire(packageJson);
      const loaded = requireFromCandidate("./dist/cult-cache-inspector.js") as {
        inspectCultCacheBytes?: (
          filePath: string,
          bytes: Uint8Array,
        ) => { records: Array<{ key: string; schemaId: string; payloadPreview: unknown }> };
      };
      if (loaded.inspectCultCacheBytes) {
        return { inspectCultCacheBytes: loaded.inspectCultCacheBytes };
      }
    } catch {
      // Try the next known CultCache runtime root.
    }
  }
  throw new Error("CultCache inspector is unavailable; cannot read Odin provider state.");
}

function providerStateFromOdinSurface(
  allSeer: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> | null {
  const interfaceNode = findOdinInterfaceNode(allSeer, providerId);
  if (!interfaceNode) {
    return null;
  }
  const props = isRecord(interfaceNode.props) ? interfaceNode.props : {};
  const embeddedRoot = embeddedInterfaceRoot(interfaceNode);
  return {
    schema: "gamecult.eve.surface_state.v1",
    providerId,
    title: stringValue(props.title) || providerId,
    version: props.version ?? allSeer.version ?? 0,
    updatedAt: stringValue(props.updatedAt) || stringValue(allSeer.updatedAt),
    selectedNodeId: stringValue(allSeer.selectedNodeId),
    source: stringValue(props.source),
    manifest: isRecord(props.manifest) ? props.manifest : null,
    surface: {
      schema: "gamecult.eve.surface.v1",
      root: embeddedRoot ?? {
        id: `${providerId}.unavailable`,
        kind: "text",
        props: { text: `Provider ${providerId} has no embedded Odin interface root.` },
        children: [],
      },
    },
  };
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

interface LoadedOdinInterface {
  providerId: string;
  title: string;
  source: string;
  status: string;
  detail: string;
  manifest: Record<string, unknown> | null;
  snapshot: Record<string, unknown>;
  root?: Record<string, unknown>;
  loadedFrom: "odin-embedded-interface";
}

interface InterfaceCommandSummary {
  command: string;
  label: string;
  source: "surface.commands" | "manifest.commands" | "node.action" | "node.command";
  nodeId?: string;
  transport?: string;
  frameTemplate?: unknown;
  payloadSchema?: unknown;
  raw: Record<string, unknown>;
}

async function loadOdinProviderInterface(
  odinStorePath: string,
  providerId: string,
): Promise<LoadedOdinInterface> {
  const odinSnapshot = await fetchOdinSnapshot(odinStorePath);
  const interfaceNode = findOdinInterfaceNode(odinSnapshot, providerId);
  if (!interfaceNode) {
    throw new Error(`Odin does not currently expose provider interface ${providerId}.`);
  }

  const props = isRecord(interfaceNode.props) ? interfaceNode.props : {};
  const source = stringValue(props.source);

  return {
    providerId,
    title: stringValue(props.title) || providerId,
    source,
    status: stringValue(props.status),
    detail: stringValue(props.detail),
    manifest: isRecord(props.manifest) ? props.manifest : null,
    snapshot: odinSnapshot,
    root: embeddedInterfaceRoot(interfaceNode),
    loadedFrom: "odin-embedded-interface",
  };
}

function findOdinInterfaceNode(
  odinSnapshot: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> | undefined {
  const root = getSurfaceRoot(odinSnapshot);
  const children = Array.isArray(root?.children) ? root.children.filter(isRecord) : [];
  return children.find((child) =>
    child.kind === "interface" &&
    isRecord(child.props) &&
    child.props.providerId === providerId,
  );
}

function embeddedInterfaceRoot(interfaceNode: Record<string, unknown>): Record<string, unknown> | undefined {
  const children = Array.isArray(interfaceNode.children) ? interfaceNode.children.filter(isRecord) : [];
  return children[0];
}

function summarizeProviderInterface(
  loaded: LoadedOdinInterface,
  limits: {
    maxTextItems: number;
    maxTreeItems: number;
  },
) {
  const surface = isRecord(loaded.snapshot.surface) ? loaded.snapshot.surface : {};
  const root = loaded.root;
  const commands = extractProviderCommands(loaded);
  const flatNodes = flattenInterfaceNodes(root, limits.maxTreeItems);
  const textItems = flatNodes
    .map((entry) => entry.text)
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, limits.maxTextItems);

  return {
    providerId: loaded.providerId,
    title: loaded.title,
    source: loaded.source,
    status: loaded.status,
    detail: loaded.detail,
    loadedFrom: loaded.loadedFrom,
    updatedAt: stringValue(loaded.snapshot.updatedAt),
    surface: {
      schema: stringValue(surface.schema),
      rootId: stringValue(root?.id),
      rootKind: stringValue(root?.kind),
      summary: isRecord(root?.props) ? stringValue(root.props.summary) : "",
    },
    commands,
    textItems,
    tree: flatNodes,
  };
}

function flattenInterfaceNodes(
  root: Record<string, unknown> | undefined,
  limit: number,
) {
  const output: Array<{
    id: string;
    kind: string;
    title: string;
    text?: string;
    status?: string;
    command?: string;
    depth: number;
  }> = [];

  function visit(node: Record<string, unknown> | undefined, depth: number): void {
    if (!node || output.length >= limit) {
      return;
    }
    const props = isRecord(node.props) ? node.props : {};
    const action = isRecord(props.action) ? props.action : undefined;
    const command = stringValue(props.command) || stringValue(node.command) || stringValue(action?.command) || stringValue(action?.type);
    output.push({
      id: stringValue(node.id),
      kind: stringValue(node.kind),
      title: stringValue(props.title) || stringValue(props.label),
      text: stringValue(props.text) || stringValue(props.detail) || undefined,
      status: stringValue(props.status) || stringValue(props.tone) || undefined,
      command: command || undefined,
      depth,
    });
    const children = Array.isArray(node.children) ? node.children.filter(isRecord) : [];
    for (const child of children) {
      visit(child, depth + 1);
    }
  }

  visit(root, 0);
  return output;
}

function extractProviderCommands(loaded: LoadedOdinInterface): InterfaceCommandSummary[] {
  const commands: InterfaceCommandSummary[] = [];
  const surface = isRecord(loaded.snapshot.surface) ? loaded.snapshot.surface : {};
  const surfaceCommands = Array.isArray(surface.commands)
    ? surface.commands.filter(isRecord)
    : Array.isArray(loaded.snapshot.commands)
      ? loaded.snapshot.commands.filter(isRecord)
      : [];
  const manifestCommands = Array.isArray(loaded.manifest?.commands)
    ? loaded.manifest.commands.filter(isRecord)
    : [];

  for (const command of [...surfaceCommands, ...manifestCommands]) {
    const commandName = stringValue(command.command) || stringValue(command.id);
    if (!commandName) {
      continue;
    }
    commands.push({
      command: commandName,
      label: stringValue(command.label) || commandName,
      source: surfaceCommands.includes(command) ? "surface.commands" : "manifest.commands",
      transport: stringValue(command.transport),
      frameTemplate: command.frameTemplate,
      payloadSchema: command.payloadSchema,
      raw: command,
    });
  }

  for (const nodeCommand of extractNodeCommands(loaded.root)) {
    if (!commands.some((entry) => entry.command === nodeCommand.command && entry.nodeId === nodeCommand.nodeId)) {
      commands.push(nodeCommand);
    }
  }

  return commands;
}

function extractNodeCommands(root: Record<string, unknown> | undefined): InterfaceCommandSummary[] {
  const commands: InterfaceCommandSummary[] = [];
  function visit(node: Record<string, unknown> | undefined): void {
    if (!node) {
      return;
    }
    const props = isRecord(node.props) ? node.props : {};
    const action = isRecord(props.action) ? props.action : undefined;
    const commandName = stringValue(props.command) || stringValue(node.command) || stringValue(action?.command) || stringValue(action?.type);
    if (commandName) {
      commands.push({
        command: commandName,
        label: stringValue(props.label) || stringValue(props.title) || commandName,
        source: action ? "node.action" : "node.command",
        nodeId: stringValue(node.id),
        transport: stringValue(action?.transport),
        frameTemplate: action?.frameTemplate,
        payloadSchema: action?.payloadSchema,
        raw: action ?? node,
      });
    }
    const children = Array.isArray(node.children) ? node.children.filter(isRecord) : [];
    for (const child of children) {
      visit(child);
    }
  }
  visit(root);
  return commands;
}

function findAdvertisedCommand(
  loaded: LoadedOdinInterface,
  command: string,
): InterfaceCommandSummary | undefined {
  return extractProviderCommands(loaded).find((entry) => entry.command === command);
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
