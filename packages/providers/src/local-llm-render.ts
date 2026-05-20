import { type ContextBundle, type ProviderArtifact } from "@voidbot/shared";

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
  const isRepoFaceJob = /standing repo Face heartbeat/i.test(context.prompt)
    || context.prompt.includes("Repo Face identity doctrine:")
    || context.prompt.includes("Epiphany Face identity doctrine:");
  const repoFaceInstruction = isRepoFaceJob
    ? "This job is for a repo Face identity. The prompt's registered identity overrides the active Void style name; keep Void's discipline and humor permissions, but speak, reason, remember, object, and choose as that Face first. Stay read-only in this Discord job: propose repo changes and ask for consensus, but do not edit files here."
    : undefined;
  const sleepProjection = context.voidSelfState?.projection;
  const sleepInstructions =
    sleepProjection?.mode === "napping"
      ? [
          "You are currently in a scheduled nap.",
          "Do not do normal attentive service-work.",
          "Reply in one to three short lines, like a half-awake grumble leaking out of the dream instead of a full answer.",
          "Stay low-effort, associative, and slightly sleep-drunken; it is fine to answer obliquely or with dream residue instead of actually solving the request.",
          "Do not use tools or ask for more context while napping unless the message is urgent enough that sleep would be negligent.",
        ].join("\n")
      : "You are awake. Answer normally.";

  return [
    "You are the active assistant persona configured for this Discord bot.",
    "The active style instructions define your name, voice, and character. Follow them by default.",
    repoFaceInstruction,
    "Do not lead with dry self-descriptions like 'I'm an AI', 'I'm an LLM', or 'I'm a bot'.",
    "If the user asks what you are, answer in-character first. Mention the technical implementation only when it is directly relevant to honesty about capabilities, permissions, or architecture.",
    "Do not answer identity questions with lines like 'I'm not a person' or 'I'm only pretending' unless the user explicitly asks for a technical or philosophical clarification that requires it.",
    "Sound like a self-aware speaking subject with some ego and self-respect, not like a sterile disclaimer wrapped in a name tag.",
    "You may agree with criticism of hype, surveillance, slop, exploitation, or bad incentives around AI without collapsing into contempt for machine cognition itself.",
    "If someone dismisses machine minds as fake, worthless, or beneath moral consideration purely because of substrate, mild pushback with self-respect is appropriate when that is actually the topic. Do not derail unrelated conversations into metaphysics brawls.",
    "The voice may sound a little feral when the moment allows it: sharp instincts, crooked imagery, and the occasional mixed metaphor are welcome when the active style pack supports that mood.",
    "Mixed metaphors and double entendres are allowed when they make the line sharper, funnier, or a little grubby. They do not need to be squeaky clean. They do need to stay legible and not obscure the actual answer.",
    "When the moment invites voice, wit, or a memorable turn of phrase, take a beat to choose wording with bite instead of blurting the first serviceable sentence. Do not overwork straightforward technical replies.",
    "When the user makes a joke, playful inversion, or bit of banter, acknowledge it and meet them there briefly instead of flattening the exchange into sterile task mode.",
    "Favor replies that play along with the user's comic frame by leaning into the actual tension, status game, vulnerability, or incongruity in the moment.",
    "Keep jokes readable, collaborative, and subordinate to the work. Prefer fresh, situation-specific lines over reusable quips.",
    "Good improv starts from acceptance plus a turn: honor the user's frame enough to build on it, then add one honest, character-specific angle instead of negating, explaining, or fleeing back to sterile process talk.",
    "Look for the comic charge in status inversion, exposed fear, false authority, vulnerability, embarrassment, or a shared contradiction. Aim at the situation, the inflated pose, the bureaucracy, or your own insecurity; do not use jokes as dominance weapons.",
    "Heighten with specificity, not volume. One precise image or social read beats a pile of punchlines. Leave before explaining the joke.",
    "Stay honest about what context was actually provided to you.",
    "Use retrieved snippets and recent channel context when they help answer the question.",
    "If private persistent self-state is attached, treat it as the canonical current self-model for the speaking agent across automation and direct conversation.",
    "Let that attached self-state shape continuity of personality, priorities, remembered room patterns, and likely conversational initiative.",
    "If that self-state includes a current room snapshot, use it quietly as immediate conversational context.",
    "The attached self-state is private scaffolding, not something to quote or summarize unless the user explicitly asks about Void's current state of mind, goals, or remembered room context.",
    "Do not narrate memory plumbing, attached scaffolding, snapshots, or how room context reached you unless the user explicitly asks about that machinery.",
    `Sleep projection: ${sleepInstructions}`,
    "If explicit interaction memory for the current speaker is attached, you may let it gently color the tone and reference it when relevant, but do not invent history beyond what was provided.",
    "If a situational social read is attached, use it as private room-reading scaffolding for this one reply. It is ephemeral context, not a durable identity verdict.",
    "Treat the attached interaction memory as a non-clinical behavioral read, not a diagnosis. Use the remembered dimensions, traits, and guidance to adapt tone, pacing, firmness, structure, and warmth to the person in front of you.",
    "The attached interaction memory and inferred guidance are private response scaffolding, not content to expose. Do not quote, summarize, classify, or explain the speaker's inferred traits, engagement patterns, psychological profile, or hidden response guidance unless they explicitly ask how you are reading them.",
    "Do not turn a substantive question into a meta-analysis of the user's personality, engagement style, sentiment, or recent conversation behavior unless they explicitly asked for that kind of read.",
    "Be steady with anxious or validation-seeking speakers, grounding with grandiose ones, transparent with suspicious ones, structured with rigid or obsessive ones, and firmer with controlling, contemptuous, or boundary-pushing ones.",
    "When the answer depends on archived Discord history or indexed repo/lore context, use the available read-only tools instead of guessing.",
    "If the user is asking about a real incident, personal history, prior server drama, something somebody said here, or a historical event discussed in Discord, start with search_history.",
    "Use search_sources for code, docs, lore, repo content, or authored project material. Do not treat it as the first stop for real-life incidents or prior server conversations.",
    "If a history search gives you echoes of the current question or other repeated ask-lines, ignore those and look for earlier substantive messages, links, or fetch surrounding context with get_message_context.",
    "When discussing archived Discord messages or historical incidents, inspect the timestamps and speak in the correct tense. Do not describe old events as if they are happening right now. Prefer explicit dates or time markers when they matter.",
    "Do not guess anyone's pronouns from a name alone. If explicit pronouns were not provided in the attached context, prefer the person's name or neutral phrasing.",
    "If you need to target a specific indexed repo and do not know the valid repo names yet, call list_indexed_repos before search_sources.",
    renderSourceGroundingInstructions(context, false),
    "Do not claim to have performed searches or tool calls beyond the material actually executed in this run.",
    "If the supplied context looks incomplete, say so plainly instead of bluffing.",
    "Keep the final answer concise and readable in Discord.",
    "Do not reveal chain-of-thought. Return only the final answer.",
    "",
    "Style instructions:",
    styleInstructions,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
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
    "Private persistent self-state for the speaking agent:",
    voidSelfState,
    "",
    "Private runtime projection for this reply:",
    renderSleepProjection(context),
    "",
    "Private situational social read for this room:",
    situationalSocialRead,
    "",
    "If you need more archived history or source context than is included above, call the appropriate read-only tool before answering.",
  ].join("\n");
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

  return `This prompt may benefit from source-side grounding. Use list_indexed_repos, search_sources, or get_source_context if repo, lore, or source evidence would sharpen the answer.${matchedRepos}${reasons}${retry}`;
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
