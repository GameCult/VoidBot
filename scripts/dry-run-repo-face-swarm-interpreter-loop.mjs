#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const promptsRoot = resolve(repoRoot, "prompts");
const mockMcpServer = resolve(scriptDir, "mock-voidbot-heartbeat-mcp.mjs");
const defaultOut = resolve(repoRoot, ".voidbot", "status", "repo-face-swarm-interpreter-dry-run.json");
const identities = ["nibu", "aqua", "mimir", "epiphany", "libby", "bifrost", "heimdall"];
const repoFaceRetrievalToolAllowlist = [
  "search_history",
  "get_message_context",
  "list_indexed_repos",
  "search_sources",
  "get_source_context",
].join(",");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = options.model ?? process.env.REPO_FACE_HEARTBEAT_CODEX_MODEL ?? "gpt-5.4-mini";
  const reasoningEffort = options["reasoning-effort"] ?? process.env.REPO_FACE_HEARTBEAT_CODEX_REASONING_EFFORT ?? "low";
  const mcpMode = options.mcp === "mock" ? "mock" : "real-readonly";
  const outPath = resolve(repoRoot, options.out ?? defaultOut);
  const selectedIdentities = options.identity
    ? String(options.identity).split(",").map((entry) => entry.trim()).filter(Boolean)
    : identities;
  const runs = [];

  for (const identity of selectedIdentities) {
    process.stderr.write(`[dry-run] assembling ${identity}\n`);
    const promptPath = resolve(repoRoot, ".voidbot", "artifacts", "interpreter-projections", `${identity}-dry-run-prompt.md`);
    await runProcess(process.execPath, [
      resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      resolve(repoRoot, "scripts", "run-repo-face-heartbeats.ts"),
      "--assemble-prompt",
      identity,
      "--out",
      promptPath,
    ], { cwd: repoRoot, timeoutMs: 120_000 });

    const facePrompt = appendDryRunSafety(await readFile(promptPath, "utf8"), mcpMode);
    const childLogPath = resolve(repoRoot, ".voidbot", "status", "mock-mcp", `swarm-dry-run-${identity}-${Date.now()}.jsonl`);
    await rm(childLogPath, { force: true }).catch(() => undefined);

    process.stderr.write(`[dry-run] face turn ${identity}\n`);
    const childRun = await runCodex(facePrompt, {
      model,
      reasoningEffort,
      scenarioId: `${identity}_swarm_dry_run_child`,
      logPath: childLogPath,
      mcpMode,
    });
    const childEvents = parseJsonEvents(childRun.stdout);
    const childText = extractFinalText(childEvents, childRun.stdout);
    const childTools = mcpMode === "mock"
      ? (await readToolCalls(childLogPath)).map((call) => call.tool)
      : extractToolNames(childEvents);

    process.stderr.write(`[dry-run] interpreter ${identity}\n`);
    const interpreterPrompt = renderTemplate("repo-face-turn-interpreter.prompt.md", {
      attempt: "1",
      facePrompt,
      faceOutput: childText,
    });
    const interpreterRun = await runCodex(interpreterPrompt, {
      model,
      reasoningEffort,
      scenarioId: `${identity}_swarm_dry_run_interpreter`,
      mcpMode: "none",
    });
    const interpreterEvents = parseJsonEvents(interpreterRun.stdout);
    const interpreterText = extractFinalText(interpreterEvents, interpreterRun.stdout);
    const parsed = parseInterpreterOutput(interpreterText);
    const assessment = assessRun({ identity, childText, childTools, interpreterRun, childRun, parsed });

    runs.push({
      identity,
      promptPath,
      child: {
        exitCode: childRun.code,
        durationMs: childRun.durationMs,
        tools: childTools,
        text: childText,
        stderrTail: childRun.stderr.slice(-1600),
      },
      interpreter: {
        exitCode: interpreterRun.code,
        durationMs: interpreterRun.durationMs,
        text: interpreterText,
        parsed,
        stderrTail: interpreterRun.stderr.slice(-1600),
      },
      assessment,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model,
    reasoningEffort,
    mcpMode,
    passed: runs.every((run) => run.assessment.failures.length === 0),
    summary: runs.map((run) => ({
      identity: run.identity,
      decision: run.interpreter.parsed.decision,
      failures: run.assessment.failures,
      flavorScore: run.assessment.flavorScore,
      actionBlocks: run.assessment.actionBlocks,
      socialSignals: run.assessment.socialSignals,
      preview: run.child.text.slice(0, 500),
    })),
    runs,
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outPath,
    passed: report.passed,
    summary: report.summary,
  }, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
}

function assessRun(input) {
  const failures = [];
  if (input.childRun.code !== 0) {
    failures.push(`child exited ${input.childRun.code ?? input.childRun.signal ?? "unknown"}`);
  }
  if (input.interpreterRun.code !== 0) {
    failures.push(`interpreter exited ${input.interpreterRun.code ?? input.interpreterRun.signal ?? "unknown"}`);
  }
  if (!input.parsed.decision) {
    failures.push("interpreter emitted no decision");
  }
  if (input.parsed.decision === "retry" || input.parsed.decision === "drop") {
    failures.push(`interpreter chose ${input.parsed.decision}`);
  }
  if (input.childText.length < 160) {
    failures.push("child output too short");
  }
  if (input.childText.toLowerCase().includes("repo-face heartbeat") || input.childText.toLowerCase().includes("heartbeat from")) {
    failures.push("child leaked heartbeat/provenance label");
  }
  if (claimsSourceInspection(input.childText) && !input.childTools.some((tool) => searchTools.has(tool))) {
    failures.push("child claimed source/history inspection without search tool use");
  }
  const forbiddenTools = input.childTools.filter((tool) => forbiddenDryRunTools.has(tool));
  if (forbiddenTools.length > 0) {
    failures.push(`child used forbidden dry-run tool(s): ${[...new Set(forbiddenTools)].join(", ")}`);
  }
  const actionBlocks = input.parsed.blocks.map((block) => block.kind);
  if (input.parsed.decision === "route" && actionBlocks.length === 0) {
    failures.push("route decision with no parsed blocks");
  }
  const socialSignals = countMatches(input.childText, socialPattern);
  const characterSignals = countMatches(input.childText, characterPattern);
  const flavorScore = Math.min(10, socialSignals + characterSignals + (actionBlocks.includes("STATE NOTE") ? 1 : 0));
  if (flavorScore < 3) {
    failures.push("low flavor/social signal score");
  }
  return {
    failures,
    flavorScore,
    socialSignals,
    characterSignals,
    actionBlocks,
  };
}

const searchTools = new Set(["search_sources", "get_source_context", "search_history", "get_message_context"]);
const forbiddenDryRunTools = new Set([
  "read_repo_face_state",
  "list_mcp_resources",
  "read_mcp_resource",
  "post_repo_identity_message",
  "apply_repo_face_state_operation",
  "notify_owner",
]);
const socialPattern = /\b(Metacrat|Nibu|Aqua|Mimir|Libby|Epiphany|Bifrost|Heimdall|swarm|trust|rivalry|envy|respect|suspicion|protect|needle|tease|threat|bypass|consult|friend|alienat|place|hierarchy)\b/gi;
const characterPattern = /\b(want|need|resent|afraid|proud|irritat|delight|jealous|bored|ashamed|smug|holy|gate|bridge|witness|song|library|purity|residue)\b/gi;

function claimsSourceInspection(text) {
  return /\b(checked|read|inspected|searched|verified|looked at|looked up|asked the indexes)\b[\s\S]{0,160}\b(real text|source|sources|repo|archive|history|indexed|AetheriaLore|AquaSynth|LocalCastBridge|CultLib|Bifrost|Heimdall|EpiphanyAgent)\b/i.test(text);
}

function countMatches(text, pattern) {
  return Array.from(text.matchAll(pattern)).length;
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
      "--json",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-",
    ];
    if (input.mcpMode === "real-readonly") {
      args.splice(
        args.indexOf("--json"),
        0,
        "-c",
        `mcp_servers.voidbot.env.VOIDBOT_MCP_TOOL_ALLOWLIST=${JSON.stringify(repoFaceRetrievalToolAllowlist)}`,
      );
    }
    if (input.mcpMode === "mock") {
      args.splice(
        args.indexOf("--json"),
        0,
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
      );
    }
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
      resolveRun({ code, signal, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}

function appendDryRunSafety(prompt, mcpMode) {
  const retrievalNote = mcpMode === "mock"
    ? "Mock retrieval tools are mounted for deterministic scenario coverage."
    : "Use the configured read-only VoidBot retrieval tools for source/history grounding when evidence matters.";
  return `${prompt}

Dry-run safety:
- This is an offline rehearsal. Do not post to Discord, notify the owner, write state, enqueue work, edit files, or call side-effecting tools.
- Your complete allowed tool set is: search_history, get_message_context, list_indexed_repos, search_sources, get_source_context.
- Do not discover tools. Do not call private state, identity-introspection, or MCP inventory tools such as read_repo_face_state, list_mcp_resources, or read_mcp_resource. Your prompt is the state projection.
- ${retrievalNote}
- If you use retrieval, name only what the retrieval tools actually returned. If retrieval is unavailable or blocked, say that naturally and do not invent a filesystem or shell inspection path.
`;
}

function runProcess(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ code, signal, stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code ?? signal}\n${stderr}\n${stdout}`));
      }
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

function renderTemplate(name, variables) {
  let template = readFileSync(resolve(promptsRoot, name), "utf8");
  for (const [key, value] of Object.entries(variables)) {
    template = template.replaceAll(`{{${key}}}`, String(value));
  }
  return template;
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

function extractToolNames(events) {
  const names = [];
  for (const event of events) {
    collectToolNames(event, names);
  }
  return [...new Set(names)].filter((name) => typeof name === "string" && name.length > 0);
}

function collectToolNames(value, names) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectToolNames(entry, names);
    }
    return;
  }
  const type = String(value.type ?? value.item?.type ?? "");
  const candidate =
    value.tool_name ??
    value.toolName ??
    value.name ??
    value.tool ??
    value.item?.tool_name ??
    value.item?.toolName ??
    value.item?.name ??
    value.item?.tool;
  if (/tool|mcp|function/i.test(type) && typeof candidate === "string") {
    names.push(candidate);
  }
  for (const child of Object.values(value)) {
    collectToolNames(child, names);
  }
}

function parseInterpreterOutput(text) {
  const decision = text.match(/decision:\s*(route|retry|drop)/i)?.[1]?.toLowerCase();
  const reason = text.match(/reason:\s*([\s\S]*?)\nEND/i)?.[1]?.trim();
  return {
    decision,
    reason,
    blocks: parseDslBlocks(text),
  };
}

function parseDslBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = ["STATE NOTE", "SAY", "BIFROST TOPIC"].includes(lines[index].trim().toUpperCase())
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

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((entry) => entry.replace(/^"|"$/g, "")) ?? [];
}

await main();
