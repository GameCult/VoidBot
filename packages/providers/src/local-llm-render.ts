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
    "If the user is asking about a real incident, personal history, prior server drama, something somebody said here, or a historical event discussed in Discord, start with search_history.",
    "Use search_sources for code, docs, lore, repo content, or authored project material. Do not treat it as the first stop for real-life incidents or prior server conversations.",
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

export function buildArtifacts(input: LocalLlmArtifactsInput): ProviderArtifact[] {
  return buildBaseArtifacts(input);
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
