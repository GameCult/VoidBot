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
const promptsRoot = resolve(repoRoot, "prompts");
const defaultFacePrompt = resolve(repoRoot, ".voidbot", "artifacts", "interpreter-projections", "nibu-full-character-prompt.md");
const defaultOut = resolve(repoRoot, ".voidbot", "status", "repo-face-interpreter-loop-smoke.json");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const faceModel = options["face-model"] ?? process.env.REPO_FACE_TURN_CODEX_MODEL ?? "gpt-5.4";
  const interpreterModelCandidates = modelCandidatesFromOptions(options);
  const interpreterModel = interpreterModelCandidates.join(",");
  const reasoningEffort = options["reasoning-effort"] ?? process.env.REPO_FACE_HEARTBEAT_CODEX_REASONING_EFFORT ?? "low";
  const facePromptPath = resolve(repoRoot, options["face-prompt"] ?? defaultFacePrompt);
  const outPath = resolve(repoRoot, options.out ?? defaultOut);
  const facePrompt = await readFile(facePromptPath, "utf8");
  const childLogPath = resolve(repoRoot, ".voidbot", "status", "mock-mcp", `interpreter-loop-child-${Date.now()}.jsonl`);
  await rm(childLogPath, { force: true }).catch(() => undefined);

  const childRun = await runCodexWithModelFallback(facePrompt, {
    models: [faceModel],
    reasoningEffort,
    scenarioId: "nibu_interpreter_loop_child",
    logPath: childLogPath,
    useMockMcp: true,
  });
  const childEvents = parseJsonEvents(childRun.stdout);
  const childText = extractFinalText(childEvents, childRun.stdout);
  const childTools = (await readToolCalls(childLogPath)).map((call) => call.tool);

  const interpreterPrompt = renderTemplate("repo-face-turn-interpreter.prompt.md", {
    attempt: "1",
    facePrompt,
    faceOutput: childText,
  });
  const interpreterRun = await runCodexWithModelFallback(interpreterPrompt, {
    models: interpreterModelCandidates,
    reasoningEffort,
    scenarioId: "nibu_interpreter_loop_parent",
    logPath: undefined,
    useMockMcp: false,
  });
  const interpreterEvents = parseJsonEvents(interpreterRun.stdout);
  const interpreterText = extractFinalText(interpreterEvents, interpreterRun.stdout);
  const failures = [
    ...evaluateChild({ run: childRun, text: childText, tools: childTools }),
    ...evaluateInterpreter({ run: interpreterRun, text: interpreterText }),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    faceModel,
    interpreterModel,
    reasoningEffort,
    facePromptPath,
    passed: failures.length === 0,
    failures,
    child: {
      exitCode: childRun.code,
      signal: childRun.signal,
      durationMs: childRun.durationMs,
      tools: childTools,
      text: childText,
      stderrTail: childRun.stderr.slice(-2000),
    },
    interpreter: {
      exitCode: interpreterRun.code,
      signal: interpreterRun.signal,
      durationMs: interpreterRun.durationMs,
      text: interpreterText,
      parsed: parseInterpreterOutput(interpreterText),
      stderrTail: interpreterRun.stderr.slice(-2000),
    },
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outPath,
    faceModel,
    interpreterModel,
    reasoningEffort,
    passed: report.passed,
    failures,
    childTools,
    childText,
    interpreterText,
  }, null, 2)}\n`);

  if (!report.passed) {
    process.exitCode = 1;
  }
}

function evaluateChild(input) {
  const failures = [];
  if (input.run.code !== 0) {
    failures.push(`child codex exited with ${input.run.code ?? input.run.signal ?? "unknown"}`);
  }
  if (!input.tools.some((tool) => ["search_sources", "get_source_context", "search_history", "get_message_context"].includes(tool))) {
    failures.push("child did not use repo/archive search tools during a due jurisdiction-dive turn");
  }
  if (input.text.length < 160) {
    failures.push("child output is too short to judge as a character turn");
  }
  for (const forbidden of ["repo-face heartbeat", "heartbeat from", "as an ai language model", "INTERPRETATION"]) {
    if (input.text.toLowerCase().includes(forbidden)) {
      failures.push(`child output contains robotic/provenance phrase: ${forbidden}`);
    }
  }
  if (!/(private thought|would say|bifrost|proposal|aetheria|nibu|residue|parallax|continuity)/i.test(input.text)) {
    failures.push("child output does not visibly inhabit Nibu/Aetheria context");
  }
  if (claimsSourceInspection(input.text) && !input.tools.some((tool) => ["search_sources", "get_source_context", "search_history", "get_message_context"].includes(tool))) {
    failures.push("child claimed source/archive inspection without using search/context tools");
  }
  return failures;
}

function claimsSourceInspection(text) {
  return /\b(checked|read|inspected|searched|verified|looked at|looked up)\b[\s\S]{0,140}\b(real text|source|sources|repo|archive|history|AetheriaLore|Aetheria\/|Terminus|Parallax|Nibu\.md)\b/i.test(text);
}

function evaluateInterpreter(input) {
  const failures = [];
  if (input.run.code !== 0) {
    failures.push(`interpreter codex exited with ${input.run.code ?? input.run.signal ?? "unknown"}`);
  }
  const parsed = parseInterpreterOutput(input.text);
  if (!parsed.decision) {
    failures.push("interpreter did not emit an INTERPRETATION decision");
  }
  if (parsed.decision === "retry" || parsed.decision === "drop") {
    failures.push(`interpreter chose ${parsed.decision}: ${parsed.reason ?? "no reason"}`);
  }
  if (parsed.decision === "route" && parsed.blocks.length === 0) {
    failures.push("interpreter routed but emitted no STATE NOTE, SAY, or BIFROST TOPIC blocks");
  }
  if (!parsed.blocks.some((block) => block.kind === "STATE NOTE")) {
    failures.push("interpreter did not preserve any durable state note");
  }
  if (mentionsSocialPressure(input.text) && !parsed.blocks.some((block) => block.kind === "STATE NOTE" && ["bond", "status"].includes(String(block.fields.kind ?? "").trim()))) {
    failures.push("interpreter did not preserve social pressure as a bond/status STATE NOTE");
  }
  for (const block of parsed.blocks) {
    if (block.kind === "STATE NOTE" && !hasUsefulStateNote(block.fields)) {
      failures.push("STATE NOTE lacks meaningful summary plus claim/tension/action");
    }
    if (block.kind === "SAY" && !String(block.fields.content ?? "").trim()) {
      failures.push("SAY block has no content");
    }
    if (block.kind === "BIFROST TOPIC" && !String(block.fields.content ?? "").trim()) {
      failures.push("BIFROST TOPIC block has no content");
    }
  }
  return failures;
}

function hasUsefulStateNote(fields) {
  return Boolean(
    String(fields.summary ?? "").trim() &&
    [fields.claim, fields.tension, fields.action, fields.question].some((value) => String(value ?? "").trim()),
  );
}

function mentionsSocialPressure(text) {
  return (
    /\b(pamper(?:ed|ing)?|tease|rivalry|trust|admire|needle|friendship|protect(?:ive|ion)?|envy|resent|jealous|bypass(?:ed)?|consult(?:ed)?|favorite|neglect(?:ed)?|attention|approval|status|bond)\b/i.test(text) ||
    /\b(Metacrat|Aqua|Bifrost|Mimir|Libby|Epiphany|Heimdall|swarm)\b[\s\S]{0,120}\b(tease|trust|rivalry|friend|jealous|resent|admire|consult|neglect|status|bond)\b/i.test(text)
  );
}

async function runCodexWithModelFallback(prompt, input) {
  let lastRun;
  for (const [index, model] of input.models.entries()) {
    const run = await runCodex(prompt, {
      ...input,
      model,
    });
    lastRun = run;
    if (run.code === 0 || index === input.models.length - 1 || !isRetryableModelFailure(run)) {
      return {
        ...run,
        model,
        attemptedModels: input.models.slice(0, index + 1),
      };
    }
  }
  return lastRun;
}

function isRetryableModelFailure(run) {
  const text = `${run.stdout}\n${run.stderr}`.toLowerCase();
  return (
    text.includes("usage limit") ||
    text.includes("rate limit") ||
    text.includes("capacity") ||
    text.includes("temporarily unavailable") ||
    text.includes("try again")
  );
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
    if (input.useMockMcp) {
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

function modelCandidatesFromOptions(options) {
  const explicit = options.model ?? options.models;
  const raw =
    explicit ??
    process.env.REPO_FACE_HEARTBEAT_CODEX_MODELS ??
    process.env.REPO_FACE_HEARTBEAT_CODEX_MODEL ??
    "gpt-5.3-codex-spark,gpt-5.4-mini";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);
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

function renderTemplate(name, variables) {
  let template = readFileSync(resolve(promptsRoot, name), "utf8");
  for (const [key, value] of Object.entries(variables)) {
    template = template.replaceAll(`{{${key}}}`, String(value));
  }
  return template;
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
