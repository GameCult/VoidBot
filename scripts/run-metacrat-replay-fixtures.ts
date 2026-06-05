import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface ReplayFixtureSuite {
  personaId?: string;
  publicName?: string;
  fixtures: ReplayFixture[];
}

interface ReplayFixture {
  id: string;
  targetMessageId: string;
  before?: number;
  after?: number;
  heldoutMinutes?: number;
  contextMaxAgeMinutes?: number;
  pressure?: string;
  focus?: string;
}

interface CliOptions {
  fixtureFile: string;
  fixtureId?: string;
  outRoot: string;
  runCodex: boolean;
  evaluateCodex: boolean;
  limit?: number;
}

interface ReplayRunSummary {
  fixtureId: string;
  targetMessageId: string;
  pressure?: string;
  focus?: string;
  artifactDir?: string;
  reportPath?: string;
  exitCode: number | null;
  timedOut: boolean;
  counts?: Record<string, unknown>;
  deterministicComparison?: Record<string, unknown>;
  modelEvaluation?: unknown;
  predictedReply?: unknown;
  error?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const suite = JSON.parse(await readFile(options.fixtureFile, "utf8")) as ReplayFixtureSuite;
  const selectedFixtures = suite.fixtures
    .filter((fixture) => !options.fixtureId || fixture.id === options.fixtureId)
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);

  if (selectedFixtures.length === 0) {
    throw new Error(options.fixtureId
      ? `No fixture with id ${options.fixtureId} in ${options.fixtureFile}.`
      : `No fixtures found in ${options.fixtureFile}.`);
  }

  await mkdir(options.outRoot, { recursive: true });

  const summaries: ReplayRunSummary[] = [];
  for (const fixture of selectedFixtures) {
    const summary = await runFixture({ fixture, suite, options });
    summaries.push(summary);
    console.log(JSON.stringify(summary, null, 2));
  }

  const aggregate = {
    generatedAt: new Date().toISOString(),
    fixtureFile: options.fixtureFile,
    outRoot: options.outRoot,
    runCodex: options.runCodex,
    evaluateCodex: options.evaluateCodex,
    fixtures: summaries,
  };
  const aggregatePath = join(options.outRoot, `metacrat-replay-suite-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ aggregatePath }, null, 2));
}

async function runFixture(input: {
  fixture: ReplayFixture;
  suite: ReplayFixtureSuite;
  options: CliOptions;
}): Promise<ReplayRunSummary> {
  const args = [
    resolve("node_modules", "tsx", "dist", "cli.mjs"),
    resolve("scripts", "replay-metacrat-thread.ts"),
    "--target-message-id",
    input.fixture.targetMessageId,
    "--persona-id",
    input.suite.personaId ?? "metacrat",
    "--public-name",
    input.suite.publicName ?? "Metacrat",
    "--out",
    input.options.outRoot,
  ];

  if (typeof input.fixture.before === "number") {
    args.push("--before", String(input.fixture.before));
  }
  if (typeof input.fixture.after === "number") {
    args.push("--after", String(input.fixture.after));
  }
  if (typeof input.fixture.heldoutMinutes === "number") {
    args.push("--heldout-minutes", String(input.fixture.heldoutMinutes));
  }
  if (typeof input.fixture.contextMaxAgeMinutes === "number") {
    args.push("--context-max-age-minutes", String(input.fixture.contextMaxAgeMinutes));
  }
  if (input.options.runCodex) {
    args.push("--run-codex");
  }
  if (input.options.evaluateCodex) {
    args.push("--evaluate-codex");
  }

  const result = await spawnForText(process.execPath, args, 900_000);
  const parsed = parseLastJsonObject(result.stdout);
  const reportPath = parsed?.reportPath;
  const report = typeof reportPath === "string"
    ? JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>
    : undefined;

  return {
    fixtureId: input.fixture.id,
    targetMessageId: input.fixture.targetMessageId,
    pressure: input.fixture.pressure,
    focus: input.fixture.focus,
    artifactDir: typeof parsed?.artifactDir === "string" ? parsed.artifactDir : undefined,
    reportPath: typeof reportPath === "string" ? reportPath : undefined,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    counts: readRecord(report?.counts),
    deterministicComparison: readRecord(report?.deterministicComparison),
    modelEvaluation: report?.modelEvaluation,
    predictedReply: report?.predictedReply,
    error: result.exitCode === 0 ? undefined : result.stderr || result.stdout,
  };
}

function parseArgs(args: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    fixtureFile: "fixtures/persona-replay/metacrat.json",
    outRoot: ".voidbot/artifacts/persona-replay-suite",
    runCodex: false,
    evaluateCodex: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--fixture-file" && next) {
      options.fixtureFile = next;
      index += 1;
    } else if (arg === "--fixture" && next) {
      options.fixtureId = next;
      index += 1;
    } else if (arg === "--out" && next) {
      options.outRoot = next;
      index += 1;
    } else if (arg === "--limit" && next) {
      options.limit = parseNonNegativeInt(next, "--limit");
      index += 1;
    } else if (arg === "--run-codex") {
      options.runCodex = true;
    } else if (arg === "--evaluate-codex") {
      options.evaluateCodex = true;
      options.runCodex = true;
    } else if (arg === "--help") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return {
    fixtureFile: resolve(options.fixtureFile ?? "fixtures/persona-replay/metacrat.json"),
    fixtureId: options.fixtureId,
    outRoot: resolve(options.outRoot ?? ".voidbot/artifacts/persona-replay-suite"),
    runCodex: options.runCodex ?? false,
    evaluateCodex: options.evaluateCodex ?? false,
    limit: options.limit,
  };
}

function printHelpAndExit(): never {
  console.log([
    "Usage: npm run persona:replay-fixtures -- [options]",
    "",
    "Runs a data-driven Metacrat replay fixture suite through scripts/replay-metacrat-thread.ts.",
    "",
    "Options:",
    "  --fixture-file <path>  Fixture JSON. Defaults to fixtures/persona-replay/metacrat.json",
    "  --fixture <id>         Run one fixture id",
    "  --limit <n>            Run at most n fixtures from the selected set",
    "  --out <dir>            Artifact root. Defaults to .voidbot/artifacts/persona-replay-suite",
    "  --run-codex            Generate predictions",
    "  --evaluate-codex       Generate predictions and model evaluations",
  ].join("\n"));
  process.exit(0);
}

function parseNonNegativeInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function spawnForText(command: string, args: string[], timeoutMs: number): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolvePromise({ stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, exitCode, timedOut: false });
    });
  });
}

function parseLastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] !== "{") {
      continue;
    }
    const candidate = trimmed.slice(index);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // Keep scanning for the JSON object printed by the child harness.
    }
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
