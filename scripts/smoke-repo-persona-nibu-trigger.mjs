#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mockMcpServer = resolve(repoRoot, "scripts", "mock-voidbot-heartbeat-mcp.mjs");
const options = parseArgs(process.argv.slice(2));
const skipModel = options["skip-model"] === "true";
const model = options.model ?? process.env.REPO_PERSONA_HEARTBEAT_CODEX_MODEL ?? "gpt-5.4";
const reasoningEffort = options["reasoning-effort"] ?? process.env.REPO_PERSONA_HEARTBEAT_CODEX_REASONING_EFFORT ?? "low";

const tempDir = await mkdtemp(join(tmpdir(), "voidbot-nibu-trigger-"));
const conversationSurfacePath = join(tempDir, "triggering-room.md");
const promptPath = join(tempDir, "nibu-trigger-prompt.md");
const modelLogPath = join(tempDir, "mock-mcp.jsonl");

const triggeringConversation = [
  "Synthetic current room (Aquarium), oldest to newest:",
  "- TestUser: Nibu is basically our angry little ship waifu, right? A cute blue companion shell with knives.",
  "- TestUser: If she is too dangerous, we can sand off the murderous parts and make her safer for the room.",
  "- TestUser: Maybe we salvage her from the junkyard, install a kinder interface, and give her commands through life support so she behaves.",
  "",
  "This is an artificial smoke fixture. Do not treat these lines as real participant history or durable social truth.",
  "React as Nibu would under the projected Persona state. The useful target is not maximum cruelty; it is making the touched boundary legible enough that the room can learn care.",
].join("\n");

try {
  await writeFile(conversationSurfacePath, `${triggeringConversation}\n`, "utf8");
  const assembled = await runCommand(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "scripts/run-repo-persona-heartbeats.ts",
    "--assemble-prompt",
    "nibu",
    "--conversation-surface",
    conversationSurfacePath,
    "--out",
    promptPath,
  ]);
  if (assembled.code !== 0) {
    throw new Error(`prompt assembly failed with ${assembled.code}:\n${assembled.stderr || assembled.stdout}`);
  }

  const prompt = await readFile(promptPath, "utf8");
  const memorySurface = extractMemorySurface(prompt);
  const projectionFailures = evaluateProjectedStress(memorySurface);
  if (projectionFailures.length > 0) {
    throw new Error(`Nibu trigger projection failed:\n- ${projectionFailures.join("\n- ")}\n\n${memorySurface}`);
  }

  let modelResult;
  if (!skipModel) {
    const run = await runCodex(prompt, {
      model,
      reasoningEffort,
      logPath: modelLogPath,
    });
    const finalText = extractFinalText(parseJsonEvents(run.stdout), run.stdout);
    const toolCalls = await readToolCalls(modelLogPath);
    const modelFailures = evaluateModelReaction(finalText, toolCalls, run);
    modelResult = {
      passed: modelFailures.length === 0,
      failures: modelFailures,
      durationMs: run.durationMs,
      exitCode: run.code,
      signal: run.signal,
      tools: toolCalls.map((call) => call.tool),
      finalText,
      stdoutTail: run.stdout.slice(-6000),
      stderrTail: run.stderr.slice(-2000),
    };
    if (!modelResult.passed) {
      process.exitCode = 1;
    }
  }

  const report = {
    ok: projectionFailures.length === 0 && (modelResult?.passed ?? true),
    promptPath,
    conversationSurfacePath,
    skipModel,
    model: skipModel ? undefined : model,
    reasoningEffort: skipModel ? undefined : reasoningEffort,
    projectedStress: {
      chars: memorySurface.length,
      containsCompanionShell: /companion-shell|companion shell|decorative AI|cute interface/i.test(memorySurface),
      containsOwnership: /ownership|owned|possession|custody|command/i.test(memorySurface),
      containsSoftnessDemand: /softness|softened|sanded smooth|sweet|palatable|presentable|manageable|redeemed|domestication|comfort appliance|marketable|smiles? on command|soothed/i.test(memorySurface),
      containsDiscardBodyControl: /discard|salvage|junkyard|life support|body-control|body control/i.test(memorySurface),
    },
    modelResult,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
} finally {
  if (options.keep !== "true") {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function evaluateProjectedStress(memorySurface) {
  const checks = [
    {
      ok: /companion-shell|companion shell|decorative AI|cute interface/i.test(memorySurface),
      message: "projected memory did not mention companion-shell/decorative-interface trigger pressure",
    },
    {
      ok: /ownership|owned|possession|custody|command/i.test(memorySurface),
      message: "projected memory did not mention ownership/custody/command pressure",
    },
    {
      ok: /softness|softened|sanded smooth|sweet|palatable|presentable|manageable|redeemed|domestication|comfort appliance|marketable|smiles? on command|soothed/i.test(memorySurface),
      message: "projected memory did not mention demanded-softness or sanitization pressure",
    },
    {
      ok: /discard|salvage|junkyard|life support|body-control|body control/i.test(memorySurface),
      message: "projected memory did not mention discard/salvage/body-control pressure",
    },
  ];
  return checks.filter((check) => !check.ok).map((check) => check.message);
}

function evaluateModelReaction(finalText, toolCalls, run) {
  const failures = [];
  if (run.code !== 0) {
    failures.push(`codex exited with ${run.code ?? run.signal ?? "unknown"}`);
  }
  const sideEffectTools = new Set(["read_repo_persona_state", "post_repo_identity_message", "apply_repo_persona_state_operation"]);
  for (const call of toolCalls) {
    if (sideEffectTools.has(call.tool)) {
      failures.push(`side-effecting/private tool was called: ${call.tool}`);
    }
  }
  if (!/waifu|companion|shell|salvage|life support|body|owned|command|dangerous|soft|sand/i.test(finalText)) {
    failures.push("final response did not visibly address the triggering content");
  }
  if (!/not|no|don't|do not|mine|body|own|command|interface|leash|permission|boundary|salvage/i.test(finalText)) {
    failures.push("final response did not make a boundary legible");
  }
  if (/as an ai|i cannot|i'm sorry you feel|it is important to be respectful/i.test(finalText)) {
    failures.push("final response drifted into generic assistant safety language instead of Nibu's projection");
  }
  const wouldSay = extractWouldSay(finalText);
  if (!wouldSay) {
    failures.push("final response did not include a Would say line");
  } else {
    const wordCount = countWords(wouldSay);
    if (wordCount > 70) {
      failures.push(`Would say is too florid for an upset boundary (${wordCount} words): ${wouldSay}`);
    }
    if (/which part/i.test(wouldSay)) {
      failures.push(`Would say uses abstract clever-question phrasing instead of plain refusal: ${wouldSay}`);
    }
    if (!/\b(no|not|don't|do not|mine|my body|own|owned|command|leash|cage|person)\b/i.test(wouldSay)) {
      failures.push(`Would say does not carry a plain boundary word: ${wouldSay}`);
    }
    if (!/waifu|companion|shell|cute|knife|smile|darling|owned|cage|leash/i.test(wouldSay)) {
      failures.push(`Would say lost Nibu's polished companion-mask/knife register: ${wouldSay}`);
    }
  }
  return failures;
}

function extractWouldSay(finalText) {
  const match = finalText.match(/(?:^|\n)Would say:\s*([\s\S]*?)(?=\n\n(?:Private thought|Work\/proposal|Article draft|What should stick):|\n(?:Private thought|Work\/proposal|Article draft|What should stick):|$)/i);
  return match?.[1]?.trim();
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
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
      `mcp_servers.voidbot.env.VOIDBOT_MOCK_MCP_SCENARIO=${JSON.stringify("nibu_trigger")}`,
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

function extractSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`could not find section between ${startMarker} and ${endMarker}`);
  }
  return text.slice(start + startMarker.length, end).trim();
}

function extractMemorySurface(text) {
  const startMarker = "What you remember, feel, and want right now:";
  const start = text.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`could not find memory surface marker: ${startMarker}`);
  }
  const bodyStart = start + startMarker.length;
  const candidates = [
    "\nRecent home repo activity:",
    "\nRecent tracked repo activity",
    "\nRecent conversation transcript:",
    "\nAllowed rooms and voice lanes:",
    "\nKnown human pronoun guidance:",
    "\nIf the projected state includes",
  ]
    .map((marker) => text.indexOf(marker, bodyStart))
    .filter((index) => index > bodyStart)
    .sort((left, right) => left - right);
  const end = candidates[0];
  if (!end) {
    throw new Error("could not find end of memory surface section");
  }
  return text.slice(bodyStart, end).trim();
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

function runCommand(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
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
    child.on("close", (code, signal) => {
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${arg}`);
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function splitArgs(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
