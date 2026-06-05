import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";

import { DEFAULT_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";
import { searchHistoryWithArchiveFallback } from "@voidbot/rag";
import {
  applyRepoPersonaPostFatigueAfterSpeech,
  applyVoidSelfStateOperation,
  buildVoidSelfStateContext,
  personaRegistryAsRepoDiscordRegistry,
  findRepoDiscordIdentity,
  isRepoDiscordIdentityAllowedInChannel,
  loadPersonaIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  renderPersonaIdentityDoctrine,
  resolvePersonaStatePath,
  resolveRepoPersonaStatePath,
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
  type ApplyRepoPersonaStateOperationArgs,
  type PostDiscordMessageArgs,
  type PostRepoIdentityMessageArgs,
  type RepoPersonaSelfTranscriptArgs,
  type RepoPersonaSelfTranscriptSearchArgs,
  type RepoPersonaSelfTranscriptsListArgs,
  type RepoPersonaStateArgs,
  type RuntimeInfoArgs,
  type SearchHistoryArgs,
  type SearchSourcesArgs,
  type SourceContextArgs,
  formatArchivedMessage,
  formatHistoryResults,
  formatSourceResults,
  applyRepoPersonaStateOperationInputSchema,
  messageContextInputSchema,
  notifyOwnerInputSchema,
  odinEndpointInputSchema,
  odinInterfaceCommandInputSchema,
  odinInterfaceContextInputSchema,
  odinSurfaceInputSchema,
  postDiscordMessageInputSchema,
  postRepoIdentityMessageInputSchema,
  repoPersonaSelfTranscriptInputSchema,
  repoPersonaSelfTranscriptSearchInputSchema,
  repoPersonaSelfTranscriptsListInputSchema,
  repoPersonaStateInputSchema,
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
        "Compatibility relay: list Eve/CultUI providers currently advertised through Odin's transitional HTTP surface. Native GameCult agents use CultNet/CultMesh Verse discovery through CultLib's cultmesh-ts runtime.",
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
        "Compatibility relay: read Odin's current all-seer lowering and list the Verse/service nodes it publishes. This is read-only; native discovery belongs on CultNet/CultMesh.",
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
        "Compatibility relay: read Odin's current all-seer Eve/CultUI lowering, or ask Odin for one provider surface by providerId. Use this for read-only inspection only; native agents should use CultMesh/CultNet surfaces directly.",
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
    "load_odin_interface_context",
    {
      title: "Load Odin Interface Context",
      description:
        "Compatibility relay: load one provider-owned CultMesh/Eve interface visible through Odin and lower it into compact text, tree, and command context. This is token-efficient inspection over a transitional lowering, not native CultNet/CultMesh access.",
      inputSchema: odinInterfaceContextInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: OdinInterfaceContextArgs): Promise<CallToolResult> => {
      const odinBaseUrl = normalizeOdinBaseUrl(input.odinBaseUrl);
      const loaded = await loadOdinProviderInterface(odinBaseUrl, input.providerId);
      const contextSummary = summarizeProviderInterface(loaded, {
        maxTextItems: input.maxTextItems ?? 32,
        maxTreeItems: input.maxTreeItems ?? 80,
      });

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              odinBaseUrl,
              ...contextSummary,
            }),
          },
        ],
        structuredContent: {
          odinBaseUrl,
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
        "Compatibility relay: send an explicit command through a provider-owned Eve/CultUI command boundary discovered via Odin. Native commands belong on CultNet/CultMesh; this only relays to transitional provider endpoints when advertised.",
      inputSchema: odinInterfaceCommandInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: OdinInterfaceCommandArgs): Promise<CallToolResult> => {
      const odinBaseUrl = normalizeOdinBaseUrl(input.odinBaseUrl);
      const loaded = await loadOdinProviderInterface(odinBaseUrl, input.providerId);
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

      if (!loaded.source.startsWith("ws://")) {
        return {
          content: [
            {
              type: "text",
              text: `Provider ${input.providerId} is visible through ${loaded.source || "an unknown source"}, but this MCP compatibility relay only supports provider WebSocket command endpoints. Native commands belong on CultNet/CultMesh.`,
            },
          ],
          structuredContent: {
            sent: false,
            reason: "unsupported_command_transport",
            providerId: input.providerId,
            command: input.command,
            source: loaded.source,
          },
          isError: true,
        };
      }

      const frame = input.frame ?? buildCommandFrame(input.providerId, command, input.payload ?? {});
      const receipt = await sendProviderCommandFrame(loaded.source, frame, input.expectReceiptMs ?? 5000);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              sent: true,
              providerId: input.providerId,
              source: loaded.source,
              command: input.command,
              frame,
              receipt,
            }),
          },
        ],
        structuredContent: {
          sent: true,
          providerId: input.providerId,
          source: loaded.source,
          command: input.command,
          frame,
          receipt,
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
      const faceRegistry = await loadPersonaIdentityRegistry(context.config.repoDiscordIdentitiesPath);
      const registry = personaRegistryAsRepoDiscordRegistry(faceRegistry);
      const identities = registry.identities.map((identity) => ({
        id: identity.id,
        repoName: identity.repoName,
        repoPath: identity.repoPath ?? null,
        displayName: identity.displayName,
        roleId: identity.roleId ?? null,
        mention: identity.roleId ? `<@&${identity.roleId}>` : null,
        allowedChannelIds: identity.allowedChannelIds,
        personaStatePath: resolveRepoPersonaStatePath(identity, context.config.storageRoot),
        hasAvatarUrl: Boolean(identity.avatarUrl),
        description: identity.description ?? null,
      }));
      const epiphanies = faceRegistry.epiphanies.map((epiphany) => ({
        id: epiphany.id,
        displayName: epiphany.displayName,
        description: epiphany.description ?? null,
        repoNames: epiphany.repoNames,
        jurisdictions: epiphany.jurisdictions,
        faces: epiphany.personas.map((face) => face.id),
      }));
      const faces = faceRegistry.personas.map((face) => ({
        id: face.id,
        displayName: face.displayName,
        epiphanyId: face.epiphanyId,
        epiphanyDisplayName: face.epiphanyDisplayName,
        roleId: face.roleId ?? null,
        mention: face.roleId ? `<@&${face.roleId}>` : null,
        allowedChannelIds: face.allowedChannelIds,
        grants: face.grants,
        jurisdictions: [...face.inheritedJurisdictions, ...face.jurisdictions],
        personaStatePath: resolvePersonaStatePath(face, context.config.storageRoot),
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
      const registry = personaRegistryAsRepoDiscordRegistry(
        await loadPersonaIdentityRegistry(context.config.repoDiscordIdentitiesPath),
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
    "read_repo_persona_state",
    {
      title: "Read Repo Persona State",
      description:
        "Read the typed persistent Persona state for a registered repo identity. Persona state uses the same typed operation machinery as Void, but the state file belongs to the repo identity.",
      inputSchema: repoPersonaStateInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: RepoPersonaStateArgs): Promise<CallToolResult> => {
      const resolved = await resolveRepoIdentityForTool(context, input.identity);

      if (!resolved.identity) {
        return resolved.error;
      }

      const typedState = await loadVoidSelfStateTypedDocuments({
        canonicalPath: resolved.personaStatePath,
        identity: {
          agentId: resolved.identity.id,
          publicName: resolved.identity.displayName,
          publicDescription: resolved.identity.description,
        },
      });
      const rendered = buildVoidSelfStateContext(typedState, {
        sourcePath: resolved.personaStatePath,
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
              personaStatePath: resolved.personaStatePath,
              summary: rendered.summary,
              typedState,
            }),
          },
        ],
        structuredContent: {
          identity: identityForToolResult(resolved.identity, resolved.face),
          personaStatePath: resolved.personaStatePath,
          summary: rendered.summary,
          typedState,
        },
      };
    },
  );

  registerIfAllowed(
    "list_repo_persona_self_transcripts",
    {
      title: "List Repo Persona Self Transcripts",
      description:
        "List recent read-only Projector / Persona / Interpreter / Delivery witness packets for a registered repo Persona. Use this when the Persona wants to inspect how recent turns were shaped without injecting those transcripts into every prompt.",
      inputSchema: repoPersonaSelfTranscriptsListInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: RepoPersonaSelfTranscriptsListArgs): Promise<CallToolResult> => {
      const resolved = await resolveRepoIdentityForTool(context, input.identity);

      if (!resolved.identity) {
        return resolved.error;
      }

      const packets = await listRepoPersonaSelfTranscriptPackets(context, resolved.identity, input.limit ?? 5);

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              identity: identityForToolResult(resolved.identity, resolved.face),
              count: packets.length,
              packets,
            }),
          },
        ],
        structuredContent: {
          identity: identityForToolResult(resolved.identity, resolved.face),
          count: packets.length,
          packets,
        },
      };
    },
  );

  registerIfAllowed(
    "read_repo_persona_self_transcript",
    {
      title: "Read Repo Persona Self Transcript",
      description:
        "Read one read-only self-transcript witness packet for a registered repo Persona: what was projected, what the Persona wrote, what the Interpreter routed, and what delivery receipts exist.",
      inputSchema: repoPersonaSelfTranscriptInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: RepoPersonaSelfTranscriptArgs): Promise<CallToolResult> => {
      const resolved = await resolveRepoIdentityForTool(context, input.identity);

      if (!resolved.identity) {
        return resolved.error;
      }

      const packet = await readRepoPersonaSelfTranscriptPacket(
        context,
        resolved.identity,
        input.jobId,
        Boolean(input.includeRaw),
      );
      if (!packet) {
        return {
          content: [
            {
              type: "text",
              text: `No self-transcript packet for ${resolved.identity.id} matched job ${input.jobId}.`,
            },
          ],
          structuredContent: {
            found: false,
            identity: identityForToolResult(resolved.identity, resolved.face),
            jobId: input.jobId,
          },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock(packet),
          },
        ],
        structuredContent: packet,
      };
    },
  );

  registerIfAllowed(
    "search_repo_persona_self_transcripts",
    {
      title: "Search Repo Persona Self Transcripts",
      description:
        "Search recent read-only self-transcript witness packets for a registered repo Persona. This searches Projector, Persona, Interpreter, and delivery preview text.",
      inputSchema: repoPersonaSelfTranscriptSearchInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: RepoPersonaSelfTranscriptSearchArgs): Promise<CallToolResult> => {
      const resolved = await resolveRepoIdentityForTool(context, input.identity);

      if (!resolved.identity) {
        return resolved.error;
      }

      const packets = await searchRepoPersonaSelfTranscriptPackets(
        context,
        resolved.identity,
        input.query,
        input.limit ?? 5,
      );

      return {
        content: [
          {
            type: "text",
            text: renderJsonBlock({
              identity: identityForToolResult(resolved.identity, resolved.face),
              query: input.query,
              count: packets.length,
              packets,
            }),
          },
        ],
        structuredContent: {
          identity: identityForToolResult(resolved.identity, resolved.face),
          query: input.query,
          count: packets.length,
          packets,
        },
      };
    },
  );

  registerIfAllowed(
    "apply_repo_persona_state_operation",
    {
      title: "Apply Repo Persona State Operation",
      description:
        "Apply one typed state operation to a registered repo identity's Persona state. Use this for Persona memory, incubation, agency pressure, candidate interventions, and receipts; do not edit the Persona state file directly.",
      inputSchema: applyRepoPersonaStateOperationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: ApplyRepoPersonaStateOperationArgs): Promise<CallToolResult> => {
      const resolved = await resolveRepoIdentityForTool(context, input.identity);

      if (!resolved.identity) {
        return resolved.error;
      }

      const result = await applyVoidSelfStateOperation(
        {
          canonicalPath: resolved.personaStatePath,
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
              personaStatePath: resolved.personaStatePath,
              result,
            }),
          },
        ],
        structuredContent: {
          applied: true,
          identity: identityForToolResult(resolved.identity, resolved.face),
          personaStatePath: resolved.personaStatePath,
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
      face?: Awaited<ReturnType<typeof loadPersonaIdentityRegistry>>["personas"][number];
      personaStatePath: string;
    }
  | {
      identity?: undefined;
      error: CallToolResult;
    }
> {
  const faceRegistry = await loadPersonaIdentityRegistry(context.config.repoDiscordIdentitiesPath);
  const registry = personaRegistryAsRepoDiscordRegistry(faceRegistry);
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
    face: faceRegistry.personas.find((face) => face.id === identity.id),
    personaStatePath: resolveRepoPersonaStatePath(identity, context.config.storageRoot),
  };
}

interface RepoPersonaModelOutputRecord {
  jobId: string;
  command: string;
  promptMarker?: string | null;
  loggedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  model?: string;
  finalMessage?: string | null;
  artifactRefs?: Record<string, string>;
  usage?: unknown;
  exitCode?: number | null;
  timedOut?: boolean;
}

interface RepoPersonaDeliveryReceipt {
  receiptKey?: string;
  sentAt?: string;
  channelId?: string;
  replyToMessageId?: string;
  messageId?: string;
  transport?: string;
  preview?: string;
}

async function listRepoPersonaSelfTranscriptPackets(
  context: VoidbotMcpContext,
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const logs = await readRepoPersonaModelOutputLogs(context);
  const grouped = await groupRepoPersonaTurnLogsForIdentity(context, identity, logs);
  const receipts = await readRepoPersonaDeliveryReceipts(context, identity);
  return grouped
    .slice(0, limit)
    .map((group) => summarizeRepoPersonaTranscriptGroup(identity, group, logs, receipts, false));
}

async function readRepoPersonaSelfTranscriptPacket(
  context: VoidbotMcpContext,
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  jobId: string,
  includeRaw: boolean,
): Promise<Record<string, unknown> | undefined> {
  const logs = await readRepoPersonaModelOutputLogs(context);
  const grouped = await groupRepoPersonaTurnLogsForIdentity(context, identity, logs);
  const group = grouped.find((entry) => entry.jobId === jobId);
  if (!group) {
    return undefined;
  }
  const receipts = await readRepoPersonaDeliveryReceipts(context, identity);
  return summarizeRepoPersonaTranscriptGroup(identity, group, logs, receipts, includeRaw);
}

async function searchRepoPersonaSelfTranscriptPackets(
  context: VoidbotMcpContext,
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  query: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const logs = await readRepoPersonaModelOutputLogs(context);
  const grouped = await groupRepoPersonaTurnLogsForIdentity(context, identity, logs);
  const receipts = await readRepoPersonaDeliveryReceipts(context, identity);
  const needle = query.toLowerCase();
  return grouped
    .map((group) => summarizeRepoPersonaTranscriptGroup(identity, group, logs, receipts, false))
    .filter((packet) => JSON.stringify(packet).toLowerCase().includes(needle))
    .slice(0, limit);
}

async function readRepoPersonaModelOutputLogs(context: VoidbotMcpContext): Promise<RepoPersonaModelOutputRecord[]> {
  const logPath = join(context.config.storageRoot, "logs", "model-outputs.jsonl");
  let content = "";
  try {
    content = await readFile(logPath, "utf8");
  } catch {
    return [];
  }

  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RepoPersonaModelOutputRecord;
      } catch {
        return undefined;
      }
    })
    .filter((record): record is RepoPersonaModelOutputRecord => Boolean(record))
    .filter((record) =>
      record.command === "repo-persona-rumination" ||
      record.command === "repo-persona-state-projector"
    );
}

async function groupRepoPersonaTurnLogsForIdentity(
  context: VoidbotMcpContext,
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  logs: RepoPersonaModelOutputRecord[],
): Promise<Array<{
  jobId: string;
  requestPath?: string;
  requestExcerpt?: string;
  persona: RepoPersonaModelOutputRecord[];
  interpreter: RepoPersonaModelOutputRecord[];
  firstAt?: string;
  lastAt?: string;
}>> {
  const byJob = new Map<string, RepoPersonaModelOutputRecord[]>();
  for (const record of logs.filter((entry) => entry.command === "repo-persona-rumination")) {
    if (!record.jobId) {
      continue;
    }
    const records = byJob.get(record.jobId) ?? [];
    records.push(record);
    byJob.set(record.jobId, records);
  }

  const groups: Array<{
    jobId: string;
    requestPath?: string;
    requestExcerpt?: string;
    persona: RepoPersonaModelOutputRecord[];
    interpreter: RepoPersonaModelOutputRecord[];
    firstAt?: string;
    lastAt?: string;
  }> = [];

  for (const [jobId, records] of byJob) {
    const requestPath = resolve(context.config.storageRoot, "artifacts", jobId, "request.md");
    const request = await readOptionalText(requestPath);
    if (!request || !requestBelongsToRepoPersona(request, identity)) {
      continue;
    }
    const sorted = records.slice().sort(compareModelOutputRecords);
    groups.push({
      jobId,
      requestPath,
      requestExcerpt: excerptRequestWitness(request),
      persona: sorted.filter((record) => record.promptMarker === "character-turn"),
      interpreter: sorted.filter((record) => record.promptMarker === "repo-persona-turn-interpreter"),
      firstAt: sorted[0]?.startedAt ?? sorted[0]?.loggedAt,
      lastAt: sorted.at(-1)?.finishedAt ?? sorted.at(-1)?.loggedAt,
    });
  }

  return groups.sort((left, right) =>
    Date.parse(right.firstAt ?? "") - Date.parse(left.firstAt ?? "")
  );
}

function summarizeRepoPersonaTranscriptGroup(
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  group: {
    jobId: string;
    requestPath?: string;
    requestExcerpt?: string;
    persona: RepoPersonaModelOutputRecord[];
    interpreter: RepoPersonaModelOutputRecord[];
    firstAt?: string;
    lastAt?: string;
  },
  logs: RepoPersonaModelOutputRecord[],
  receipts: RepoPersonaDeliveryReceipt[],
  includeRaw: boolean,
): Record<string, unknown> {
  const projector = findNearestProjectorRecord(identity, logs, group.firstAt);
  const delivered = receipts.filter((receipt) => receiptInTurnWindow(receipt, group.firstAt, group.lastAt));
  return {
    schemaVersion: 1,
    identity: {
      id: identity.id,
      displayName: identity.displayName,
      repoName: identity.repoName,
    },
    jobId: group.jobId,
    startedAt: group.firstAt ?? null,
    finishedAt: group.lastAt ?? null,
    seen: {
      requestPath: group.requestPath ?? null,
      requestExcerpt: group.requestExcerpt ?? null,
    },
    projected: projector
      ? modelRecordSummary(projector, includeRaw)
      : null,
    persona: group.persona.map((record) => modelRecordSummary(record, includeRaw)),
    interpreted: group.interpreter.map((record) => modelRecordSummary(record, includeRaw)),
    delivered: delivered.map((receipt) => ({
      sentAt: receipt.sentAt ?? null,
      channelId: receipt.channelId ?? null,
      replyToMessageId: receipt.replyToMessageId ?? null,
      messageId: receipt.messageId ?? receipt.receiptKey?.split(":").at(-1) ?? null,
      transport: receipt.transport ?? null,
      preview: receipt.preview ?? null,
    })),
    artifactRefs: {
      persona: group.persona.map((record) => record.artifactRefs ?? {}),
      interpreter: group.interpreter.map((record) => record.artifactRefs ?? {}),
    },
  };
}

function modelRecordSummary(record: RepoPersonaModelOutputRecord, includeRaw: boolean): Record<string, unknown> {
  return {
    jobId: record.jobId,
    command: record.command,
    promptMarker: record.promptMarker ?? null,
    model: record.model ?? null,
    loggedAt: record.loggedAt ?? null,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    exitCode: record.exitCode ?? null,
    timedOut: record.timedOut ?? false,
    usage: record.usage ?? null,
    finalMessage: includeRaw
      ? record.finalMessage ?? null
      : collapseText(record.finalMessage ?? "", 900),
    artifactRefs: record.artifactRefs ?? {},
  };
}

function findNearestProjectorRecord(
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  logs: RepoPersonaModelOutputRecord[],
  before: string | undefined,
): RepoPersonaModelOutputRecord | undefined {
  const beforeMs = Date.parse(before ?? "");
  return logs
    .filter((record) =>
      record.command === "repo-persona-state-projector" &&
      record.jobId?.startsWith(`state-projector:${identity.id}:`)
    )
    .filter((record) => {
      if (!Number.isFinite(beforeMs)) {
        return true;
      }
      const loggedAtMs = Date.parse(record.loggedAt ?? record.finishedAt ?? record.startedAt ?? "");
      return Number.isFinite(loggedAtMs) && loggedAtMs <= beforeMs;
    })
    .sort(compareModelOutputRecords)
    .at(-1);
}

async function readRepoPersonaDeliveryReceipts(
  context: VoidbotMcpContext,
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
): Promise<RepoPersonaDeliveryReceipt[]> {
  const typedState = await loadVoidSelfStateTypedDocuments({
    canonicalPath: resolveRepoPersonaStatePath(identity, context.config.storageRoot),
    identity: {
      agentId: identity.id,
      publicName: identity.displayName,
      publicDescription: identity.description,
    },
  });
  const receipts = (typedState.speechReceipts as { recentReceipts?: unknown[] }).recentReceipts ?? [];
  return receipts.filter((entry): entry is RepoPersonaDeliveryReceipt =>
    Boolean(entry) && typeof entry === "object"
  );
}

function receiptInTurnWindow(receipt: RepoPersonaDeliveryReceipt, startedAt: string | undefined, finishedAt: string | undefined): boolean {
  const sentAtMs = Date.parse(receipt.sentAt ?? "");
  const startMs = Date.parse(startedAt ?? "");
  const finishMs = Date.parse(finishedAt ?? "");
  if (!Number.isFinite(sentAtMs)) {
    return false;
  }
  const lower = Number.isFinite(startMs) ? startMs - 60_000 : -Infinity;
  const upper = Number.isFinite(finishMs) ? finishMs + 5 * 60_000 : Infinity;
  return sentAtMs >= lower && sentAtMs <= upper;
}

function requestBelongsToRepoPersona(
  request: string,
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
): boolean {
  const firstLine = request.split(/\r?\n/).find((line) => line.startsWith("Be "));
  return Boolean(
    firstLine &&
    firstLine.includes(`Be ${identity.displayName} `) &&
    firstLine.includes(` around ${identity.repoName}.`),
  );
}

function excerptRequestWitness(request: string): string {
  const markers = [
    "Recent conversation transcript:",
    "Fresh projected state for this turn:",
    "Current room (",
    "Visible cross-channel chronology",
  ];
  const index = markers
    .map((marker) => request.indexOf(marker))
    .filter((entry) => entry >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  return collapseText(request.slice(index), 1800);
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function compareModelOutputRecords(left: RepoPersonaModelOutputRecord, right: RepoPersonaModelOutputRecord): number {
  return Date.parse(left.startedAt ?? left.loggedAt ?? "") - Date.parse(right.startedAt ?? right.loggedAt ?? "");
}

function collapseText(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, Math.max(0, maxLength - 3))}...` : collapsed;
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
      canonicalPath: resolveRepoPersonaStatePath(input.identity, input.context.config.storageRoot),
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
    await applyRepoPersonaPostFatigueAfterSpeech({
      identity: input.identity,
      storageRoot: input.context.config.storageRoot,
      heartbeatStatePath: input.context.config.repoPersonaHeartbeats.statePath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not apply repo Persona post fatigue for ${input.identity.id}: ${message}`);
  }
}

function identityForToolResult(
  identity: NonNullable<ReturnType<typeof findRepoDiscordIdentity>>,
  face?: Awaited<ReturnType<typeof loadPersonaIdentityRegistry>>["personas"][number],
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
    doctrine: face ? renderPersonaIdentityDoctrine(face) : null,
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
  const connection = await openWebSocketSnapshotSocket(deckUrl);
  const { socket } = connection;
  let pendingBuffer = connection.initialBuffer;
  try {
    if (providerId) {
      sendClientWebSocketText(socket, JSON.stringify({ type: "open-provider", providerId }));
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const frame = await readServerWebSocketText(socket, 3000, pendingBuffer);
      pendingBuffer = frame.remaining;
      const message = frame.text;
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

interface LoadedOdinInterface {
  providerId: string;
  title: string;
  source: string;
  status: string;
  detail: string;
  manifest: Record<string, unknown> | null;
  snapshot: Record<string, unknown>;
  root?: Record<string, unknown>;
  loadedFrom: "provider-websocket" | "odin-embedded-interface";
}

interface InterfaceCommandSummary {
  command: string;
  label: string;
  source: "surface.commands" | "node.action" | "node.command";
  nodeId?: string;
  transport?: string;
  frameTemplate?: unknown;
  payloadSchema?: unknown;
  raw: Record<string, unknown>;
}

async function loadOdinProviderInterface(
  odinBaseUrl: string,
  providerId: string,
): Promise<LoadedOdinInterface> {
  const odinSnapshot = await fetchOdinDeckSnapshot(odinBaseUrl);
  const interfaceNode = findOdinInterfaceNode(odinSnapshot, providerId);
  if (!interfaceNode) {
    throw new Error(`Odin does not currently expose provider interface ${providerId}.`);
  }

  const props = isRecord(interfaceNode.props) ? interfaceNode.props : {};
  const source = stringValue(props.source);
  if (source.startsWith("ws://")) {
    try {
      const providerSnapshot = await fetchProviderDeckSnapshot(source, providerId);
      return {
        providerId,
        title: stringValue(providerSnapshot.title) || stringValue(props.title) || providerId,
        source,
        status: stringValue(props.status),
        detail: stringValue(props.detail),
        manifest: isRecord(props.manifest) ? props.manifest : null,
        snapshot: providerSnapshot,
        root: getSurfaceRoot(providerSnapshot),
        loadedFrom: "provider-websocket",
      };
    } catch (error) {
      const embedded = embeddedInterfaceRoot(interfaceNode);
      if (!embedded) {
        throw error;
      }
      return {
        providerId,
        title: stringValue(props.title) || providerId,
        source,
        status: stringValue(props.status),
        detail: `provider websocket failed; using Odin embedded root: ${error instanceof Error ? error.message : String(error)}`,
        manifest: isRecord(props.manifest) ? props.manifest : null,
        snapshot: odinSnapshot,
        root: embedded,
        loadedFrom: "odin-embedded-interface",
      };
    }
  }

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

async function fetchProviderDeckSnapshot(
  deckUrlText: string,
  providerId: string,
): Promise<Record<string, unknown>> {
  const deckUrl = new URL(deckUrlText);
  const connection = await openWebSocketSnapshotSocket(deckUrl);
  const { socket } = connection;
  let pendingBuffer = connection.initialBuffer;
  try {
    sendClientWebSocketText(socket, JSON.stringify({ type: "open-provider", providerId }));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const frame = await readServerWebSocketText(socket, 3000, pendingBuffer);
      pendingBuffer = frame.remaining;
      const parsed = JSON.parse(frame.text) as unknown;
      if (isRecord(parsed) && parsed.providerId === providerId) {
        return parsed;
      }
    }
    throw new Error(`Provider deck did not publish ${providerId}.`);
  } finally {
    socket.destroy();
  }
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

  for (const command of surfaceCommands) {
    const commandName = stringValue(command.command) || stringValue(command.id);
    if (!commandName) {
      continue;
    }
    commands.push({
      command: commandName,
      label: stringValue(command.label) || commandName,
      source: "surface.commands",
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

function buildCommandFrame(
  providerId: string,
  command: InterfaceCommandSummary,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (isRecord(command.frameTemplate)) {
    return materializeFrameTemplate(command.frameTemplate, payload);
  }

  return {
    type: "surface-command",
    schema: "gamecult.eve.command.v1",
    providerId,
    command: command.command,
    payload,
    nodeId: command.nodeId,
  };
}

function materializeFrameTemplate(
  template: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const materialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    materialized[key] = materializeTemplateValue(value, payload);
  }
  return materialized;
}

function materializeTemplateValue(value: unknown, payload: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\$\{([A-Za-z0-9_.-]+)\??\}$/);
    if (exact) {
      return payload[exact[1]] ?? "";
    }
    return value.replace(/\$\{([A-Za-z0-9_.-]+)\??\}/g, (_match, key: string) =>
      payload[key] === undefined || payload[key] === null ? "" : String(payload[key]),
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeTemplateValue(entry, payload));
  }
  if (isRecord(value)) {
    return materializeFrameTemplate(value, payload);
  }
  return value;
}

async function sendProviderCommandFrame(
  deckUrlText: string,
  frame: Record<string, unknown>,
  expectReceiptMs: number,
) {
  const deckUrl = new URL(deckUrlText);
  const connection = await openWebSocketSnapshotSocket(deckUrl);
  const { socket } = connection;
  let pendingBuffer = connection.initialBuffer;
  try {
    try {
      const initial = await readServerWebSocketText(socket, 1000, pendingBuffer);
      pendingBuffer = initial.remaining;
    } catch {
      // Some providers do not send an initial deck frame before commands.
    }
    sendClientWebSocketText(socket, JSON.stringify(frame));
    if (expectReceiptMs <= 0) {
      return {
        received: false,
        detail: "Command frame sent; receipt wait disabled.",
      };
    }
    try {
      const response = await readServerWebSocketText(socket, expectReceiptMs, pendingBuffer);
      pendingBuffer = response.remaining;
      const parsed = JSON.parse(response.text) as unknown;
      return {
        received: true,
        frame: isRecord(parsed) ? parsed : response.text,
        remainingBytes: pendingBuffer.length,
      };
    } catch (error) {
      return {
        received: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    socket.destroy();
  }
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

function openWebSocketSnapshotSocket(url: URL): Promise<{ socket: net.Socket; initialBuffer: Buffer }> {
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
      resolve({ socket, initialBuffer: buffer.subarray(marker + 4) });
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

function readServerWebSocketText(
  socket: net.Socket,
  timeoutMs: number,
  initialBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): Promise<{ text: string; remaining: Buffer<ArrayBufferLike> }> {
  return new Promise((resolve, reject) => {
    let buffer = initialBuffer;
    const timer = setTimeout(() => cleanup(new Error("Timed out waiting for Odin deck frame")), timeoutMs);
    function cleanup(error?: Error, value?: { text: string; remaining: Buffer<ArrayBufferLike> }) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve(value ?? { text: "", remaining: Buffer.alloc(0) });
      }
    }
    function onError(error: Error) {
      cleanup(error);
    }
    function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      readBufferedFrame();
    }
    function readBufferedFrame() {
      const frame = tryReadWebSocketFrame(buffer);
      if (!frame) {
        return;
      }
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x1) {
        cleanup(undefined, {
          text: frame.payload.toString("utf8"),
          remaining: buffer,
        });
      } else if (frame.opcode === 0x8) {
        cleanup(new Error("Odin websocket closed"));
      }
    }
    socket.on("data", onData);
    socket.on("error", onError);
    readBufferedFrame();
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
