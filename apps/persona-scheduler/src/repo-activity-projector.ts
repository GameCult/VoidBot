import type { RepoActivityObservation } from "./repo-activity-source.js";

export function projectRepoActivityObservation(observation: RepoActivityObservation): string {
  if (observation.status === "unconfigured") return "- This Persona has no source repository configured; no repo activity was requested.";
  if (observation.status === "unavailable") return [
    `- Recent ${observation.sourceRepoName} activity could not be read for this turn.`,
    observation.detail ? `- Reader error: ${collapse(observation.detail, 500)}` : "- Reader error: no diagnostic output.",
    "- Do not claim current repo state from stale memory; use source/history tools before making fresh claims.",
  ].join("\n");
  if (observation.status === "malformed") return [
    `- Recent ${observation.sourceRepoName} activity output was not parseable.`,
    `- Raw output: ${collapse(observation.raw, 500)}`,
    "- Do not claim current repo state from stale memory; use source/history tools before making fresh claims.",
  ].join("\n");
  return observation.digest || `- No recent ${observation.sourceRepoName} activity was reported.`;
}

function collapse(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
