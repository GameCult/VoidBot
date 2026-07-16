import type { RepoDiscordIdentity, VoidSelfStateTypedProjection } from "@voidbot/core";
import type { SourceMessage } from "@voidbot/shared";
import type { ChannelSnapshot } from "./turn-context-source.js";
import { collapsePersonaText, significantPersonaTopicTerms } from "./persona-curiosity-terms.js";

export interface PersonaCuriositySearchResult {
  chunkId: string;
  sourceId: string;
  sourceKind: "discord_message" | "source_document" | "persona_memory";
  text: string;
  score: number;
  metadata: Record<string, string>;
}

export interface PersonaCuriosityRetrievalPort {
  searchHistory(query: string, limit: number): Promise<PersonaCuriositySearchResult[]>;
  searchSources(query: string, limit: number, repoName?: string): Promise<PersonaCuriositySearchResult[]>;
}

export interface PersonaCuriosityNode extends PersonaCuriositySearchResult {
  id: string;
  terms: string[];
  seedLabels: string[];
}

export type PersonaCuriosityEvidenceObservation =
  | { status: "ok"; nodes: PersonaCuriosityNode[]; seedCount: number }
  | { status: "empty"; reason: string }
  | { status: "unavailable"; reason: string };

export async function readPersonaCuriosityEvidence(input: {
  identity: RepoDiscordIdentity;
  state: VoidSelfStateTypedProjection;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  sourceRepoName?: string;
  retrieval: PersonaCuriosityRetrievalPort | (() => PersonaCuriosityRetrievalPort);
}): Promise<PersonaCuriosityEvidenceObservation> {
  const seeds = buildPersonaCuriositySeedQueries(input);
  if (seeds.length === 0) return { status: "empty", reason: "No supplied context produced a viable semantic seed." };
  try {
    const retrieval = typeof input.retrieval === "function" ? input.retrieval() : input.retrieval;
    const nodesById = new Map<string, PersonaCuriosityNode>();
    for (const seed of seeds) {
      const [history, sources, homeSources] = await Promise.all([
        retrieval.searchHistory(seed.query, 8),
        retrieval.searchSources(seed.query, 8),
        input.sourceRepoName ? retrieval.searchSources(seed.query, 6, input.sourceRepoName) : Promise.resolve([]),
      ]);
      for (const result of [...history, ...sources, ...homeSources]) {
        const id = `${result.sourceKind}:${result.chunkId}`;
        const terms = significantPersonaTopicTerms(result.text);
        if (terms.length < 3) continue;
        const existing = nodesById.get(id);
        if (existing) {
          existing.score = Math.max(existing.score, result.score);
          existing.seedLabels = [...new Set([...existing.seedLabels, seed.label])];
        } else {
          nodesById.set(id, { ...result, id, terms, seedLabels: [seed.label] });
        }
      }
    }
    const nodes = [...nodesById.values()].sort((left, right) => right.score - left.score).slice(0, 32);
    return nodes.length < 3
      ? { status: "empty", reason: "Semantic retrieval returned fewer than three usable evidence nodes." }
      : { status: "ok", nodes, seedCount: seeds.length };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function buildPersonaCuriositySeedQueries(input: {
  identity: RepoDiscordIdentity;
  state: VoidSelfStateTypedProjection;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
}): Array<{ label: string; query: string }> {
  const room = input.recentMessages.filter(hasContent).slice(-8).map((message) => `${message.authorName}: ${collapsePersonaText(message.content, 500)}`).join("\n");
  const nearby = input.channelSnapshots.flatMap((snapshot) => snapshot.messages).filter(hasContent).slice(-8).map((message) => `${message.authorName}: ${collapsePersonaText(message.content, 320)}`).join("\n");
  const state = input.state;
  const privateState = [
    ...state.selfProfile.privateNotes.slice(-8),
    ...[...state.selfProfile.values].sort((left, right) => right.priority - left.priority).slice(0, 8).map((value) => `${value.label}: ${value.summary}`),
    ...state.thoughtMemory.memories.filter((memory) => !memory.retiredAt).slice(-8).map(memorySeed),
    ...state.thoughtMemory.shortTerm.filter((memory) => !memory.retiredAt).slice(-8).map(memorySeed),
    ...state.thoughtMemory.incubation.filter((thread) => thread.status !== "retired").sort((left, right) => right.maturation - left.maturation).slice(0, 8).map((thread) => `${thread.topic}: ${thread.summary}`),
  ].join("\n");
  const identity = [input.identity.displayName, input.identity.repoName, input.identity.description ?? "", ...input.identity.channelPermissions.flatMap((permission) => [permission.label ?? "", permission.topic ?? "", permission.posture ?? ""])].join("\n");
  return [{ label: "current room", query: room }, { label: "nearby rooms", query: nearby }, { label: "private state", query: privateState }, { label: "home territory", query: identity }]
    .map((seed) => ({ ...seed, query: collapsePersonaText(seed.query, 2800) }))
    .filter((seed) => significantPersonaTopicTerms(seed.query).length >= 3)
    .slice(0, 4);
}

function hasContent(message: SourceMessage): boolean { return collapsePersonaText(message.content).length > 0; }
function memorySeed(memory: VoidSelfStateTypedProjection["thoughtMemory"]["memories"][number]): string { return `${memory.kind} ${targetLabel(memory.target)} ${memory.summary} ${memory.claim ?? memory.question ?? ""}`; }
function targetLabel(target: { label?: string; id?: string; kind?: string } | undefined): string { return target?.label ?? target?.id ?? target?.kind ?? "an unnamed target"; }
