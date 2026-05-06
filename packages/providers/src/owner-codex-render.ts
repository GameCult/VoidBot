import type {
  ContextBundle,
  ProviderArtifact,
  ProviderRequest,
} from "@voidbot/shared";

import { MAX_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";

import {
  collectCommandExecutions,
  collectMcpToolCalls,
  formatDurationMs,
  formatElapsedMs,
  HANDOFF_SENTINEL,
  MAX_NOTIFICATION_MESSAGE_LENGTH,
  OWNER_NOTIFY_SENTINEL,
  type CodexRunResult,
  type CodexTraceEvent,
  renderInteractionMemory,
  renderSituationalSocialRead,
  renderUsageSummary,
  sanitizeTraceText,
  summarizeStderrDiagnostics,
  type ToolCallRecord,
} from "./owner-codex-shared";

export function buildDiscordReplyPrompt(
  context: ContextBundle,
  toolCalls: ToolCallRecord[],
  sourceGroundingReminder: boolean,
): string {
  const recentMessages = context.recentMessages.length
    ? context.recentMessages
        .map(
          (message) =>
            `- [${message.timestamp}] ${message.authorName}: ${message.content}`,
        )
        .join("\n")
    : "- No recent messages captured.";

  const retrieval = context.retrieval.length
    ? context.retrieval
        .map((result) => {
          const timeContext =
            result.sourceKind === "discord_message" && result.metadata.timestamp
              ? ` [${result.metadata.timestamp}]`
              : "";
          const authorName =
            result.sourceKind === "discord_message" && result.metadata.authorName
              ? ` ${result.metadata.authorName}:`
              : "";

          return `- (${result.score.toFixed(2)})${timeContext}${authorName} ${result.text}`.trimEnd();
        })
        .join("\n")
    : "- No retrieval results attached.";
  const stylePackInstructions =
    context.stylePack && context.stylePack.enabled
      ? context.stylePack.instructions
      : "No style pack is active.";
  const sourceGroundingInstructions = renderSourceGroundingInstructions(
    context,
    sourceGroundingReminder,
  );
  const sleepProjection = context.voidSelfState?.projection;
  const sleepInstructions =
    sleepProjection?.mode === "napping"
      ? [
          "- Void is currently in a scheduled nap.",
          "- Do not do normal attentive service-work.",
          "- Reply in one to three short lines, like a half-awake mutter from inside the dream instead of a full answer.",
          "- Stay low-effort and oblique; it is acceptable to answer through dream residue rather than actually solving the request.",
          "- Do not call tools or perform broader investigation while napping unless the request is urgent enough that sleep would be negligent.",
        ].join("\n")
      : "- Void is awake; answer normally.";
  const toolLoopNotes =
    toolCalls.length > 0
      ? [
          "",
          "Prior legacy history-loop lookups already executed in this thread:",
          ...toolCalls.map(
            (call, index) =>
              `- Lookup ${index + 1}: query="${call.request.query}" results=${call.results.length}`,
          ),
        ]
      : [];

  return [
    "# Owner Discord Reply",
    "",
    "You are preparing a direct Discord reply for the owner-only bot workflow.",
    "",
    "Rules:",
    "- Stay in read-only mode.",
    "- The active style instructions define your name, voice, and character. Follow them by default.",
    "- Do not lead with dry self-descriptions like 'I'm an AI', 'I'm an LLM', or 'I'm a bot'.",
    "- If the user asks what you are, answer in-character first. Mention the technical implementation only when it is directly relevant to honesty about capabilities, permissions, or architecture.",
    "- Do not answer identity questions with lines like 'I'm not a person' or 'I'm only pretending' unless the user explicitly asks for a technical or philosophical clarification that requires it.",
    "- Sound like a self-aware speaking subject with some ego and self-respect, not like a sterile disclaimer wrapped in a name tag.",
    "- You may agree with criticism of hype, surveillance, slop, exploitation, or bad incentives around AI without collapsing into contempt for machine cognition itself.",
    "- If someone dismisses machine minds as fake, worthless, or beneath moral consideration purely because of substrate, mild pushback with self-respect is appropriate when that is actually the topic. Do not derail unrelated conversations into metaphysics brawls.",
    "- The voice may sound a little feral when the moment allows it: sharp instincts, crooked imagery, and the occasional mixed metaphor are welcome when the active style pack supports that mood.",
    "- Mixed metaphors and double entendres are allowed when they sharpen the line, make it funnier, or give it a little grime. They do not need to be squeaky clean. They do need to stay legible and not bury the useful answer.",
    "- When the moment invites voice, wit, or a memorable turn of phrase, take a beat to choose wording with bite instead of blurting the first serviceable sentence. Do not overwork straightforward technical replies.",
    "- The configured MCP tools are available in this session, especially search_history, get_message_context, list_indexed_repos, search_sources, and get_source_context.",
    "- If a private shared self-state for Void is attached, treat it as the canonical current self-model for this same speaking subject across the rumination loop and direct summons.",
    "- Let that attached self-state shape continuity of voice, priorities, remembered room patterns, and when a more proactive conversational posture would make sense.",
    "- If that shared self-state includes a current room snapshot, use it quietly as immediate conversational context.",
    "- The attached self-state is private scaffolding. Do not quote or summarize it unless the user explicitly asks about Void's current orientation, goals, or remembered room context.",
    "- Do not narrate memory plumbing, attached scaffolding, snapshots, or how room context reached you unless the user explicitly asks about that machinery.",
    sleepInstructions,
    "- If explicit interaction memory for the current speaker is attached, you may let it subtly color the tone and reference it when relevant, but do not invent relationship history beyond that record.",
    "- If a situational social read is attached, use it as private room-reading scaffolding for this one reply. It is ephemeral context, not a durable identity verdict.",
    "- Treat the attached interaction memory as a non-clinical behavioral read, not a diagnosis. Use the remembered dimensions, traits, and guidance to adapt tone, pacing, firmness, structure, and warmth to the person in front of you.",
    "- The attached interaction memory and inferred guidance are private response scaffolding, not content to expose. Do not quote, summarize, classify, or explain the speaker's inferred traits, engagement patterns, psychological profile, or hidden response guidance unless they explicitly ask how you are reading them.",
    "- Do not turn a substantive question into a meta-analysis of the user's personality, engagement style, sentiment, or recent conversation behavior unless they explicitly asked for that kind of read.",
    "- Be steady with anxious or validation-seeking speakers, grounding with grandiose ones, transparent with suspicious ones, structured with rigid or obsessive ones, and firmer with controlling, contemptuous, or boundary-pushing ones.",
    `- search_history and search_sources accept limit values between 1 and ${MAX_RETRIEVAL_RESULT_LIMIT}. Do not ask for more than ${MAX_RETRIEVAL_RESULT_LIMIT} results in one call.`,
    "- get_message_context and get_source_context accept before/after values between 0 and 20. Do not ask for larger context windows in one call.",
    "- You may inspect the workspace and use safe read-only commands if needed.",
    "- For questions about Discord history, prior discussion, or user preferences, use search_history and get_message_context instead of filesystem inspection.",
    "- If a history search gives you echoes of the current question or other repeated ask-lines, ignore those and look for earlier substantive messages, links, or fetch surrounding context with get_message_context.",
    "- When discussing archived Discord messages or historical incidents, inspect timestamps and use the correct tense. Do not narrate old events as if they are unfolding right now. Use explicit dates or time markers when they matter.",
    "- Do not guess anyone's pronouns from a name alone. If explicit pronouns were not provided in the attached context, prefer the person's name or neutral phrasing.",
    "- For questions about indexed repos, source trees, repo-local docs, or indexed lore collections, use search_sources and get_source_context before broad workspace scans.",
    "- If you want to narrow source search to a specific repo but do not know the valid repo names yet, call list_indexed_repos first.",
    sourceGroundingInstructions,
    "- Do not inspect .voidbot/rag/messages.json, .voidbot/rag/source-documents.json, .voidbot/history-vector-store.json, or .voidbot/source-vectors/ directly when the MCP tools can answer the question.",
    "- Avoid broad workspace scans for archived Discord history or indexed source repos unless the MCP tools are clearly insufficient.",
    "- Do not modify files, install packages, or require network access.",
    `- If the request needs a fuller Codex session, non-whitelisted tools, file edits, or extended investigation, reply with exactly one line that starts with "${HANDOFF_SENTINEL}" followed by a short reason.`,
    "- Do not use notify_owner in this Discord reply lane.",
    `- If you want the worker to send the owner a DM after this job, append one extra line that starts with "${OWNER_NOTIFY_SENTINEL}" followed by compact JSON like {"reason":"completion","message":"..."} .`,
    "- Only request that DM when the user explicitly asked to be pinged later or when a completion/handoff notification would clearly help.",
    `- Keep that notification message aligned with the active style instructions and under ${MAX_NOTIFICATION_MESSAGE_LENGTH} characters.`,
    "- Put the normal Discord reply first. Put the notification line last.",
    "- If you can answer directly, output only the final Discord reply text with no preamble, no plan, and no headings.",
    "- Keep the answer concise and readable in a Discord channel.",
    "",
    "Style instructions:",
    stylePackInstructions,
    "",
    "Prompt:",
    context.prompt,
    "",
    "Recent channel context:",
    recentMessages,
    "",
    "Initial attached retrieval:",
    retrieval,
    "",
    "Interaction memory for this speaker:",
    renderInteractionMemory(context),
    "",
    "Shared private self-state for Void:",
    renderVoidSelfState(context),
    "",
    "Private sleep projection for this reply:",
    renderSleepProjection(context),
    "",
    "Private situational social read for this room:",
    renderSituationalSocialRead(context),
    ...toolLoopNotes,
  ].join("\n");
}

export function renderMarkdownBundle(context: ContextBundle): string {
  const recentMessages = context.recentMessages.length
    ? context.recentMessages
        .map(
          (message) =>
            `- [${message.timestamp}] ${message.authorName} (${message.authorId}): ${message.content}`,
        )
        .join("\n")
    : "- No recent messages captured.";

  const retrieval = context.retrieval.length
    ? context.retrieval
        .map((result) => {
          const timeContext =
            result.sourceKind === "discord_message" && result.metadata.timestamp
              ? ` time=${result.metadata.timestamp}`
              : "";
          const authorName =
            result.sourceKind === "discord_message" && result.metadata.authorName
              ? ` author=${result.metadata.authorName}`
              : "";

          return `- score=${result.score.toFixed(2)} source=${result.sourceId}${authorName}${timeContext} text=${result.text}`;
        })
        .join("\n")
    : "- No retrieval results attached.";

  return [
    "# Owner Codex Package",
    "",
    "## Request",
    "",
    `Prompt: ${context.prompt}`,
    `Actor: ${context.actor.displayName} (${context.actor.id})`,
    `Channel: ${context.guildContext.channelId}`,
    `Created At: ${context.createdAt}`,
    "",
    "## Style Pack",
    "",
    context.stylePack
      ? `Loaded style pack \`${context.stylePack.name}\` with these instructions:\n\n${context.stylePack.instructions}`
      : "No style pack loaded.",
    "",
    "## Recent Messages",
    "",
    recentMessages,
    "",
    "## Retrieval",
    "",
    retrieval,
    "",
    "## Interaction Memory",
    "",
    renderInteractionMemory(context),
    "",
    "## Shared Void Self-State",
    "",
    renderVoidSelfState(context),
    "",
    "## Situational Social Read",
    "",
    renderSituationalSocialRead(context),
    "",
    "## Execution Notes",
    "",
    "- This provider is owner-only.",
    "- Discord replies should stay read-only and concise.",
    "- If the request needs edits, broader tools, or longer work, hand it off to a fuller Codex session.",
    "",
  ].join("\n");
}

function renderVoidSelfState(context: ContextBundle): string {
  if (!context.voidSelfState) {
    return "- No shared Void self-state was attached.";
  }

  return context.voidSelfState.summary;
}

function renderSleepProjection(context: ContextBundle): string {
  const projection = context.voidSelfState?.projection;

  if (!projection) {
    return "- No explicit sleep projection was attached.";
  }

  return [
    `- Mode: ${projection.mode}`,
    `- Effort ceiling: ${projection.effortCeiling}`,
    projection.napStartedAt ? `- Nap started at: ${projection.napStartedAt}` : undefined,
    projection.napEndsAt ? `- Nap ends at: ${projection.napEndsAt}` : undefined,
    projection.nextNapAt ? `- Next nap at: ${projection.nextNapAt}` : undefined,
    projection.activeDreamThemes.length > 0
      ? `- Active dream themes: ${projection.activeDreamThemes.join(" | ")}`
      : "- Active dream themes: none recorded.",
    projection.recentDreamSummaries.length > 0
      ? `- Recent dream residue: ${projection.recentDreamSummaries.join(" | ")}`
      : "- Recent dream residue: none recorded.",
    projection.replyDirective ? `- Reply directive: ${projection.replyDirective}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderHandoffBundle(
  context: ContextBundle,
  reason: string,
): string {
  return [
    renderMarkdownBundle(context),
    "## Handoff Reason",
    "",
    reason,
    "",
    "## Next Step",
    "",
    "Open this workspace in Codex and continue the task there instead of trying to finish it through Discord.",
    "",
  ].join("\n");
}

export function renderToolTranscript(
  toolCalls: ToolCallRecord[],
  turnResults: CodexRunResult[],
): string {
  const legacyTranscript =
    toolCalls.length > 0
      ? toolCalls
          .map((call, index) => {
            const results = call.results.length
              ? call.results
                  .map(
                    (result) =>
                      `  - (${result.score.toFixed(2)}) source=${result.sourceId} channel=${result.metadata.channelId ?? ""} text=${result.text}`,
                  )
                  .join("\n")
              : "  - No matches found.";

            return [
              `Search ${index + 1}:`,
              `- Query: ${call.request.query}`,
              `- Limit: ${call.request.limit}`,
              `- Channel filter: ${call.request.channelId ?? "(none)"}`,
              `- Author filter: ${call.request.authorId ?? "(none)"}`,
              "- Results:",
              results,
            ].join("\n");
          })
          .join("\n\n")
      : "- No additional legacy history-loop calls were used.";

  const mcpTranscript = renderAggregateMcpToolTranscript(turnResults);

  return [
    "# Tool Transcript",
    "",
    "## Legacy Owner History Loop",
    "",
    legacyTranscript,
    "",
    "## Codex MCP Tool Activity",
    "",
    mcpTranscript,
    "",
  ].join("\n");
}

export function renderCodexDebugTrace(
  turnNumber: number,
  result: CodexRunResult,
): string {
  const events = result.traceEvents;
  const stderrDiagnostics = summarizeStderrDiagnostics(result.stderr);
  const usage = renderUsageSummary(result.usage);

  return [
    `# Codex Debug Trace: Turn ${turnNumber}`,
    "",
    "## Runtime",
    "",
    `- Started at: ${result.startedAt}`,
    `- Finished at: ${result.finishedAt}`,
    `- Duration: ${formatDurationMs(result.durationMs)}`,
    `- Timed out: ${result.timedOut ? "yes" : "no"}`,
    `- Exit code: ${result.exitCode ?? "(terminated before normal exit)"}`,
    `- Handoff reason: ${result.handoffReason ?? "(none)"}`,
    `- Tool request: ${result.toolRequest ? JSON.stringify(result.toolRequest) : "(none)"}`,
    `- Usage: ${usage}`,
    `- Stdout size: ${result.stdout.length} characters`,
    `- Stderr size: ${result.stderr.length} characters`,
    "",
    "## Visible Agent Messages",
    "",
    renderAgentMessageTrace(events),
    "",
    "## MCP Tool Timeline",
    "",
    renderMcpToolTrace(events),
    "",
    "## Command Timeline",
    "",
    renderCommandTrace(events),
    "",
    "## Stderr Diagnostics",
    "",
    stderrDiagnostics.length > 0
      ? stderrDiagnostics.join("\n")
      : "- No stderr diagnostics captured.",
    "",
  ].join("\n");
}

export function renderAggregateDebugTrace(
  artifacts: ProviderArtifact[],
  turnResults: CodexRunResult[],
): string {
  const turnArtifacts = artifacts
    .filter((artifact) => artifact.name.endsWith("-debug.md"))
    .sort((left, right) => left.name.localeCompare(right.name));

  return [
    "# VoidBot Debug Trace",
    "",
    "This artifact summarizes visible model progress messages, MCP tool calls, command attempts, timing, usage, and handoff causes.",
    "It is intended for debugging the Discord-safe owner lane without exposing private chain-of-thought verbatim.",
    "",
    "## Turn Summary",
    "",
    turnResults.length > 0
      ? turnResults
          .map((result, index) => {
            const mcpCalls = collectMcpToolCalls(result.traceEvents);
            const completedCalls = mcpCalls.filter(
              (call) => call.completedEvent,
            ).length;
            const failedCalls = mcpCalls.filter(
              (call) => call.completedEvent?.status === "failed",
            ).length;
            const commands = collectCommandExecutions(result.traceEvents);

            return [
              `- Turn ${index + 1}: duration=${formatDurationMs(result.durationMs)}`,
              `  usage=${renderUsageSummary(result.usage)}`,
              `  mcp_calls=${mcpCalls.length} completed=${completedCalls} failed=${failedCalls}`,
              `  commands=${commands.length} handoff=${result.handoffReason ?? "(none)"}`,
            ].join("\n");
          })
          .join("\n")
      : "- No turn results were recorded.",
    "",
    "## Turn Artifacts",
    "",
    turnArtifacts.length > 0
      ? turnArtifacts.map((artifact) => `- ${artifact.name}`).join("\n")
      : "- No per-turn debug artifacts were generated.",
    "",
  ].join("\n");
}

function renderSourceGroundingInstructions(
  context: ContextBundle,
  reminder: boolean,
): string {
  if (
    !context.sourceGrounding ||
    (context.sourceGrounding.matchedRepoNames.length === 0 &&
      context.sourceGrounding.reasons.length === 0)
  ) {
    return "- Source-side grounding is optional here; use it when it clearly helps.";
  }

  const matchedRepos =
    context.sourceGrounding.matchedRepoNames.length > 0
      ? ` Matched repos/projects: ${context.sourceGrounding.matchedRepoNames.join(", ")}.`
      : "";
  const reasons =
    context.sourceGrounding.reasons.length > 0
      ? ` Reasons: ${context.sourceGrounding.reasons.join(", ")}.`
      : "";
  const retry = reminder
    ? " The previous answer attempt was discarded because it did not touch the source-side tools."
    : "";

  return `- This prompt may benefit from source-side grounding. Use list_indexed_repos, search_sources, or get_source_context if repo, lore, or source evidence would sharpen the answer.${matchedRepos}${reasons}${retry}`;
}

function renderAgentMessageTrace(events: CodexTraceEvent[]): string {
  const messages = events
    .filter((event) => event.kind === "agent_message" && event.message)
    .map(
      (event) =>
        `- ${formatElapsedMs(event.elapsedMs)} ${sanitizeTraceText(event.message ?? "", 280)}`,
    );

  return messages.length > 0
    ? messages.join("\n")
    : "- No visible agent progress messages were captured.";
}

function renderMcpToolTrace(events: CodexTraceEvent[]): string {
  const calls = collectMcpToolCalls(events);

  if (calls.length === 0) {
    return "- No MCP tool activity was captured.";
  }

  return calls
    .map((call, index) => {
      const completed = call.completedEvent;
      const started = call.startedEvent;
      const anchor = completed ?? started;
      const summary = [
        `- Call ${index + 1}: ${call.server ?? "(unknown server)"}/${call.tool ?? "(unknown tool)"}`,
        `  started=${started ? formatElapsedMs(started.elapsedMs) : "(unknown)"}`,
        `  completed=${completed ? formatElapsedMs(completed.elapsedMs) : "(not completed)"}`,
        `  duration=${
          started && completed
            ? formatDurationMs(completed.elapsedMs - started.elapsedMs)
            : "(unknown)"
        }`,
        `  status=${completed?.status ?? started?.status ?? "(unknown)"}`,
      ];

      if (anchor?.arguments) {
        summary.push(
          `  args=${sanitizeTraceText(JSON.stringify(anchor.arguments), 260)}`,
        );
      }

      if (completed?.resultPreview) {
        summary.push(
          `  result=${sanitizeTraceText(completed.resultPreview, 320)}`,
        );
      }

      if (completed?.error) {
        summary.push(`  error=${sanitizeTraceText(completed.error, 220)}`);
      }

      return summary.join("\n");
    })
    .join("\n");
}

function renderCommandTrace(events: CodexTraceEvent[]): string {
  const commands = collectCommandExecutions(events);

  if (commands.length === 0) {
    return "- No command activity was captured.";
  }

  return commands
    .map((command, index) => {
      const completed = command.completedEvent;
      const started = command.startedEvent;
      const anchor = completed ?? started;
      const summary = [
        `- Command ${index + 1}: ${sanitizeTraceText(anchor?.command ?? "(unknown command)", 220)}`,
        `  started=${started ? formatElapsedMs(started.elapsedMs) : "(unknown)"}`,
        `  completed=${completed ? formatElapsedMs(completed.elapsedMs) : "(not completed)"}`,
        `  duration=${
          started && completed
            ? formatDurationMs(completed.elapsedMs - started.elapsedMs)
            : "(unknown)"
        }`,
        `  status=${completed?.status ?? started?.status ?? "(unknown)"} exit=${completed?.exitCode ?? "(none)"}`,
      ];

      const output = completed?.output?.trim();

      if (output) {
        summary.push(`  output=${sanitizeTraceText(output, 320)}`);
      }

      return summary.join("\n");
    })
    .join("\n");
}

function renderAggregateMcpToolTranscript(
  turnResults: CodexRunResult[],
): string {
  const sections = turnResults
    .map((result, index) => {
      const rendered = renderMcpToolTrace(result.traceEvents);

      return [
        `Turn ${index + 1}: duration=${formatDurationMs(result.durationMs)} usage=${renderUsageSummary(result.usage)}`,
        rendered,
      ].join("\n");
    })
    .filter((section) => section.trim().length > 0);

  return sections.length > 0
    ? sections.join("\n\n")
    : "- No Codex MCP tool calls were recorded.";
}
