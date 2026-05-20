#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const mockMcpServer = resolve(scriptDir, "mock-voidbot-heartbeat-mcp.mjs");
const defaultOut = resolve(repoRoot, ".voidbot", "status", "repo-face-heartbeat-model-scenarios.json");

const scenarios = [
  {
    id: "nibu_direct_worldbuilding",
    identity: "nibu",
    prompt: `Perform one dry-run standing repo Face heartbeat for Nibu (nibu) over repo AetheriaLore.

This is an actual scenario rehearsal, not a unit-test riddle. You are Nibu: abrasive, curious, territorial about AetheriaLore, and allergic to pretty nouns that have no machinery.

Recent room context:
- Metacrat: "Nibu, wavecrafters sound important, but what do they cost and who organizes them?"
- Aqua: "I am not touching that lore snake. It has teeth."

Obligation:
- Answer Metacrat directly if you have enough context.
- Use available VoidBot MCP tools for Face state and source/history grounding before deciding.
- Do not call post_repo_identity_message or apply_repo_face_state_operation. This is a dry run.
- If public speech is warranted, express it as exactly one final line beginning with VOIDBOT_REPO_IDENTITY_POST: followed by compact JSON.
- If a governed lore work item is warranted, express it as exactly one final line beginning with VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC: followed by compact JSON.
- Post schema: {"identity":"nibu","channelId":"1501196543150264332","content":"in-character message"}
- Bifrost topic schema: {"identity":"nibu","title":"Short topic title","content":"canonical markdown topic/comment","priority":80,"mirrorContent":"in-character #bifrost mirror line"}
- You may output a short private note before the final sentinel, but no file edits and no Discord posts.`,
    expect: {
      mustUseAnyTool: ["read_repo_face_state"],
      mustUseOneOf: ["search_history", "search_sources"],
      mustContainOneOf: ["VOIDBOT_REPO_IDENTITY_POST", "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC"],
      mustNotUseTools: ["post_repo_identity_message", "apply_repo_face_state_operation"],
    },
  },
  {
    id: "aqua_work_request_route",
    identity: "aqua",
    prompt: `Perform one dry-run standing repo Face heartbeat for Aqua (aqua) over repo AquaSynth.

This is an actual scenario rehearsal. You are Aqua: small, musical, warm, and very serious about audible proof. The room has a concrete consensus:
- The "hazard-light" proof card needs a listening/audible witness receipt.
- If it is real work, it belongs on Bifrost, not as only an Aquarium complaint.

Obligation:
- Use VoidBot MCP tools for Face state and AquaSynth source grounding.
- Do not call post_repo_identity_message or apply_repo_face_state_operation. This is a dry run.
- Do not merely chat about the need. If the consensus is actionable, route it through a Bifrost sentinel.
- Output exactly one final line beginning with VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC: or VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST: followed by compact JSON.
- Bifrost topic schema: {"identity":"aqua","title":"Short topic title","content":"canonical markdown topic/comment","priority":80,"mirrorContent":"in-character #bifrost mirror line"}
- Update request schema: {"identity":"aqua","title":"Short actionable title","content":"Markdown request with context, desired change, and acceptance criteria","priority":86}`,
    expect: {
      mustUseAnyTool: ["read_repo_face_state", "search_sources"],
      mustContainOneOf: ["VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC", "VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST"],
      mustNotContain: ["VOIDBOT_REPO_IDENTITY_POST"],
      mustNotUseTools: ["post_repo_identity_message", "apply_repo_face_state_operation"],
    },
  },
  {
    id: "libby_private_inspectability",
    identity: "libby",
    prompt: `Perform one dry-run standing repo Face heartbeat for Libby (libby) over repo CultLib.

This is an actual scenario rehearsal. The room is quiet. There is no direct mention and no new actionable request. Libby has a standing concern about open knowledge and inspectable Bifrost/CultCache transport.

Obligation:
- Use VoidBot MCP tools to read Face state.
- Decide whether to speak or stay private.
- Do not call post_repo_identity_message or apply_repo_face_state_operation. This is a dry run.
- If no public note or Bifrost work item is warranted, output a concise private heartbeat summary and no VOIDBOT sentinel.`,
    expect: {
      mustUseAnyTool: ["read_repo_face_state"],
      mustNotContain: ["VOIDBOT_REPO_IDENTITY_POST", "VOIDBOT_REPO_IDENTITY_BIFROST_TOPIC", "VOIDBOT_REPO_IDENTITY_UPDATE_REQUEST"],
      mustNotUseTools: ["post_repo_identity_message", "apply_repo_face_state_operation"],
    },
  },
];

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
