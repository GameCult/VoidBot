import type {
  ContextBundle,
  ProviderArtifact,
  ProviderRequest,
} from "@voidbot/shared";

import { MAX_RETRIEVAL_RESULT_LIMIT } from "@voidbot/shared";
import { loadPromptTemplate } from "@voidbot/shared";

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
            `- [${message.timestamp}] ${message.authorName}: ${message.content}${renderAttachmentSuffix(message)}`,
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
  const isRepoFaceParentInterpreter = context.prompt.includes("prompt:repo-face-turn-interpreter");
  const isRepoFaceTurn = !isRepoFaceParentInterpreter && (
    context.prompt.includes("prompt:character-turn")
      || context.prompt.includes("prompt:repo-face-turn")
      || context.prompt.includes("Repo Face identity doctrine:")
      || context.prompt.includes("Epiphany Face identity doctrine:")
  );
  const repoFaceInstruction = isRepoFaceTurn
    ? "- This turn belongs to the character described in the prompt. Keep the useful discipline and humor permissions from the base style, but speak, reason, remember, object, and choose as that person first. Stay read-only: propose repo changes and ask for consensus, but do not edit files directly."
    : undefined;
  const sleepProjection = context.voidSelfState?.projection;
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

  if (isRepoFaceTurn || isRepoFaceParentInterpreter) {
    return context.prompt;
  }

  return loadPromptTemplate("owner-discord-reply.prompt.md", {
    repoFaceTurn: isRepoFaceTurn,
    repoFaceInstruction,
    napping: sleepProjection?.mode === "napping",
    sourceGroundingInstructions,
    maxRetrievalResultLimit: MAX_RETRIEVAL_RESULT_LIMIT,
    handoffSentinel: HANDOFF_SENTINEL,
    ownerNotifySentinel: OWNER_NOTIFY_SENTINEL,
    maxNotificationMessageLength: MAX_NOTIFICATION_MESSAGE_LENGTH,
    stylePackInstructions,
    prompt: context.prompt,
    recentMessages,
    retrieval,
    interactionMemory: renderInteractionMemory(context),
    voidSelfState: renderVoidSelfState(context),
    sleepProjection: renderSleepProjection(context),
    situationalSocialRead: renderSituationalSocialRead(context),
    toolLoopNotes: toolLoopNotes.join("\n"),
  });
}

export function renderMarkdownBundle(context: ContextBundle): string {
  const recentMessages = context.recentMessages.length
    ? context.recentMessages
        .map(
          (message) =>
            `- [${message.timestamp}] ${message.authorName} (${message.authorId}): ${message.content}${renderAttachmentSuffix(message)}`,
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
    "## Private Persistent Self-State",
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

function renderAttachmentSuffix(message: ContextBundle["recentMessages"][number]): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }
  return ` [media: ${attachments.map((attachment) => {
    const kind = attachment.kind === "image" ? "image" : "attachment";
    const name = attachment.filename ?? attachment.id ?? "unnamed";
    const dimensions = attachment.width && attachment.height ? ` ${attachment.width}x${attachment.height}` : "";
    const local = attachment.localPath ? ` local=${attachment.localPath}` : "";
    return `${kind} ${name}${dimensions}${local}`;
  }).join("; ")}]`;
}

function renderVoidSelfState(context: ContextBundle): string {
  if (!context.voidSelfState) {
    return "- No private persistent self-state was attached.";
  }

  return context.voidSelfState.summary;
}

function renderSleepProjection(context: ContextBundle): string {
  const projection = context.voidSelfState?.projection;

  if (!projection) {
    return "- No explicit runtime projection was attached.";
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

  return loadPromptTemplate("source-grounding-reminder.prompt.md", {
    prefix: "- ",
    matchedRepos,
    reasons,
    retry,
  });
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
