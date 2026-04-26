import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

type FindingLevel = "ok" | "warn" | "error";

type Finding = {
  level: FindingLevel;
  message: string;
};

type BranchRecord = {
  id?: string;
  status?: string;
};

const root = process.cwd();
const stateDir = resolve(root, "state");
const notesDir = resolve(root, "notes");

const mapPath = resolve(stateDir, "map.yaml");
const scratchPath = resolve(stateDir, "scratch.md");
const branchesPath = resolve(stateDir, "branches.json");
const evidencePath = resolve(stateDir, "evidence.jsonl");
const handoffPath = resolve(notesDir, "fresh-workspace-handoff.md");
const systemMapPath = resolve(notesDir, "voidbot-current-system-map.md");
const planPath = resolve(notesDir, "voidbot-implementation-plan.md");
const agentsPath = resolve(root, "AGENTS.md");

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function runGit(args: string[]): string {
  const completed = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (completed.status !== 0) {
    throw new Error((completed.stderr || completed.stdout || "git command failed").trim());
  }
  return completed.stdout.trim();
}

function extractMapField(name: string): string | undefined {
  const prefix = `  ${name}:`;
  for (const line of readText(mapPath).split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      return line.split(":", 2)[1]?.trim();
    }
  }
  return undefined;
}

function extractActiveSubgoals(): string[] {
  const lines = readText(mapPath).split(/\r?\n/);
  const results: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.trim() === "active_subgoals:") {
        inSection = true;
      }
      continue;
    }
    if (line.startsWith("  - ")) {
      results.push(line.slice(4).trim());
      continue;
    }
    if (line && !line.startsWith(" ")) {
      break;
    }
  }
  return results;
}

function currentScratchSubgoal(): string | undefined {
  const lines = readText(scratchPath).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "## Current Subgoal") {
      continue;
    }
    for (let offset = index + 1; offset < lines.length; offset += 1) {
      const stripped = lines[offset]?.trim();
      if (stripped) {
        return stripped;
      }
    }
  }
  return undefined;
}

function loadEvidence(): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const lines = readText(evidencePath).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `evidence line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!record || Array.isArray(record) || typeof record !== "object") {
      throw new Error(`evidence line ${index + 1} is not a JSON object`);
    }
    records.push(record as Record<string, unknown>);
  });
  return records;
}

function loadBranches(): { branches: BranchRecord[] } {
  const data = JSON.parse(readText(branchesPath)) as { branches?: unknown };
  if (!data || typeof data !== "object" || !Array.isArray(data.branches)) {
    throw new Error("branches.json must contain a branches array");
  }
  return { branches: data.branches as BranchRecord[] };
}

function addRequiredFileChecks(findings: Finding[]): void {
  for (const path of [
    mapPath,
    scratchPath,
    branchesPath,
    evidencePath,
    handoffPath,
    systemMapPath,
    planPath,
    agentsPath,
  ]) {
    if (existsSync(path)) {
      findings.push({ level: "ok", message: `found ${path.slice(root.length + 1)}` });
    } else {
      findings.push({ level: "error", message: `missing ${path.slice(root.length + 1)}` });
    }
  }
}

function addContentChecks(findings: Finding[]): Record<string, unknown>[] {
  const summary = extractMapField("summary");
  const nextAction = extractMapField("next_action");
  if (summary) {
    findings.push({ level: "ok", message: "state/map.yaml has current_status.summary" });
  } else {
    findings.push({ level: "error", message: "state/map.yaml is missing current_status.summary" });
  }
  if (nextAction) {
    findings.push({ level: "ok", message: "state/map.yaml has current_status.next_action" });
  } else {
    findings.push({ level: "error", message: "state/map.yaml is missing current_status.next_action" });
  }

  const subgoals = extractActiveSubgoals();
  if (subgoals.length > 0) {
    findings.push({ level: "ok", message: `state/map.yaml has ${subgoals.length} active subgoal(s)` });
  } else {
    findings.push({ level: "warn", message: "state/map.yaml has no active_subgoals entries" });
  }

  const scratchSubgoal = currentScratchSubgoal();
  if (scratchSubgoal === "No active scratch subgoal.") {
    findings.push({ level: "ok", message: "state/scratch.md has no stale active scratch subgoal" });
  } else if (scratchSubgoal) {
    findings.push({ level: "warn", message: `state/scratch.md has active scratch subgoal: ${scratchSubgoal}` });
  } else {
    findings.push({ level: "warn", message: "state/scratch.md has no Current Subgoal value" });
  }

  const evidence = loadEvidence();
  findings.push({ level: "ok", message: `state/evidence.jsonl parses (${evidence.length} record(s))` });
  if (statSync(evidencePath).size > 25_000) {
    findings.push({ level: "warn", message: "state/evidence.jsonl is larger than 25 KB; consider distillation" });
  }

  const branches = loadBranches();
  const active = branches.branches.filter((branch) => branch?.status === "active");
  findings.push({ level: "ok", message: `state/branches.json parses (${active.length} active branch(es))` });

  return evidence;
}

function addHandoffChecks(findings: Finding[]): void {
  const text = readText(handoffPath);
  if (/Current branch before .*ahead \d+/i.test(text) || /Current HEAD before .*\b[0-9a-f]{7,40}\b/i.test(text)) {
    findings.push({ level: "error", message: "handoff embeds an exact branch or HEAD snapshot; use git commands instead" });
  } else {
    findings.push({ level: "ok", message: "handoff avoids exact branch or HEAD snapshots" });
  }

  const requiredPhrases = [
    "Do not continue implementation automatically from a rehydrate-only request.",
    "Do not trust this file for the exact live HEAD.",
    "Immediate Re-entry Instruction",
  ];
  for (const phrase of requiredPhrases) {
    if (text.includes(phrase)) {
      findings.push({ level: "ok", message: `handoff contains: ${phrase}` });
    } else {
      findings.push({ level: "warn", message: `handoff missing: ${phrase}` });
    }
  }
}

function addAgentsChecks(findings: Finding[]): void {
  const text = readText(agentsPath);
  if (text.includes("voidbot_prepare_compaction.ts")) {
    findings.push({ level: "ok", message: "AGENTS.md tells agents to use the compaction helper" });
  } else {
    findings.push({ level: "error", message: "AGENTS.md does not mention tools/voidbot_prepare_compaction.ts" });
  }
  if (text.toLowerCase().includes("prepare for imminent compaction")) {
    findings.push({ level: "ok", message: "AGENTS.md names the imminent-compaction trigger" });
  } else {
    findings.push({ level: "warn", message: "AGENTS.md does not name the imminent-compaction trigger phrase" });
  }
}

function addGitChecks(findings: Finding[]): { status: string; log: string } {
  const status = runGit(["status", "--short", "--branch"]);
  const log = runGit(["log", "--oneline", "-5"]);
  const dirtyLines = status
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim().length > 0);
  if (dirtyLines.length > 0) {
    findings.push({ level: "warn", message: "git worktree has uncommitted changes; commit or explain before compaction" });
  } else {
    findings.push({ level: "ok", message: "git worktree is clean" });
  }
  return { status, log };
}

function renderReport(
  findings: Finding[],
  status: string,
  log: string,
  evidence: Record<string, unknown>[],
): string {
  const summary = extractMapField("summary") ?? "(missing)";
  const nextAction = extractMapField("next_action") ?? "(missing)";
  const subgoals = extractActiveSubgoals();
  const counts = {
    ok: findings.filter((finding) => finding.level === "ok").length,
    warn: findings.filter((finding) => finding.level === "warn").length,
    error: findings.filter((finding) => finding.level === "error").length,
  };

  const lines = [
    "VoidBot pre-compaction persistence check",
    `Workspace: ${root}`,
    `Findings: ${counts.ok} ok, ${counts.warn} warn, ${counts.error} error`,
    "",
    "Git status:",
    status,
    "",
    "Recent commits:",
    log,
    "",
    `Summary: ${summary}`,
    `Next action: ${nextAction}`,
  ];

  if (subgoals.length > 0) {
    lines.push("Active subgoals:");
    lines.push(...subgoals.map((item) => `- ${item}`));
  }

  if (evidence.length > 0) {
    const latest = evidence[evidence.length - 1] as Record<string, unknown>;
    lines.push(
      "",
      "Latest distilled evidence:",
      `- ${String(latest.ts ?? "(missing ts)")} ${String(latest.type ?? "(missing type)")}/${String(latest.status ?? "(missing status)")}: ${String(latest.note ?? "(missing note)")}`,
    );
  }

  lines.push("", "Findings:");
  for (const finding of findings) {
    lines.push(`[${finding.level.toUpperCase()}] ${finding.message}`);
  }

  lines.push(
    "",
    "Pre-compaction checklist:",
    "- Update state/map.yaml only if current understanding changed.",
    "- Refresh notes/fresh-workspace-handoff.md if re-entry instructions changed.",
    "- Add distilled evidence only for a belief-changing lesson, verification, rejected path, or scar.",
    "- Keep exact branch or HEAD out of handoff prose; git commands own volatile truth.",
    "- Commit completed persistence changes, or state why the worktree must stay dirty.",
    "- Re-run this helper after edits before yielding to compaction.",
  );

  return lines.join("\n");
}

function main(argv: string[]): number {
  const strict = argv.includes("--strict");
  const findings: Finding[] = [];
  let evidence: Record<string, unknown>[] = [];

  addRequiredFileChecks(findings);
  try {
    evidence = addContentChecks(findings);
  } catch (error) {
    findings.push({
      level: "error",
      message: `state content check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    addHandoffChecks(findings);
  } catch (error) {
    findings.push({
      level: "error",
      message: `handoff check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    addAgentsChecks(findings);
  } catch (error) {
    findings.push({
      level: "error",
      message: `AGENTS check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let status = "(git status unavailable)";
  let log = "(git log unavailable)";
  try {
    ({ status, log } = addGitChecks(findings));
  } catch (error) {
    findings.push({
      level: "error",
      message: `git check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  console.log(renderReport(findings, status, log, evidence));

  const hasError = findings.some((finding) => finding.level === "error");
  const hasWarning = findings.some((finding) => finding.level === "warn");
  return hasError || (strict && hasWarning) ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
