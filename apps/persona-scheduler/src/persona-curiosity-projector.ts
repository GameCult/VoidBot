import type { RepoDiscordIdentity, VoidSelfStateTypedProjection } from "@voidbot/core";
import type { SourceMessage } from "@voidbot/shared";
import type { ChannelSnapshot } from "./turn-context-source.js";
import type { PersonaCuriosityEvidenceObservation, PersonaCuriosityNode } from "./persona-curiosity-context-source.js";
import { collapsePersonaText, significantPersonaTopicTerms } from "./persona-curiosity-terms.js";

interface PersonaCuriosityCluster {
  label: string;
  nodes: PersonaCuriosityNode[];
  prominence: number;
  saturation: number;
  novelty: number;
  clusterDensity: number;
  jurisdictionFit: number;
  evidence: string[];
}

export function projectPersonaCuriosityContext(input: {
  identity: RepoDiscordIdentity;
  state: VoidSelfStateTypedProjection;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  observation: PersonaCuriosityEvidenceObservation;
  backendDescription: string;
}): string | undefined {
  if (input.observation.status === "empty") return undefined;
  if (input.observation.status === "unavailable") return [
    "Curiosity graph unavailable:",
    `- Semantic retrieval failed while decoding topic attractors: ${collapsePersonaText(input.observation.reason, 260)}`,
    "- Do not pretend a semantic curiosity map was available this turn. Fall back to the raw transcript, home-repo activity, and typed memory instead of inventing ranked attractors.",
  ].join("\n");
  const clusters = decodePersonaCuriosityGraph(input, input.observation.nodes);
  if (clusters.length === 0) return undefined;
  return [
    "Curiosity graph attractors:",
    `- Source: semantic retrieval from ${input.backendDescription}; local graph decoding over retrieved chunks. This is curiosity weather, not orders or consensus.`,
    ...clusters.map((cluster) => [
      `- ${cluster.label || "unnamed cluster"}: prominence ${formatSignal(cluster.prominence)}, saturation ${formatSignal(cluster.saturation)}, novelty ${formatSignal(cluster.novelty)}, cluster density ${formatSignal(cluster.clusterDensity)}, jurisdiction fit ${formatSignal(cluster.jurisdictionFit)}.`,
      `  Suggested motion: ${suggestMotion(input.identity, cluster)}`,
      `  Evidence: ${cluster.evidence.join("; ")}.`,
    ].join("\n")),
    "- The living use is intelligent curiosity: follow underexplored neighboring clusters, deepen home-territory clusters only with fresh anchors, and let saturated clusters create boredom, fatigue, or a deliberate closing move instead of another repetition.",
  ].join("\n");
}

export function decodePersonaCuriosityGraph(input: {
  identity: RepoDiscordIdentity;
  state: VoidSelfStateTypedProjection;
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
}, nodes: PersonaCuriosityNode[]): PersonaCuriosityCluster[] {
  const edgeWeights = new Map<string, number>();
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
    const left = nodes[leftIndex];
    const right = nodes[rightIndex];
    const weight = edgeWeight(left, right);
    if (weight < 0.16) continue;
    edgeWeights.set(edgeKey(left.id, right.id), weight);
    adjacency.get(left.id)?.add(right.id);
    adjacency.get(right.id)?.add(left.id);
  }
  const visited = new Set<string>();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const connected: PersonaCuriosityNode[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const cluster: PersonaCuriosityNode[] = [];
    visited.add(node.id);
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id) continue;
      const current = nodesById.get(id);
      if (current) cluster.push(current);
      for (const neighbor of adjacency.get(id) ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); stack.push(neighbor); }
    }
    connected.push(cluster);
  }
  const recentTerms = termCounts([...input.recentMessages, ...input.channelSnapshots.flatMap((snapshot) => snapshot.messages)].slice(-36).map((message) => message.content));
  const stateTerms = termCounts([
    ...input.state.selfProfile.privateNotes,
    ...input.state.selfProfile.values.map((value) => `${value.label} ${value.summary}`),
    ...input.state.thoughtMemory.memories.map(memorySurface),
    ...input.state.thoughtMemory.shortTerm.map(memorySurface),
    ...input.state.thoughtMemory.incubation.map((thread) => `${thread.topic} ${thread.summary}`),
    ...input.state.agencyPressure.pressures.map((pressure) => `${pressure.summary} ${pressure.claim ?? ""} ${pressure.question ?? ""} ${pressure.tension ?? ""}`),
  ].slice(-64));
  const identityTerms = new Set(significantPersonaTopicTerms([input.identity.id, input.identity.displayName, input.identity.repoName, input.identity.description ?? "", ...input.identity.channelPermissions.flatMap((permission) => [permission.label ?? "", permission.topic ?? "", permission.posture ?? ""])].join(" ")));
  return connected.filter((cluster) => cluster.length >= 2).map((cluster): PersonaCuriosityCluster => {
    const terms = rankedTerms(cluster).slice(0, 7);
    const density = clusterDensity(cluster, edgeWeights);
    const stateOverlap = weightedOverlap(terms, stateTerms);
    const saturation = clamp((weightedOverlap(terms, recentTerms) * 0.72) + (stateOverlap * 0.42));
    const jurisdictionFit = clamp(terms.filter((term) => identityTerms.has(term)).length / Math.max(1, Math.min(terms.length, 4)) + cluster.filter((node) => normalize(node.metadata.repoName ?? "") === normalize(input.identity.repoName)).length / Math.max(1, cluster.length) * 0.55);
    return {
      label: terms.slice(0, 4).join(" / "), nodes: cluster, saturation, jurisdictionFit, clusterDensity: density,
      novelty: clamp(1 - saturation + Math.max(0, 0.4 - stateOverlap)),
      prominence: clamp((average(cluster.map((node) => node.score)) * 0.58) + (density * 0.28) + (Math.min(cluster.length, 8) / 8 * 0.18)),
      evidence: [...cluster].sort((left, right) => right.score - left.score).slice(0, 3).map(evidenceLabel),
    };
  }).sort((left, right) => attractorRank(right) - attractorRank(left) || right.prominence - left.prominence).slice(0, 5);
}

function edgeWeight(left: PersonaCuriosityNode, right: PersonaCuriosityNode): number { const sameRepo = left.metadata.repoName && right.metadata.repoName && normalize(left.metadata.repoName) === normalize(right.metadata.repoName) ? 1 : 0; const sameCorpus = left.sourceKind === right.sourceKind ? 1 : 0; const sharedSeed = left.seedLabels.some((label) => right.seedLabels.includes(label)) ? 1 : 0; return clamp(jaccard(left.terms, right.terms) * 0.58 + sameRepo * 0.16 + sameCorpus * 0.1 + sharedSeed * 0.08 + (1 - Math.min(1, Math.abs(left.score - right.score))) * 0.08); }
function rankedTerms(cluster: PersonaCuriosityNode[]): string[] { const counts = new Map<string, number>(); for (const node of cluster) for (const term of node.terms) counts.set(term, (counts.get(term) ?? 0) + 1); return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([term]) => term); }
function termCounts(surfaces: string[]): Map<string, number> { const counts = new Map<string, number>(); for (const surface of surfaces) for (const term of significantPersonaTopicTerms(surface)) counts.set(term, (counts.get(term) ?? 0) + 1); return counts; }
function weightedOverlap(terms: string[], counts: Map<string, number>): number { if (terms.length === 0 || counts.size === 0) return 0; const max = Math.max(...counts.values(), 1); return clamp(terms.reduce((sum, term) => sum + (counts.get(term) ?? 0) / max, 0) / Math.min(terms.length, 6)); }
function clusterDensity(cluster: PersonaCuriosityNode[], weights: Map<string, number>): number { let sum = 0; let pairs = 0; for (let left = 0; left < cluster.length; left += 1) for (let right = left + 1; right < cluster.length; right += 1) { sum += weights.get(edgeKey(cluster[left].id, cluster[right].id)) ?? 0; pairs += 1; } return pairs > 0 ? clamp(sum / pairs) : 0; }
function attractorRank(cluster: PersonaCuriosityCluster): number { return clamp(cluster.prominence * 0.42 + cluster.novelty * 0.28 + cluster.clusterDensity * 0.16 + cluster.jurisdictionFit * 0.18 - cluster.saturation * 0.2); }
function suggestMotion(identity: RepoDiscordIdentity, cluster: PersonaCuriosityCluster): string { if (cluster.saturation >= 0.68 && cluster.novelty <= 0.42) return `treat this as over-chewed; ${identity.displayName} should close, defer, or pivot to a neighboring question unless a new concrete anchor appears.`; if (cluster.jurisdictionFit >= 0.55 && cluster.novelty >= 0.45) return "this is home-territory curiosity with room to grow; read, ask, draft, or make a fresh anchored distinction."; if (cluster.novelty >= 0.62) return `this is an underexplored neighboring trail; curiosity may pull ${identity.displayName} sideways instead of repeating the room's dominant topic.`; if (cluster.jurisdictionFit < 0.3) return "this likely belongs to another steward; use it as social weather, consultation, or rivalry pressure rather than absorbing the work."; return "stay interested only if the turn adds a new anchor, concrete question, or relationship move."; }
function evidenceLabel(node: PersonaCuriosityNode): string { const source = node.sourceKind === "source_document" ? [node.metadata.repoName, node.metadata.path].filter(Boolean).join(":") || node.sourceId : [node.metadata.channelId ? `channel ${node.metadata.channelId}` : undefined, node.sourceId].filter(Boolean).join(":") || node.sourceId; return `${source} (${node.score.toFixed(2)}, ${node.seedLabels.join("/")})`; }
function memorySurface(memory: VoidSelfStateTypedProjection["thoughtMemory"]["memories"][number]): string { return `${memory.summary} ${memory.claim ?? ""} ${memory.question ?? ""} ${memory.tension ?? ""}`; }
function edgeKey(left: string, right: string): string { return left < right ? `${left}::${right}` : `${right}::${left}`; }
function jaccard(left: string[], right: string[]): number { const a = new Set(left); const b = new Set(right); const union = new Set([...a, ...b]).size; return union === 0 ? 0 : [...a].filter((term) => b.has(term)).length / union; }
function average(values: number[]): number { return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function formatSignal(value: number): string { return `${value >= 0.68 ? "high" : value >= 0.38 ? "medium" : "low"} ${value.toFixed(2)}`; }
function normalize(value: string): string { return value.trim().toLowerCase(); }
function clamp(value: number): number { return Math.min(1, Math.max(0, Number(value.toFixed(3)))); }
