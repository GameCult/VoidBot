import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";
import {
  loadRepoDiscordIdentityRegistry,
  loadVoidSelfStateTypedDocuments,
  resolveRepoPersonaStatePath,
} from "@voidbot/core";

type Target = {
  kind?: string;
  id?: string;
  label?: string;
};

type AgentAsk = {
  agentId: string;
  displayName: string;
  repoName?: string;
  statePath: string;
  source: "agency_pressure" | "candidate_intervention" | "incubation" | "short_term_memory";
  id: string;
  status?: string;
  kind?: string;
  target?: Target;
  summary: string;
  claimOrQuestion?: string;
  tension?: string;
  actionImplication?: string;
  intensity: number;
  updatedAt?: string;
  tags: string[];
};

type AgentSummary = {
  agentId: string;
  displayName: string;
  repoName?: string;
  statePath: string;
  askCount: number;
  topAsks: AgentAsk[];
};

type ProposalSeed = {
  proposalId: string;
  title: string;
  targetKey: string;
  agentCount: number;
  askCount: number;
  averageIntensity: number;
  agents: string[];
  recommendedAction: string;
  asks: AgentAsk[];
};

type InspectionPacket = {
  generatedAt: string;
  agentCount: number;
  agentsWithAsks: number;
  allAgentsHaveActiveAsks: boolean;
  summaries: AgentSummary[];
  proposalSeeds: ProposalSeed[];
  topIndividualAsks: AgentAsk[];
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const generatedAt = new Date().toISOString();
  const agents = await loadAgentSummaries(config);
  const asks = agents.flatMap((agent) => agent.topAsks);
  const packet: InspectionPacket = {
    generatedAt,
    agentCount: agents.length,
    agentsWithAsks: agents.filter((agent) => agent.askCount > 0).length,
    allAgentsHaveActiveAsks: agents.length > 0 && agents.every((agent) => agent.askCount > 0),
    summaries: agents,
    proposalSeeds: buildProposalSeeds(asks),
    topIndividualAsks: asks
      .slice()
      .sort((left, right) => right.intensity - left.intensity)
      .slice(0, 12),
  };

  const jsonPath = resolve(options.jsonOut ?? ".voidbot/status/agent-state-action-proposals.json");
  const markdownPath = resolve(options.markdownOut ?? ".voidbot/status/agent-state-action-proposals.md");
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(packet), "utf8");

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    return;
  }

  process.stdout.write(renderMarkdown(packet));
}

async function loadAgentSummaries(config: ReturnType<typeof loadConfig>): Promise<AgentSummary[]> {
  const registry = await loadRepoDiscordIdentityRegistry(config.repoDiscordIdentitiesPath);
  const specs = [
    {
      agentId: "void",
      displayName: "Void",
      repoName: "VoidBot",
      statePath: config.moderationAgentStatePath,
      identity: undefined,
    },
    ...registry.identities.map((identity) => ({
      agentId: identity.id,
      displayName: identity.displayName,
      repoName: identity.repoName,
      statePath: resolveRepoPersonaStatePath(identity, config.storageRoot),
      identity,
    })),
  ];

  const summaries: AgentSummary[] = [];
  for (const spec of specs) {
    try {
      const state = await loadVoidSelfStateTypedDocuments({
        canonicalPath: spec.statePath,
        identity: {
          agentId: spec.agentId,
          publicName: spec.displayName,
          publicDescription: spec.identity?.description,
        },
      });
      const asks = extractAsks({
        agentId: spec.agentId,
        displayName: spec.displayName,
        repoName: spec.repoName,
        statePath: spec.statePath,
        state,
      });
      summaries.push({
        agentId: spec.agentId,
        displayName: spec.displayName,
        repoName: spec.repoName,
        statePath: spec.statePath,
        askCount: asks.length,
        topAsks: asks
          .sort((left, right) => right.intensity - left.intensity)
          .slice(0, 8),
      });
    } catch (error) {
      summaries.push({
        agentId: spec.agentId,
        displayName: spec.displayName,
        repoName: spec.repoName,
        statePath: spec.statePath,
        askCount: 1,
        topAsks: [{
          agentId: spec.agentId,
          displayName: spec.displayName,
          repoName: spec.repoName,
          statePath: spec.statePath,
          source: "agency_pressure",
          id: `state-load-error:${spec.agentId}`,
          status: "active",
          kind: "inspection_error",
          target: { kind: "system", id: "agent-state-inspection", label: "Agent state inspection" },
          summary: `Could not load ${spec.displayName} state: ${error instanceof Error ? error.message : String(error)}`,
          actionImplication: "Inspect and repair the state path or registry entry before trusting this agent's asks.",
          intensity: 1,
          updatedAt: new Date().toISOString(),
          tags: ["inspection:error"],
        }],
      });
    }
  }
  return summaries;
}

function extractAsks(input: {
  agentId: string;
  displayName: string;
  repoName?: string;
  statePath: string;
  state: any;
}): AgentAsk[] {
  const base = {
    agentId: input.agentId,
    displayName: input.displayName,
    repoName: input.repoName,
    statePath: input.statePath,
  };
  const asks: AgentAsk[] = [];

  for (const pressure of input.state.agencyPressure?.pressures ?? []) {
    if (!["active", "ready_to_act", "cooling"].includes(pressure.status)) {
      continue;
    }
    asks.push({
      ...base,
      source: "agency_pressure",
      id: pressure.pressureId,
      status: pressure.status,
      kind: pressure.kind,
      target: pressure.target,
      summary: pressure.summary,
      claimOrQuestion: pressure.claim ?? pressure.question,
      tension: pressure.tension,
      actionImplication: pressure.actionImplication,
      intensity: clampNumber(pressure.intensity ?? 0.5, 0, 1),
      updatedAt: pressure.updatedAt,
      tags: pressure.tags ?? [],
    });
  }

  for (const intervention of input.state.candidateInterventions?.interventions ?? []) {
    if (!["queued", "deferred"].includes(intervention.status)) {
      continue;
    }
    asks.push({
      ...base,
      source: "candidate_intervention",
      id: intervention.interventionId,
      status: intervention.status,
      kind: intervention.kind,
      target: intervention.target,
      summary: intervention.summary,
      actionImplication: intervention.draft,
      intensity: clampNumber(intervention.priority ?? 0.5, 0, 1),
      updatedAt: intervention.updatedAt,
      tags: intervention.tags ?? [],
    });
  }

  for (const thread of input.state.thoughtMemory?.incubation ?? []) {
    if (!["active", "ready_to_share"].includes(thread.status)) {
      continue;
    }
    const intensity = Math.max(thread.maturation ?? 0, thread.desireToSpeak ?? 0, 0.35);
    if (intensity < 0.55 && thread.status !== "ready_to_share") {
      continue;
    }
    asks.push({
      ...base,
      source: "incubation",
      id: thread.threadId,
      status: thread.status,
      target: thread.target,
      summary: thread.summary,
      claimOrQuestion: thread.topic,
      actionImplication: "Decide whether this incubating thought should become a proposal, public post, article, or retired thread.",
      intensity: clampNumber(intensity, 0, 1),
      updatedAt: thread.updatedAt,
      tags: thread.tags ?? [],
    });
  }

  for (const memory of input.state.thoughtMemory?.shortTerm ?? []) {
    if (!memory.actionImplication) {
      continue;
    }
    asks.push({
      ...base,
      source: "short_term_memory",
      id: memory.memoryId,
      status: "short_term",
      kind: memory.kind,
      target: memory.target,
      summary: memory.summary,
      claimOrQuestion: memory.claim ?? memory.question,
      tension: memory.tension,
      actionImplication: memory.actionImplication,
      intensity: 0.45,
      updatedAt: memory.updatedAt,
      tags: memory.tags ?? [],
    });
  }

  return asks;
}

function buildProposalSeeds(asks: AgentAsk[]): ProposalSeed[] {
  const groups = new Map<string, AgentAsk[]>();
  for (const ask of asks) {
    const key = targetKey(ask);
    groups.set(key, [...(groups.get(key) ?? []), ask]);
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const agents = Array.from(new Set(group.map((ask) => ask.displayName))).sort();
      const averageIntensity = group.reduce((sum, ask) => sum + ask.intensity, 0) / Math.max(group.length, 1);
      return {
        proposalId: slugify(key),
        title: proposalTitle(key, group),
        targetKey: key,
        agentCount: agents.length,
        askCount: group.length,
        averageIntensity: round3(averageIntensity),
        agents,
        recommendedAction: recommendedAction(group),
        asks: group
          .slice()
          .sort((left, right) => right.intensity - left.intensity)
          .slice(0, 10),
      };
    })
    .filter((proposal) => proposal.agentCount >= 2 || proposal.askCount >= 3 || proposal.averageIntensity >= 0.75)
    .sort((left, right) => {
      if (right.agentCount !== left.agentCount) {
        return right.agentCount - left.agentCount;
      }
      if (right.averageIntensity !== left.averageIntensity) {
        return right.averageIntensity - left.averageIntensity;
      }
      return right.askCount - left.askCount;
    })
    .slice(0, 10);
}

function targetKey(ask: AgentAsk): string {
  const target = ask.target;
  if (target?.kind && target?.id) {
    return `${target.kind}:${target.id}`;
  }
  if (ask.repoName) {
    return `repo:${ask.repoName}`;
  }
  return `agent:${ask.agentId}`;
}

function proposalTitle(key: string, asks: AgentAsk[]): string {
  const targetLabel = asks.find((ask) => ask.target?.label)?.target?.label ?? key;
  const sourceKinds = Array.from(new Set(asks.map((ask) => ask.source.replace(/_/g, " ")))).join(", ");
  return `${targetLabel}: ${asks.length} active ask${asks.length === 1 ? "" : "s"} from ${sourceKinds}`;
}

function recommendedAction(asks: AgentAsk[]): string {
  const hasCandidate = asks.some((ask) => ask.source === "candidate_intervention");
  const hasReadyPressure = asks.some((ask) => ask.source === "agency_pressure" && ask.status === "ready_to_act");
  const hasArticle = asks.some((ask) => /\b(article|essay|blog|draft|proposal|pr)\b/i.test(`${ask.summary} ${ask.actionImplication ?? ""}`));
  if (hasCandidate) {
    return "Inspect queued/deferred candidates and either deliver, convert to a PR/intake request, or retire them explicitly.";
  }
  if (hasArticle) {
    return "Turn the converged ask into a concrete article/proposal packet, then route it through Bifrost or the target repo's Codex intake lane.";
  }
  if (hasReadyPressure) {
    return "Promote ready agency pressure into a concrete work packet with owner-visible proposed action and acceptance criteria.";
  }
  return "Ask whether this converged pressure should become a work packet, article, PR proposal, or be cooled as non-actionable.";
}

function renderMarkdown(packet: InspectionPacket): string {
  const lines = [
    `# Agent State Action Proposals`,
    "",
    `Generated: ${packet.generatedAt}`,
    `Agents with asks: ${packet.agentsWithAsks}/${packet.agentCount}`,
    `All agents have active asks: ${packet.allAgentsHaveActiveAsks ? "yes" : "no"}`,
    "",
    "## Proposal Seeds",
  ];

  if (packet.proposalSeeds.length === 0) {
    lines.push("", "No cross-agent proposal seeds met the deterministic threshold.");
  } else {
    for (const proposal of packet.proposalSeeds) {
      lines.push(
        "",
        `### ${proposal.title}`,
        `- Target: ${proposal.targetKey}`,
        `- Agents: ${proposal.agents.join(", ")}`,
        `- Ask count: ${proposal.askCount}; average intensity: ${proposal.averageIntensity}`,
        `- Recommended action: ${proposal.recommendedAction}`,
      );
      for (const ask of proposal.asks.slice(0, 4)) {
        lines.push(`  - ${ask.displayName} [${ask.source}/${ask.status ?? "n/a"}]: ${singleLine(ask.summary)}`);
        if (ask.actionImplication) {
          lines.push(`    Action: ${singleLine(ask.actionImplication)}`);
        }
      }
    }
  }

  lines.push("", "## Per-Agent Top Asks");
  for (const summary of packet.summaries) {
    lines.push("", `### ${summary.displayName} (${summary.agentId})`, `State: ${summary.statePath}`);
    if (summary.topAsks.length === 0) {
      lines.push("- No active asks found.");
      continue;
    }
    for (const ask of summary.topAsks.slice(0, 5)) {
      lines.push(`- ${ask.source}/${ask.status ?? "n/a"} intensity=${ask.intensity}: ${singleLine(ask.summary)}`);
      if (ask.actionImplication) {
        lines.push(`  Action: ${singleLine(ask.actionImplication)}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(args: string[]): { format: "markdown" | "json"; jsonOut?: string; markdownOut?: string } {
  const options: { format: "markdown" | "json"; jsonOut?: string; markdownOut?: string } = {
    format: "markdown",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--format":
        options.format = requireValue(args, ++index, arg) === "json" ? "json" : "markdown";
        break;
      case "--json-out":
        options.jsonOut = requireValue(args, ++index, arg);
        break;
      case "--markdown-out":
        options.markdownOut = requireValue(args, ++index, arg);
        break;
    }
  }
  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "proposal";
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
