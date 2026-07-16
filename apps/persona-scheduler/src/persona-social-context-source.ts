import type { InteractionMemoryProfile, SourceMessage } from "@voidbot/shared";
import type { ChannelSnapshot } from "./turn-context-source.js";
import type { PersonaHumanPronounGuidance } from "./persona-social-context-projector.js";

export interface PersonaInteractionProfileReader {
  getProfile(actorId: string): Promise<InteractionMemoryProfile | undefined>;
  close(): Promise<void>;
}

export async function readPersonaHumanPronounGuidance(input: {
  ownerActorId: string;
  ownerFallbackName: string;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  openProfiles: () => Promise<PersonaInteractionProfileReader>;
}): Promise<PersonaHumanPronounGuidance[]> {
  const visibleHumans = new Map<string, string>();
  for (const message of [...input.recentMessages, ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages)]) {
    if (!message.isBot && message.authorId) visibleHumans.set(message.authorId, message.authorName || message.authorId);
  }
  visibleHumans.set(input.ownerActorId, visibleHumans.get(input.ownerActorId) ?? input.ownerFallbackName);
  const profiles = await input.openProfiles();
  try {
    const observations = await Promise.all([...visibleHumans].map(async ([actorId, fallbackName]) => ({
      actorId,
      fallbackName,
      profile: await profiles.getProfile(actorId),
    })));
    return observations.map(({ actorId, fallbackName, profile }) => profile ? projectPronounGuidance(actorId, fallbackName, profile) : undefined)
      .filter((entry): entry is PersonaHumanPronounGuidance => entry !== undefined);
  } finally {
    await profiles.close();
  }
}

export function projectPronounGuidance(actorId: string, fallbackName: string, profile: InteractionMemoryProfile): PersonaHumanPronounGuidance | undefined {
  if (profile.pronounPolicy === "unknown" || profile.resolvedPronounSets.length === 0) return undefined;
  const evidence = [...profile.pronounEvidence]
    .filter((entry) => entry.stance === "prefer" || entry.stance === "avoid")
    .sort((left, right) => pronounEvidenceRank(profile, right) - pronounEvidenceRank(profile, left))[0];
  return {
    actorId,
    actorName: profile.actorName || fallbackName,
    guidance: profile.pronounGuidance,
    resolvedPronounSet: profile.resolvedPronounSet,
    policy: profile.pronounPolicy,
    confidence: profile.pronounConfidence,
    evidenceExcerpt: evidence?.excerpt,
  };
}

function pronounEvidenceRank(profile: InteractionMemoryProfile, entry: InteractionMemoryProfile["pronounEvidence"][number]): number {
  const sourceRank: Record<string, number> = { explicit_self_statement: 10_000, explicit_correction: 9_000, direct_third_party_statement: 7_000, contextual_relational_inference: 3_000, ambient_usage: 1_000 };
  const resolvedSetBonus = profile.resolvedPronounSets.includes(entry.pronounSet) ? 50_000 : 0;
  const stanceBonus = entry.stance === "prefer" ? 1_000 : 0;
  const confidenceBonus = Math.round(entry.confidence * 100);
  const timestampMs = Date.parse(entry.timestamp);
  const recencyBonus = Number.isFinite(timestampMs) ? timestampMs / 10_000_000_000 : 0;
  return resolvedSetBonus + (sourceRank[entry.source] ?? 0) + stanceBonus + confidenceBonus + recencyBonus;
}
