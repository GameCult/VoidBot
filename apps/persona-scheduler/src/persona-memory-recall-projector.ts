import type { PersonaMemoryRecallObservation } from "./persona-memory-context-source.js";

export function projectPersonaMemoryRecall(observation: PersonaMemoryRecallObservation): string {
  if (observation.status === "unavailable") return [
    "Semantic Persona memory recall unavailable:",
    `- ${collapse(observation.reason, 320)}`,
    "- Do not pretend semantic Persona memory retrieval was available this turn; use projected state and raw transcript instead.",
  ].join("\n");
  if (observation.hits.length === 0) return [
    "- Semantic Persona memory recall ran, but no nearby memories crossed the retrieval threshold.",
    "- Fall back to the projected state, raw transcript, and direct evidence above.",
  ].join("\n");
  return [
    "These are derived Qdrant/local-vector recall hits from this Persona's typed memory. They are hints, not new authority; the `.cc` state remains the owner.",
    ...observation.hits.map((hit, index) => {
      const kind = hit.memoryKind ? `/${hit.memoryKind}` : "";
      const target = hit.targetLabel ?? hit.targetId ?? "unknown target";
      return `- ${index + 1}. ${target}${kind} score=${hit.score.toFixed(3)}: ${collapse(hit.text, 520)}`;
    }),
  ].join("\n");
}

function collapse(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
