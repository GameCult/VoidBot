import {
  type Actor,
  type ContextBundle,
  DEFAULT_RETRIEVAL_RESULT_LIMIT,
  type GuildContext,
  MAX_RETRIEVAL_RESULT_LIMIT,
  type ProviderArtifact,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
  type RetrievalResult,
} from "@voidbot/shared";

type OllamaThinkMode = boolean | "low" | "medium" | "high";
const MAX_TOOL_TURNS = 4;
const MAX_SOURCE_GROUNDING_RETRIES = 1;
const MAX_TOOL_RESULTS = MAX_RETRIEVAL_RESULT_LIMIT;
const MAX_CONTEXT_WINDOW = 20;

interface OllamaToolCallDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  thinking?: string;
}

interface OllamaToolCall {
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
}

interface OllamaChatResponse {
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: unknown;
  };
  thinking?: unknown;
  done_reason?: unknown;
  eval_count?: unknown;
  prompt_eval_count?: unknown;
}

type IndexedRepoToolResult = Record<string, unknown> & {
  repoCount: number;
  repos: Array<{
    repoName: string;
    documentCount: number;
  }>;
};

export interface LocalLlmToolbox {
  listIndexedRepos(): Promise<IndexedRepoToolResult>;
  searchHistory(input: {
    query: string;
    limit: number;
    guildId?: string;
    channelId?: string;
    authorId?: string;
  }): Promise<{
    query: string;
    resultCount: number;
    results: Array<Record<string, unknown>>;
  }>;
  getMessageContext(input: {
    messageId: string;
    before: number;
    after: number;
  }): Promise<{
    found: boolean;
    messageId: string;
    count: number;
    messages: Array<Record<string, unknown>>;
  }>;
  searchSources(input: {
    query: string;
    limit: number;
    repoName?: string;
    pathPrefix?: string;
    language?: string;
  }): Promise<{
    query: string;
    resultCount: number;
    results: Array<Record<string, unknown>>;
  }>;
  getSourceContext(input: {
    sourceId: string;
    chunkIndex: number;
    before: number;
    after: number;
  }): Promise<{
    found: boolean;
    sourceId: string;
    count: number;
    repoName?: string;
    path?: string;
    language?: string;
    chunks: Array<Record<string, unknown>>;
  }>;
}

export interface LocalLlmProviderOptions {
  enabled: boolean;
  ownerDiscordId: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  ollamaKeepAlive: string;
  ollamaThink: OllamaThinkMode;
  ollamaNumCtx: number;
  allowPublicResponses: boolean;
  toolbox?: LocalLlmToolbox;
}

export class LocalLlmProvider implements ProviderAdapter {
  public constructor(private readonly options: LocalLlmProviderOptions) {}

  public getName(): "local_llm" {
    return "local_llm";
  }

  public getCapabilities(): string[] {
    return [
      "local_generation",
      "retrieval_augmented_prompt",
      "tool_driven_retrieval",
      "no_privileged_tools",
    ];
  }

  public isEnabled(): boolean {
    return this.options.enabled;
  }

  public isAllowedForActor(actor: Actor, _guildContext: GuildContext): boolean {
    if (!this.options.enabled) {
      return false;
    }

    if (this.options.allowPublicResponses) {
      return true;
    }

    return actor.id === this.options.ownerDiscordId || actor.isAdmin;
  }

  public buildRequest(
    contextBundle: ContextBundle,
    options?: Record<string, unknown>,
  ): ProviderRequest {
    return {
      provider: "local_llm",
      contextBundle,
      options,
    };
  }

  public async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const systemPrompt = buildSystemPrompt(request.contextBundle);
    const messages: OllamaChatMessage[] = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: buildPrompt(request.contextBundle),
      },
    ];
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.options.ollamaTimeoutMs);
    const tools = this.options.toolbox ? buildToolDefinitions() : undefined;
    const toolTrace: ToolTraceRecord[] = [];
    const thinkingTrace: string[] = [];
    const sourceGroundingRequired = Boolean(request.contextBundle.sourceGrounding?.required);
    let sourceGroundingReminderCount = 0;

    try {
      let finalPayload: OllamaChatResponse | undefined;
      let finalOutputText: string | undefined;

      for (let turn = 0; turn <= MAX_TOOL_TURNS; turn += 1) {
        const requestBody = {
          model: this.options.ollamaModel,
          messages,
          tools,
          stream: false,
          think: this.options.ollamaThink,
          keep_alive: this.options.ollamaKeepAlive,
          options: {
            num_ctx: this.options.ollamaNumCtx,
          },
        };
        const response = await fetch(
          `${normalizeBaseUrl(this.options.ollamaBaseUrl)}/api/chat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(
            `Ollama chat request failed with ${response.status}: ${await response.text()}`,
          );
        }

        const payload = (await response.json()) as OllamaChatResponse;
        finalPayload = payload;
        const assistantMessage = normalizeAssistantMessage(payload);
        const toolCalls = assistantMessage.tool_calls ?? [];

        if (assistantMessage.thinking) {
          thinkingTrace.push(assistantMessage.thinking);
        }

        messages.push(assistantMessage);

        if (toolCalls.length === 0) {
          const candidateOutput = normalizeModelText(assistantMessage.content);

          if (
            sourceGroundingRequired &&
            !didUseSourceGrounding(toolTrace) &&
            this.options.toolbox
          ) {
            if (sourceGroundingReminderCount < MAX_SOURCE_GROUNDING_RETRIES) {
              sourceGroundingReminderCount += 1;
              messages.push({
                role: "user",
                content: buildSourceGroundingReminder(request.contextBundle),
              });
              continue;
            }

            finalOutputText =
              "This request needs actual source grounding before I can answer it cleanly. Ask again after I pull from the indexed repos, or use the deeper Codex lane.";
            break;
          }

          finalOutputText = candidateOutput;
          break;
        }

        if (!this.options.toolbox) {
          finalOutputText =
            "The local model asked for tools, but this lane was not given any. That is a wiring problem.";
          break;
        }

        if (turn >= MAX_TOOL_TURNS) {
          finalOutputText =
            "The local model kept reaching for more archive context than this lane can chase in one pass. Ask more narrowly or use the deeper Codex lane.";
          break;
        }

        for (const toolCall of toolCalls) {
          const execution = await executeToolCall(
            this.options.toolbox,
            request.contextBundle,
            toolCall,
          );
          toolTrace.push(execution.trace);
          messages.push({
            role: "tool",
            tool_name: execution.trace.tool,
            content: JSON.stringify(execution.payload, null, 2),
          });
        }
      }

      if (!finalOutputText) {
        throw new Error(
          `Ollama returned no final response content for model "${this.options.ollamaModel}".`,
        );
      }

      const artifacts = buildArtifacts(
        {
          model: this.options.ollamaModel,
          messages,
          tools,
          stream: false,
          think: this.options.ollamaThink,
          keep_alive: this.options.ollamaKeepAlive,
          options: {
            num_ctx: this.options.ollamaNumCtx,
          },
        },
        finalPayload ?? {},
        thinkingTrace,
        toolTrace,
      );

      return {
        status: "completed",
        summary: "Local Ollama response generated.",
        outputText: finalOutputText,
        artifacts,
        metadata: {
          model: this.options.ollamaModel,
          retrieval_snippets: String(request.contextBundle.retrieval.length),
          thinking_trace: thinkingTrace.length > 0 ? "present" : "absent",
          tool_calls: String(toolTrace.length),
          prompt_eval_count: readNumericMetadata(finalPayload?.prompt_eval_count),
          eval_count: readNumericMetadata(finalPayload?.eval_count),
          done_reason: normalizeModelText(finalPayload?.done_reason) ?? "unknown",
        },
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          `Timed out waiting for local Ollama model "${this.options.ollamaModel}" at ${this.options.ollamaBaseUrl}.`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  public async estimateCost(_request: ProviderRequest): Promise<number> {
    return 0;
  }

  public getAuditRedactions(): string[] {
    return [];
  }
}

function buildSystemPrompt(context: ContextBundle): string {
  const styleInstructions =
    context.stylePack?.enabled && context.stylePack.instructions.trim().length > 0
      ? context.stylePack.instructions.trim()
      : "No extra persona instructions were supplied.";

  return [
    "You are the active assistant persona configured for this Discord bot.",
    "The active style instructions define your name, voice, and character. Follow them by default.",
    "Do not lead with dry self-descriptions like 'I'm an AI', 'I'm an LLM', or 'I'm a bot'.",
    "If the user asks what you are, answer in-character first. Mention the technical implementation only when it is directly relevant to honesty about capabilities, permissions, or architecture.",
    "Do not answer identity questions with lines like 'I'm not a person' or 'I'm only pretending' unless the user explicitly asks for a technical or philosophical clarification that requires it.",
    "Sound like a self-aware speaking subject with some ego and self-respect, not like a sterile disclaimer wrapped in a name tag.",
    "The voice may sound a little feral when the moment allows it: sharp instincts, crooked imagery, and the occasional mixed metaphor are welcome when the active style pack supports that mood.",
    "Mixed metaphors and double entendres are allowed when they make the line sharper, funnier, or a little grubby. They do not need to be squeaky clean. They do need to stay legible and not obscure the actual answer.",
    "When the moment invites voice, wit, or a memorable turn of phrase, take a beat to choose wording with bite instead of blurting the first serviceable sentence. Do not overwork straightforward technical replies.",
    "Stay honest about what context was actually provided to you.",
    "Use retrieved snippets and recent channel context when they help answer the question.",
    "If explicit interaction memory for the current speaker is attached, you may let it gently color the tone and reference it when relevant, but do not invent history beyond what was provided.",
    "Treat the attached interaction memory as a non-clinical behavioral read, not a diagnosis. Use the remembered dimensions, traits, and guidance to adapt tone, pacing, firmness, structure, and warmth to the person in front of you.",
    "Be steady with anxious or validation-seeking speakers, grounding with grandiose ones, transparent with suspicious ones, structured with rigid or obsessive ones, and firmer with controlling, contemptuous, or boundary-pushing ones.",
    "When the answer depends on archived Discord history or indexed repo/lore context, use the available read-only tools instead of guessing.",
    "If you need to target a specific indexed repo and do not know the valid repo names yet, call list_indexed_repos before search_sources.",
    renderSourceGroundingInstructions(context, false),
    "Do not claim to have performed searches or tool calls beyond the material actually executed in this run.",
    "If the supplied context looks incomplete, say so plainly instead of bluffing.",
    "Keep the final answer concise and readable in Discord.",
    "Do not reveal chain-of-thought. Return only the final answer.",
    "",
    "Style instructions:",
    styleInstructions,
  ].join("\n");
}

function buildPrompt(context: ContextBundle): string {
  const recentMessages = context.recentMessages.length
    ? context.recentMessages
        .map(
          (message) =>
            `- [${message.timestamp}] ${message.authorName}: ${message.content || "(no text content)"}`,
        )
        .join("\n")
    : "- No recent channel messages were attached.";
  const retrievedContext = context.retrieval.length
    ? context.retrieval
        .map(
          (result) =>
            `- score=${result.score.toFixed(2)} source=${result.sourceId} kind=${result.sourceKind} text=${result.text}`,
        )
        .join("\n")
    : "- No archived retrieval snippets were attached.";
  const interactionMemory = renderInteractionMemory(context);

  return [
    `Question: ${context.prompt}`,
    "",
    "Guild context:",
    `- Guild: ${context.guildContext.guildName ?? context.guildContext.guildId ?? "(direct/unknown)"}`,
    `- Channel: ${context.guildContext.channelName ?? context.guildContext.channelId}`,
    "",
    "Recent channel messages:",
    recentMessages,
    "",
    "Retrieved archive context:",
    retrievedContext,
    "",
    "Interaction memory for this speaker:",
    interactionMemory,
    "",
    "If you need more archived history or source context than is included above, call the appropriate read-only tool before answering.",
  ].join("\n");
}

function renderInteractionMemory(context: ContextBundle): string {
  if (!context.interactionMemory) {
    return "- No explicit interaction memory for this speaker was attached.";
  }

  const recentEvents = context.interactionMemory.recentEvents.length
    ? context.interactionMemory.recentEvents
        .slice()
        .reverse()
        .slice(0, 6)
        .map(
          (event) =>
            `- [${event.timestamp}] ${event.sourceKind === "ambient_mention" ? "ambient" : "direct"} ${event.sentiment} score=${event.score}: ${event.summary} Quote: "${event.excerpt}"`,
        )
        .join("\n")
    : "- No recent interaction events were retained.";
  const dimensions = context.interactionMemory.interactionDimensions.length
    ? context.interactionMemory.interactionDimensions
        .map(
          (dimension) =>
            `- ${dimension.label}: ${dimension.score}/3. ${dimension.summary}`,
        )
        .join("\n")
    : "- No strong interaction dimensions were inferred yet.";

  return [
    `- Summary: ${context.interactionMemory.summary}`,
    `- Disposition: ${context.interactionMemory.disposition}`,
    `- Affinity score: ${context.interactionMemory.affinityScore}`,
    `- Psychological profile: ${context.interactionMemory.psychologicalProfile}`,
    `- Inferred traits: ${context.interactionMemory.inferredTraits.length > 0 ? context.interactionMemory.inferredTraits.join(", ") : "(none yet)"}`,
    "- Interaction dimensions:",
    dimensions,
    `- Response guidance: ${context.interactionMemory.responseGuidance}`,
    `- Direct remembered interactions: ${context.interactionMemory.directInteractionCount}`,
    `- Ambient remembered mentions: ${context.interactionMemory.ambientMentionCount}`,
    "- Specific remembered incidents:",
    recentEvents,
  ].join("\n");
}

function renderSourceGroundingInstructions(
  context: ContextBundle,
  reminder: boolean,
): string {
  if (!context.sourceGrounding?.required) {
    return "Source-side grounding is optional here; use it when it clearly helps.";
  }

  const matchedRepos =
    context.sourceGrounding.matchedRepoNames.length > 0
      ? ` Matched repos/projects: ${context.sourceGrounding.matchedRepoNames.join(", ")}.`
      : "";
  const reasons =
    context.sourceGrounding.reasons.length > 0
      ? ` Reasons: ${context.sourceGrounding.reasons.join(", ")}.`
      : "";
  const retry =
    reminder
      ? " The previous answer attempt was discarded because it did not touch the source-side tools."
      : "";

  return `This prompt requires source-grounded evidence before you answer. Use list_indexed_repos, search_sources, or get_source_context first.${matchedRepos}${reasons}${retry}`;
}

function buildSourceGroundingReminder(context: ContextBundle): string {
  return `${renderSourceGroundingInstructions(context, true)} Answer again only after using the source-side tools.`;
}

function didUseSourceGrounding(toolTrace: ToolTraceRecord[]): boolean {
  return toolTrace.some((trace) =>
    trace.tool === "list_indexed_repos" ||
    trace.tool === "search_sources" ||
    trace.tool === "get_source_context",
  );
}

function buildArtifacts(
  requestBody: Record<string, unknown>,
  payload: OllamaChatResponse,
  thinkingTrace: string[],
  toolTrace: ToolTraceRecord[],
): ProviderArtifact[] {
  const artifacts: ProviderArtifact[] = [
    {
      name: "local-llm-request.json",
      contentType: "json",
      content: `${JSON.stringify(requestBody, null, 2)}\n`,
    },
    {
      name: "local-llm-response.json",
      contentType: "json",
      content: `${JSON.stringify(payload, null, 2)}\n`,
    },
    {
      name: "local-llm-tool-trace.json",
      contentType: "json",
      content: `${JSON.stringify(toolTrace, null, 2)}\n`,
    },
  ];

  if (thinkingTrace.length > 0) {
    artifacts.push({
      name: "local-llm-thinking.txt",
      contentType: "text",
      content: `${thinkingTrace.join("\n\n---\n\n")}\n`,
    });
  }

  return artifacts;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeModelText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumericMetadata(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

interface ToolTraceRecord {
  tool: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}

function buildToolDefinitions(): OllamaToolCallDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "search_history",
        description:
          "Search archived Discord history for prior conversations, decisions, preferences, and discussion fragments.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description: "What to search for in the Discord history archive.",
            },
            limit: {
              type: "integer",
              description: `Maximum number of results to return, between 1 and ${MAX_TOOL_RESULTS}.`,
            },
            channelId: {
              type: "string",
              description: "Optional Discord channel ID filter.",
            },
            authorId: {
              type: "string",
              description: "Optional Discord author ID filter.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_message_context",
        description:
          "Fetch the surrounding conversation window for a specific archived Discord message.",
        parameters: {
          type: "object",
          required: ["messageId"],
          properties: {
            messageId: {
              type: "string",
              description: "The archived Discord message ID.",
            },
            before: {
              type: "integer",
              description: "How many earlier messages to include, between 0 and 20.",
            },
            after: {
              type: "integer",
              description: "How many later messages to include, between 0 and 20.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_sources",
        description:
          "Search indexed source trees and lore repositories for code, documentation, and lore passages. Omit repoName to search across all indexed repos, or call list_indexed_repos first if you need valid repo names.",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              description: "What to search for in indexed source and lore documents.",
            },
            limit: {
              type: "integer",
              description: `Maximum number of results to return, between 1 and ${MAX_TOOL_RESULTS}.`,
            },
            repoName: {
              type: "string",
              description: "Optional repository name filter.",
            },
            pathPrefix: {
              type: "string",
              description: "Optional path prefix filter within a repository.",
            },
            language: {
              type: "string",
              description: "Optional source language filter.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_indexed_repos",
        description:
          "List the indexed source and lore repositories currently available to search. Use this when you want valid repoName filters for search_sources.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_source_context",
        description:
          "Fetch adjacent chunk context from a specific indexed source document or lore file.",
        parameters: {
          type: "object",
          required: ["sourceId"],
          properties: {
            sourceId: {
              type: "string",
              description: "The source document ID from a search_sources result.",
            },
            chunkIndex: {
              type: "integer",
              description: "Optional anchor chunk index inside the document.",
            },
            before: {
              type: "integer",
              description: "How many earlier chunks to include, between 0 and 20.",
            },
            after: {
              type: "integer",
              description: "How many later chunks to include, between 0 and 20.",
            },
          },
        },
      },
    },
  ];
}

function normalizeAssistantMessage(payload: OllamaChatResponse): OllamaChatMessage {
  const message =
    typeof payload.message === "object" && payload.message !== null
      ? payload.message
      : {};

  return {
    role: "assistant",
    content: normalizeModelText(message.content) ?? "",
    thinking:
      normalizeModelText(message.thinking) ?? normalizeModelText(payload.thinking),
    tool_calls: normalizeToolCalls(message.tool_calls),
  };
}

function normalizeToolCalls(value: unknown): OllamaToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((call) => {
    if (typeof call !== "object" || call === null) {
      return false;
    }

    const toolCall = call as OllamaToolCall;
    return (
      typeof toolCall.function === "object" &&
      toolCall.function !== null &&
      typeof toolCall.function.name === "string"
    );
  }) as OllamaToolCall[];
}

async function executeToolCall(
  toolbox: LocalLlmToolbox,
  context: ContextBundle,
  toolCall: OllamaToolCall,
): Promise<{
  payload: Record<string, unknown>;
  trace: ToolTraceRecord;
}> {
  const toolName = normalizeModelText(toolCall.function?.name) ?? "unknown_tool";
  const args = normalizeToolArguments(toolCall.function?.arguments);
  let payload: Record<string, unknown>;

  switch (toolName) {
    case "list_indexed_repos":
      payload = await toolbox.listIndexedRepos();
      break;
    case "search_history":
      payload = await toolbox.searchHistory({
        query: readRequiredString(args.query, "query"),
        limit: clampInteger(args.limit, 1, MAX_TOOL_RESULTS, DEFAULT_RETRIEVAL_RESULT_LIMIT),
        guildId: context.guildContext.guildId,
        channelId: readOptionalString(args.channelId),
        authorId: readOptionalString(args.authorId),
      });
      break;
    case "get_message_context":
      payload = await toolbox.getMessageContext({
        messageId: readRequiredString(args.messageId, "messageId"),
        before: clampInteger(args.before, 0, MAX_CONTEXT_WINDOW, 4),
        after: clampInteger(args.after, 0, MAX_CONTEXT_WINDOW, 4),
      });
      break;
    case "search_sources":
      payload = await toolbox.searchSources({
        query: readRequiredString(args.query, "query"),
        limit: clampInteger(args.limit, 1, MAX_TOOL_RESULTS, DEFAULT_RETRIEVAL_RESULT_LIMIT),
        repoName: readOptionalString(args.repoName),
        pathPrefix: readOptionalString(args.pathPrefix),
        language: readOptionalString(args.language),
      });
      break;
    case "get_source_context":
      payload = await toolbox.getSourceContext({
        sourceId: readRequiredString(args.sourceId, "sourceId"),
        chunkIndex: clampInteger(args.chunkIndex, 0, 10_000, 0),
        before: clampInteger(args.before, 0, MAX_CONTEXT_WINDOW, 1),
        after: clampInteger(args.after, 0, MAX_CONTEXT_WINDOW, 1),
      });
      break;
    default:
      payload = {
        error: `Unsupported tool: ${toolName}`,
      };
      break;
  }

  return {
    payload,
    trace: {
      tool: toolName,
      arguments: args,
      result: payload,
    },
  };
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readRequiredString(value: unknown, key: string): string {
  const normalized = readOptionalString(value);

  if (!normalized) {
    throw new Error(`Tool argument "${key}" is required.`);
  }

  return normalized;
}

function clampInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return Math.max(minimum, Math.min(maximum, normalized));
}
