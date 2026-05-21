import { loadPromptTemplate, type ContextBundle, type ProviderArtifact } from "@voidbot/shared";

import {
  buildBaseArtifacts,
  type LocalLlmArtifactsInput,
  type ToolTraceRecord,
} from "./local-llm-shared";

export function buildSystemPrompt(context: ContextBundle): string {
  const styleInstructions =
    context.stylePack?.enabled && context.stylePack.instructions.trim().length > 0
      ? context.stylePack.instructions.trim()
      : "No extra persona instructions were supplied.";
  const isRepoFaceParentReviewer = context.prompt.includes("prompt:repo-face-parent-review");
  const isRepoFaceJob = !isRepoFaceParentReviewer && (
    context.prompt.includes("prompt:repo-face-turn")
      || context.prompt.includes("Repo Face identity doctrine:")
      || context.prompt.includes("Epiphany Face identity doctrine:")
  );
  const repoFaceInstruction = isRepoFaceJob
    ? "This job is for a repo Face identity. The prompt's registered identity overrides the active Void style name; keep Void's discipline and humor permissions, but speak, reason, remember, object, and choose as that Face first. Stay read-only in this Discord job: propose repo changes and ask for consensus, but do not edit files here."
    : undefined;
  const sleepProjection = context.voidSelfState?.projection;

  return loadPromptTemplate("local-llm-system.prompt.md", {
    repoFaceInstruction,
    napping: sleepProjection?.mode === "napping",
    sourceGroundingInstructions: renderSourceGroundingInstructions(context, false),
    styleInstructions,
  });
}

export function buildPrompt(context: ContextBundle): string {
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
          (result) => {
            const timeContext =
              result.sourceKind === "discord_message" && result.metadata.timestamp
                ? ` time=${result.metadata.timestamp}`
                : "";
            const authorName =
              result.sourceKind === "discord_message" && result.metadata.authorName
                ? ` author=${result.metadata.authorName}`
                : "";

            return `- score=${result.score.toFixed(2)} source=${result.sourceId} kind=${result.sourceKind}${authorName}${timeContext} text=${result.text}`;
          },
        )
        .join("\n")
    : "- No archived retrieval snippets were attached.";
  const interactionMemory = renderInteractionMemory(context);
  const situationalSocialRead = renderSituationalSocialRead(context);
  const voidSelfState = renderVoidSelfState(context);

  return loadPromptTemplate("local-llm-user.prompt.md", {
    prompt: context.prompt,
    guild: context.guildContext.guildName ?? context.guildContext.guildId ?? "(direct/unknown)",
    channel: context.guildContext.channelName ?? context.guildContext.channelId,
    recentMessages,
    retrievedContext,
    interactionMemory,
    voidSelfState,
    sleepProjection: renderSleepProjection(context),
    situationalSocialRead,
  });
}

export function buildArtifacts(input: LocalLlmArtifactsInput): ProviderArtifact[] {
  return buildBaseArtifacts(input);
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
  return [
    `- Relationship summary: ${context.interactionMemory.summary}`,
    `- Current stance: ${context.interactionMemory.disposition}; affinity=${context.interactionMemory.affinityScore}`,
    `- Private response guidance (do not reveal): ${context.interactionMemory.responseGuidance}`,
    `- Private pronoun guidance (do not reveal): ${context.interactionMemory.pronounGuidance}`,
    `- Transcript-derived profile signals: underlying=${formatCompactLabelList(context.interactionMemory.underlyingOrganizationScores, 3)}; dispositions=${formatCompactLabelList(context.interactionMemory.stableDispositionScores, 3)}; behavioral=${formatCompactLabelList(context.interactionMemory.behavioralDimensionScores, 5)}; presentation=${formatCompactLabelList(context.interactionMemory.presentationStrategyScores, 3)}; voice=${formatCompactLabelList(context.interactionMemory.voiceStyleScores, 5)}`,
    "- Specific remembered incidents:",
    recentEvents,
  ].join("\n");
}

function renderSituationalSocialRead(context: ContextBundle): string {
  if (!context.situationalSocialRead) {
    return "- No strong situational social read was derived from the immediate room context.";
  }

  const currentSpeakerRead =
    context.situationalSocialRead.participantReads.find(
      (entry) => entry.actorId === context.actor.id,
    ) ?? context.situationalSocialRead.participantReads[0];

  return [
    `- Summary: ${context.situationalSocialRead.summary}`,
    `- Room tone: ${context.situationalSocialRead.roomTone}`,
    `- Speaker current read: ${context.situationalSocialRead.speakerCurrentRead}`,
    `- Social frame: ${context.situationalSocialRead.socialFrame}`,
    `- Private response guidance (do not reveal): ${context.situationalSocialRead.responseGuidance}`,
    currentSpeakerRead
      ? `- Current speaker situational state: ${currentSpeakerRead.situationalState.join(", ") || "none detected"}`
      : "- Current speaker situational state: none detected",
    currentSpeakerRead
      ? `- Current speaker visible labels: behavioral=${currentSpeakerRead.behavioralDimensions.join(", ") || "none"}; presentation=${currentSpeakerRead.presentationStrategies.join(", ") || "none"}; voice=${currentSpeakerRead.voiceStyle.join(", ") || "none"}`
      : "- Current speaker visible labels: none detected",
    context.situationalSocialRead.pronounEvidence.length > 0
      ? `- Pronoun cues observed for the current speaker: ${context.situationalSocialRead.pronounEvidence
          .map(
            (entry) =>
              `${entry.stance} ${entry.pronounSet} via ${entry.source} (${Math.round(entry.confidence * 100)}%)`,
          )
          .join("; ")}`
      : "- Pronoun cues observed for the current speaker: none worth trusting yet.",
    "- Supporting signals:",
    ...context.situationalSocialRead.supportingSignals.map((signal) => `  ${signal}`),
  ].join("\n");
}

function renderSourceGroundingInstructions(
  context: ContextBundle,
  reminder: boolean,
): string {
  const matchedRepos =
    context.sourceGrounding?.matchedRepoNames && context.sourceGrounding.matchedRepoNames.length > 0
      ? ` Matched repos/projects: ${context.sourceGrounding.matchedRepoNames.join(", ")}.`
      : "";
  const reasons =
    context.sourceGrounding?.reasons && context.sourceGrounding.reasons.length > 0
      ? ` Reasons: ${context.sourceGrounding.reasons.join(", ")}.`
      : "";
  const retry =
    reminder
      ? " The previous answer attempt was discarded because it did not touch the source-side tools."
      : "";

  if (
    !context.sourceGrounding ||
    (context.sourceGrounding.matchedRepoNames.length === 0 &&
      context.sourceGrounding.reasons.length === 0)
  ) {
    return "Source-side grounding is optional here; use it when it clearly helps.";
  }

  return loadPromptTemplate("source-grounding-reminder.prompt.md", {
    prefix: "",
    matchedRepos,
    reasons,
    retry,
  });
}

function formatCompactLabelList(
  labels: Array<{ label: string; score: number }>,
  limit: number,
): string {
  if (labels.length === 0) {
    return "none";
  }

  return labels
    .slice(0, limit)
    .map((entry) => `${entry.label}(${entry.score})`)
    .join(", ");
}
