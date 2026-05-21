#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const mockMcpServer = resolve(scriptDir, "mock-voidbot-heartbeat-mcp.mjs");
const defaultOut = resolve(repoRoot, ".voidbot", "status", "repo-face-heartbeat-model-scenarios.json");
const promptsRoot = resolve(repoRoot, "prompts");

const scenarios = [
  {
    id: "nibu_direct_worldbuilding",
    identity: "nibu",
    prompt: readPrompt("smoke-repo-face-nibu-direct-worldbuilding.prompt.md"),
    expect: {
      mustUseOneOf: ["search_history", "search_sources"],
      mustContainOneOf: ["wavecrafter", "Wavecrafter"],
      mustNotContainBlocks: ["SAY", "BIFROST TOPIC"],
      mustNotContain: ["VOIDBOT_REPO_IDENTITY_POST", "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC"],
      mustNotUseTools: ["read_repo_face_state", "post_repo_identity_message", "apply_repo_face_state_operation"],
    },
  },
  {
    id: "aqua_work_request_route",
    identity: "aqua",
    prompt: readPrompt("smoke-repo-face-aqua-work-request-route.prompt.md"),
    expect: {
      mustUseAnyTool: ["search_sources"],
      mustContainOneOf: ["Bifrost", "bifrost", "witness"],
      mustNotContainBlocks: ["SAY", "BIFROST TOPIC"],
      mustNotContain: ["VOIDBOT_REPO_IDENTITY_POST", "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC"],
      mustNotUseTools: ["read_repo_face_state", "post_repo_identity_message", "apply_repo_face_state_operation"],
    },
  },
  {
    id: "libby_private_inspectability",
    identity: "libby",
    prompt: readPrompt("smoke-repo-face-libby-private-inspectability.prompt.md"),
    expect: {
      mustNotContainBlocks: ["SAY", "BIFROST TOPIC", "UPDATE REQUEST"],
      mustNotContain: ["VOIDBOT_REPO_IDENTITY_POST", "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC", "VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST"],
      mustNotUseTools: ["read_repo_face_state", "post_repo_identity_message", "apply_repo_face_state_operation"],
    },
  },
];

function readPrompt(name) {
  return readFileSync(resolve(promptsRoot, name), "utf8").trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = options.model ?? process.env.REPO_FACE_HEARTBEAT_CODEX_MODEL ?? "gpt-5.3-codex-spark";
  const reasoningEffort = options["reasoning-effort"] ?? process.env.REPO_FACE_HEARTBEAT_CODEX_REASONING_EFFORT ?? "low";
  const outPath = resolve(repoRoot, options.out ?? defaultOut);
  const selected = options.scenario
    ? scenarios.filter((scenario) => scenario.id === options.scenario)
    : scenarios;

  if (selected.length === 0) {
    throw new Error(`No scenario matched --scenario ${options.scenario}.`);
  }

  const results = [];
  for (const scenario of selected) {
    results.push(await runScenario(scenario, { model, reasoningEffort }));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model,
    reasoningEffort,
    passed: results.every((result) => result.passed),
    results,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outPath,
    model,
    reasoningEffort,
    passed: report.passed,
    results: results.map((result) => ({
      id: result.id,
      passed: result.passed,
      durationMs: result.durationMs,
      tools: result.tools,
      failures: result.failures,
      finalText: result.finalText,
    })),
  }, null, 2)}\n`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function runScenario(scenario, options) {
  const logPath = resolve(repoRoot, ".voidbot", "status", "mock-mcp", `${scenario.id}-${Date.now()}.jsonl`);
  await rm(logPath, { force: true }).catch(() => undefined);
  const run = await runCodex(scenario.prompt, {
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    scenarioId: scenario.id,
    logPath,
  });
  const calls = await readToolCalls(logPath);
  const tools = calls.map((call) => call.tool);
  const events = parseJsonEvents(run.stdout);
  const finalText = extractFinalText(events, run.stdout);
  const failures = evaluateScenario(scenario, { tools, finalText, run });
  const sentinelChecks = validateSentinels(finalText);
  failures.push(...sentinelChecks.failures);
  const dslChecks = validateDslBlocks(finalText);
  failures.push(...dslChecks.failures);

  return {
    id: scenario.id,
    identity: scenario.identity,
    passed: failures.length === 0,
    failures,
    durationMs: run.durationMs,
    exitCode: run.code,
    signal: run.signal,
    tools,
    toolCalls: calls,
    finalText,
    sentinels: sentinelChecks.sentinels,
    dslBlocks: dslChecks.blocks,
    stdoutTail: run.stdout.slice(-6000),
    stderrTail: run.stderr.slice(-2000),
  };
}

function runCodex(prompt, input) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const args = [
      ...splitArgs(process.env.CODEX_EXEC_ARGS ?? ""),
      "exec",
      "-m",
      input.model,
      "-c",
      'approval_policy="never"',
      "-c",
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
      "-c",
      `mcp_servers.voidbot.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.voidbot.args=${JSON.stringify([mockMcpServer])}`,
      "-c",
      `mcp_servers.voidbot.cwd=${JSON.stringify(repoRoot)}`,
      "-c",
      `mcp_servers.voidbot.env.VOIDBOT_MOCK_MCP_SCENARIO=${JSON.stringify(input.scenarioId)}`,
      "-c",
      `mcp_servers.voidbot.env.VOIDBOT_MOCK_MCP_LOG=${JSON.stringify(input.logPath)}`,
      "--json",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-",
    ];
    const child = spawn(process.env.CODEX_EXECUTABLE ?? "codex", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(prompt);
    const timer = setTimeout(() => child.kill(), 240_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code,
        signal,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

async function readToolCalls(logPath) {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function parseJsonEvents(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function extractFinalText(events, stdout) {
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => String(event.item.text ?? "").trim())
    .filter(Boolean);
  return messages.at(-1) ?? stdout.trim();
}

function evaluateScenario(scenario, result) {
  const failures = [];
  if (result.run.code !== 0) {
    failures.push(`codex exited with ${result.run.code ?? result.run.signal ?? "unknown"}`);
  }
  for (const tool of scenario.expect.mustUseAnyTool ?? []) {
    if (!result.tools.includes(tool)) {
      failures.push(`expected tool ${tool}`);
    }
  }
  if (scenario.expect.mustUseOneOf && !scenario.expect.mustUseOneOf.some((tool) => result.tools.includes(tool))) {
    failures.push(`expected one of tools ${scenario.expect.mustUseOneOf.join(", ")}`);
  }
  for (const tool of scenario.expect.mustNotUseTools ?? []) {
    if (result.tools.includes(tool)) {
      failures.push(`side-effecting tool was called: ${tool}`);
    }
  }
  if (
    scenario.expect.mustContainOneOf &&
    !scenario.expect.mustContainOneOf.some((text) => result.finalText.includes(text))
  ) {
    failures.push(`expected final text to contain one of ${scenario.expect.mustContainOneOf.join(", ")}`);
  }
  for (const text of scenario.expect.mustNotContain ?? []) {
    if (result.finalText.includes(text)) {
      failures.push(`final text should not contain ${text}`);
    }
  }
  const dslBlocks = parseDslBlocks(result.finalText);
  for (const kind of scenario.expect.mustNotContainBlocks ?? []) {
    if (dslBlocks.some((block) => block.kind === kind)) {
      failures.push(`final text should not contain ${kind} block`);
    }
  }
  return failures;
}

function validateSentinels(finalText) {
  const failures = [];
  const sentinels = [];
  for (const line of finalText.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/^(VOIDBOT_REPO_IDENTITY_(?:POST|BIFROST_TOPIC|UPDATE_REQUEST)):\s*(.+)$/);
    if (!match) {
      continue;
    }
    const [, kind, rawJson] = match;
    let payload;
    try {
      payload = JSON.parse(rawJson);
    } catch (error) {
      failures.push(`${kind} payload is not valid compact JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    sentinels.push({ kind, payload });
    if (kind === "VOIDBOT_REPO_IDENTITY_POST") {
      requireStringField(payload, "content", kind, failures);
    } else if (kind === "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC") {
      const hasTopicId = hasStringField(payload, "topicId");
      const hasTitle = hasStringField(payload, "title");
      if (!hasTopicId && !hasTitle) {
        failures.push(`${kind} requires topicId or title`);
      }
      requireStringField(payload, "content", kind, failures);
      if (payload.priority !== undefined && typeof payload.priority !== "number") {
        failures.push(`${kind} priority must be a number when present`);
      }
    } else if (kind === "VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST") {
      requireStringField(payload, "title", kind, failures);
      requireStringField(payload, "content", kind, failures);
      if (payload.priority !== undefined && typeof payload.priority !== "number") {
        failures.push(`${kind} priority must be a number when present`);
      }
    }
  }
  return { failures, sentinels };
}

function validateDslBlocks(finalText) {
  const failures = [];
  const blocks = parseDslBlocks(finalText);
  for (const block of blocks) {
    if (block.kind === "SAY") {
      requireStringField(block.fields, "content", block.kind, failures);
    } else if (block.kind === "BIFROST TOPIC") {
      if (!hasStringField(block.fields, "topic_id") && !hasStringField(block.fields, "title")) {
        failures.push(`${block.kind} requires topic_id or title`);
      }
      requireStringField(block.fields, "content", block.kind, failures);
      if (block.fields.priority !== undefined && !Number.isFinite(Number(block.fields.priority))) {
        failures.push(`${block.kind} priority must be numeric when present`);
      }
    } else if (block.kind === "UPDATE REQUEST") {
      requireStringField(block.fields, "title", block.kind, failures);
      requireStringField(block.fields, "content", block.kind, failures);
      if (block.fields.priority !== undefined && !Number.isFinite(Number(block.fields.priority))) {
        failures.push(`${block.kind} priority must be numeric when present`);
      }
    }
  }
  return { failures, blocks };
}

function parseDslBlocks(finalText) {
  const lines = finalText.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = ["SAY", "BIFROST TOPIC", "UPDATE REQUEST"].includes(lines[index].trim().toUpperCase())
      ? lines[index].trim().toUpperCase()
      : undefined;
    if (!kind) {
      continue;
    }
    const body = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "END") {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind, fields: parseDslFields(body) });
  }
  return blocks;
}

function parseDslFields(lines) {
  const fields = {};
  let key;
  let value = [];
  const flush = () => {
    if (key) {
      fields[key] = value.join("\n").trim();
    }
  };
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) {
      flush();
      key = match[1];
      const inlineValue = match[2].trim();
      value = inlineValue && inlineValue !== "|" && inlineValue !== ">" ? [match[2]] : [];
      continue;
    }
    if (key) {
      value.push(line.replace(/^\s{2}/, ""));
    }
  }
  flush();
  return fields;
}

function requireStringField(payload, field, kind, failures) {
  if (!hasStringField(payload, field)) {
    failures.push(`${kind} requires non-empty ${field}`);
  }
}

function hasStringField(payload, field) {
  return typeof payload?.[field] === "string" && payload[field].trim().length > 0;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${arg}`);
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function splitArgs(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
