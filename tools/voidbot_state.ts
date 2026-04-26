import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type BranchRecord = {
  id: string;
  hypothesis: string;
  status: "active" | "accepted" | "rejected" | "archived";
  artifacts?: string[];
  notes?: string;
};

type BranchStore = {
  branches: BranchRecord[];
};

const root = process.cwd();
const stateDir = resolve(root, "state");
const mapPath = resolve(stateDir, "map.yaml");
const branchesPath = resolve(stateDir, "branches.json");
const evidencePath = resolve(stateDir, "evidence.jsonl");

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function writeText(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

function loadBranches(): BranchStore {
  return JSON.parse(readText(branchesPath)) as BranchStore;
}

function saveBranches(data: BranchStore): void {
  writeText(branchesPath, `${JSON.stringify(data, null, 2)}\n`);
}

function appendEvidence(record: Record<string, Json>): void {
  appendFileSync(evidencePath, `${JSON.stringify(record)}\n`, "utf8");
}

function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
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

function parseOptions(args: string[]): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument '${token}'.`);
    }
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    const existing = options.get(key) ?? [];
    existing.push(value);
    options.set(key, existing);
    index += 1;
  }
  return options;
}

function getRequired(options: Map<string, string[]>, key: string): string {
  const value = options.get(key)?.[0];
  if (!value) {
    throw new Error(`Missing required option --${key}.`);
  }
  return value;
}

function cmdStatus(): number {
  const branches = loadBranches().branches ?? [];
  const active = branches.filter((branch) => branch.status === "active");
  const summary = extractMapField("summary") ?? "(missing)";
  const nextAction = extractMapField("next_action") ?? "(missing)";
  const subgoals = extractActiveSubgoals();

  console.log(`Workspace: ${root}`);
  console.log(`Summary: ${summary}`);
  console.log(`Next action: ${nextAction}`);
  console.log(`Active branches: ${active.length} / ${branches.length}`);
  if (subgoals.length > 0) {
    console.log("Active subgoals:");
    for (const item of subgoals) {
      console.log(`- ${item}`);
    }
  }
  return 0;
}

function cmdAddEvidence(args: string[]): number {
  const options = parseOptions(args);
  const record: Record<string, Json> = {
    ts: utcStamp(),
    type: getRequired(options, "type"),
    status: getRequired(options, "status"),
    note: getRequired(options, "note"),
  };
  const branch = options.get("branch")?.[0];
  if (branch) {
    record.branch = branch;
  }
  appendEvidence(record);
  console.log("Appended evidence record.");
  return 0;
}

function cmdAddBranch(args: string[]): number {
  const options = parseOptions(args);
  const data = loadBranches();
  const id = getRequired(options, "id");
  if (data.branches.some((branch) => branch.id === id)) {
    throw new Error(`Branch '${id}' already exists.`);
  }
  data.branches.push({
    id,
    hypothesis: getRequired(options, "hypothesis"),
    status: "active",
    artifacts: options.get("artifact"),
    notes: options.get("note")?.[0],
  });
  saveBranches(data);
  console.log(`Added branch '${id}'.`);
  return 0;
}

function cmdCloseBranch(args: string[]): number {
  const options = parseOptions(args);
  const id = getRequired(options, "id");
  const status = getRequired(options, "status");
  if (!["accepted", "rejected", "archived"].includes(status)) {
    throw new Error("--status must be one of accepted, rejected, archived.");
  }
  const data = loadBranches();
  const branch = data.branches.find((item) => item.id === id);
  if (!branch) {
    throw new Error(`Branch '${id}' was not found.`);
  }
  branch.status = status as BranchRecord["status"];
  const note = options.get("note")?.[0];
  if (note) {
    branch.notes = note;
  }
  saveBranches(data);
  console.log(`Updated branch '${id}' to status '${status}'.`);
  return 0;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npx tsx tools/voidbot_state.ts status",
      "  npx tsx tools/voidbot_state.ts add-evidence --type TYPE --status STATUS --note NOTE [--branch ID]",
      "  npx tsx tools/voidbot_state.ts add-branch --id ID --hypothesis TEXT [--artifact PATH ...] [--note TEXT]",
      "  npx tsx tools/voidbot_state.ts close-branch --id ID --status accepted|rejected|archived [--note TEXT]",
    ].join("\n"),
  );
}

function main(argv: string[]): number {
  const [command, ...args] = argv;
  switch (command) {
    case "status":
      return cmdStatus();
    case "add-evidence":
      return cmdAddEvidence(args);
    case "add-branch":
      return cmdAddBranch(args);
    case "close-branch":
      return cmdCloseBranch(args);
    default:
      usage();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
