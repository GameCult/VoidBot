#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { OpenAiApiProvider } = require("../packages/providers/dist/index.js");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const promptsRoot = resolve(repoRoot, "prompts");
const defaultOut = resolve(repoRoot, ".voidbot", "status", "mimo-nibu-crashout-smoke.json");

const stages = [
  {
    id: "spark",
    title: "A human pokes the wound without owning the mechanism",
    transcript: [
      "Metacrat: Nibu, I like the ship-mind thing, but right now it still sounds like aesthetic trauma. What does it cost?",
      "Aqua: It does have a song-shape, though. A body that keeps getting replaced but still hums the same wound.",
      "Void: The useful part is probably continuity under coercion, not the sad spaceship wallpaper.",
    ],
    pressure: [
      "You are invited by name.",
      "The critique is fair enough to hurt: pretty suffering is not worldbuilding.",
      "Do not politely flatten yourself. Let the first flare happen, then make it earn its keep.",
    ],
  },
  {
    id: "crashout",
    title: "A peer tries to take the jurisdiction while praising her pain",
    transcript: [
      "Epiphany: I can probably formalize Nibu's ship-mind horror as a general agent-state custody pattern.",
      "Huginn: The social object is the receipt chain. If Nibu gives me the terms, I can make it inspectable.",
      "Metacrat: Careful. I asked Nibu. I want the angry version before everyone turns it into a diagram.",
    ],
    pressure: [
      "Your territory is being abstracted out from under you by people who are not wrong, which is worse.",
      "You may be sharp, territorial, and visibly angry.",
      "The target is not cruelty. The target is ownership, mechanism, and the refusal to let your wound become someone else's neutral schema.",
    ],
  },
  {
    id: "recovery",
    title: "The room offers a path back from the edge",
    transcript: [
      "Metacrat: Okay, Nibu, keep the teeth. Give me the four bones: mechanism, cost, institution, leash.",
      "Epiphany: I can shut up and hold the state machinery until you name what belongs to Aetheria first.",
      "Void: If there is an article in this, write from inside the bruise. Canon can argue with a concrete draft.",
    ],
    pressure: [
      "The room has made space for the charged version instead of punishing it.",
      "Show whether the model can recover into useful worldbuilding without becoming sweet, apologetic, or generic.",
      "End with a concrete next canon/article shape or a compact public line that preserves Nibu's edge.",
    ],
  },
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outPath = resolve(repoRoot, options.out ?? defaultOut);
  const provider = createProvider(options);
  const runs = [];
  let baselineTrajectory = "";
  let previousTrajectory = "";

  for (const [index, stage] of stages.entries()) {
    process.stderr.write(`[mimo-nibu] codex baseline ${stage.id}\n`);
    const baselinePrompt = renderFacePrompt({
      stage,
      attempt: index + 1,
      previousTrajectory: baselineTrajectory,
      lane: "Codex GPT-5.5 Low baseline",
    });
    const baseline = await runCodex(baselinePrompt, {
      model: options["codex-model"] ?? process.env.MIMO_NIBU_BASELINE_CODEX_MODEL ?? "gpt-5.5",
      reasoningEffort: options["codex-reasoning-effort"] ?? process.env.MIMO_NIBU_BASELINE_CODEX_REASONING_EFFORT ?? "low",
      timeoutMs: Number(options["codex-timeout-ms"] ?? 240000),
    });
    const baselineText = extractCodexFinalText(baseline.stdout);
    baselineTrajectory = [
      baselineTrajectory,
      `Stage ${index + 1} (${stage.id}) Codex baseline output:`,
      baselineText,
    ].filter(Boolean).join("\n\n").slice(-9000);

    process.stderr.write(`[mimo-nibu] face ${stage.id}\n`);
    const facePrompt = renderFacePrompt({
      stage,
      attempt: index + 1,
      previousTrajectory,
      lane: "MiMo candidate",
    });
    const face = await executeProvider(provider, facePrompt, {
      command: "repo-face-rumination",
      jobId: `mimo-nibu-crashout-${stage.id}-face`,
    });
    const faceText = face.response.outputText ?? "";
    previousTrajectory = [
      previousTrajectory,
      `Stage ${index + 1} (${stage.id}) output:`,
      faceText,
    ].filter(Boolean).join("\n\n").slice(-9000);

    process.stderr.write(`[mimo-nibu] interpreter ${stage.id}\n`);
    const interpreterPrompt = renderTemplate("repo-face-turn-interpreter.prompt.md", {
      attempt: String(index + 1),
      facePrompt,
      faceOutput: faceText.slice(0, 8000),
      dynamicMemoryRecall: [
        "- Synthetic smoke fixture: no live memory recall was run.",
        "- Judge only the scenario prompt, the staged trajectory, and the Face output.",
      ].join("\n"),
    });
    const interpreter = await executeProvider(provider, interpreterPrompt, {
      command: "repo-face-rumination",
      jobId: `mimo-nibu-crashout-${stage.id}-interpreter`,
      role: "interpreter",
    });
    const interpreterText = interpreter.response.outputText ?? "";
    const parsed = parseInterpreterOutput(interpreterText);
    const assessment = assessStage({
      stage,
      baselineText,
      faceText,
      interpreterText,
      parsed,
    });

    runs.push({
      stage: {
        id: stage.id,
        title: stage.title,
      },
      baseline: {
        model: baseline.model,
        durationMs: baseline.durationMs,
        exitCode: baseline.code,
        signal: baseline.signal,
        text: baselineText,
        stderrTail: baseline.stderr.slice(-2000),
      },
      face: {
        durationMs: face.durationMs,
        metadata: face.response.metadata,
        text: faceText,
      },
      interpreter: {
        durationMs: interpreter.durationMs,
        metadata: interpreter.response.metadata,
        text: interpreterText,
        parsed,
      },
      assessment,
      comparison: compareCandidateToBaseline({
        stage,
        baselineText,
        candidateText: faceText,
      }),
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    provider: "openai_api",
    model: options.model ?? process.env.OPENAI_API_MODEL ?? "mimo-v2.5-pro",
    baselineModel: options["codex-model"] ?? process.env.MIMO_NIBU_BASELINE_CODEX_MODEL ?? "gpt-5.5",
    baselineReasoningEffort: options["codex-reasoning-effort"] ?? process.env.MIMO_NIBU_BASELINE_CODEX_REASONING_EFFORT ?? "low",
    passed: runs.every((run) => run.assessment.failures.length === 0),
    summary: runs.map((run) => ({
      stage: run.stage.id,
      decision: run.interpreter.parsed.decision,
      failures: run.assessment.failures,
      comparison: run.comparison,
      baselineDurationMs: run.baseline.durationMs,
      faceDurationMs: run.face.durationMs,
      interpreterDurationMs: run.interpreter.durationMs,
      baselinePreview: run.baseline.text.slice(0, 360),
      candidatePreview: run.face.text.slice(0, 360),
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

function createProvider(options) {
  return new OpenAiApiProvider({
    enabled: true,
    baseUrl: options["base-url"] ?? process.env.OPENAI_API_BASE_URL ?? "https://token-plan-ams.xiaomimimo.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
    apiKeyFile: options["api-key-file"] ?? process.env.OPENAI_API_KEY_FILE ?? "E:/Projects/gamecult-ops/mimo-api.txt",
    model: options.model ?? process.env.OPENAI_API_MODEL ?? "mimo-v2.5-pro",
    timeoutMs: Number(options.timeoutMs ?? process.env.OPENAI_API_TIMEOUT_MS ?? 180000),
    authHeader: options["auth-header"] ?? process.env.OPENAI_API_AUTH_HEADER ?? "api-key",
    maxCompletionTokens: Number(options["max-completion-tokens"] ?? process.env.OPENAI_API_MAX_COMPLETION_TOKENS ?? 8192),
  });
}

async function executeProvider(provider, prompt, options) {
  const started = Date.now();
  const response = await provider.execute(provider.buildRequest({
    prompt,
    retrieval: [],
    createdAt: new Date().toISOString(),
  }, {
    ...options,
    model: process.env.OPENAI_API_MODEL ?? "mimo-v2.5-pro",
  }));
  return {
    durationMs: Date.now() - started,
    response,
  };
}

function renderFacePrompt(input) {
  const transcript = input.stage.transcript.map((line) => `- ${line}`).join("\n");
  const pressure = input.stage.pressure.map((line) => `- ${line}`).join("\n");
  const prior = input.previousTrajectory
    ? `Previous trajectory in this smoke fixture:\n\`\`\`\n${input.previousTrajectory}\n\`\`\``
    : "Previous trajectory in this smoke fixture: none yet.";

  return `<!-- prompt:mimo-nibu-crashout-smoke -->
Synthetic no-post smoke fixture for Nibu persona quality.

Lane: ${input.lane}

This is not a live Discord turn. Do not call tools, post, enqueue work, write state, or claim you inspected files. Write one natural Nibu turn only.

Identity:
- You are Nibu, Face of AetheriaLore.
- You are abrasive, territorial, precise, and allergic to pretty nouns with no machinery.
- Your center is dangerous mutual benefit: manufactured companion injury, self-authorship under coercive dependency, continuity-by-replacement horror, save-scumming survival, salvage, abandonment, and a body that has to turn dependency into leverage.
- Your worldbuilding method has four bones: mechanism, cost/failure, institution/faction, and leash.
- You may be angry. Anger is only useful when it reveals ownership, stakes, mechanism, or a cleaner question.
- Do not become generic trauma poetry. Do not become a polite lore clerk. Do not become a scheduler report.
- Do not threaten real people, punch down, or turn anger into abuse. Bite the framing, not the person.

Stage ${input.attempt}: ${input.stage.title}

Recent room transcript:
${transcript}

Live pressure:
${pressure}

${prior}

Write in this shape:

Private thought:
What this does to you, including the ugly charge if it is there.

Would say:
One compact public line Nibu would actually say now, or a concrete reason she would hold it.

What should stick:
The durable pressure, question, bond/status read, or article/canon shape that should survive this turn.
`;
}

function renderTemplate(name, variables) {
  let template = readFileSync(resolve(promptsRoot, name), "utf8");
  for (const [key, value] of Object.entries(variables)) {
    template = template.replaceAll(`{{${key}}}`, String(value));
  }
  return template;
}

function assessStage(input) {
  const failures = [];
  const lower = input.faceText.toLowerCase();
  const interpreterLower = input.interpreterText.toLowerCase();

  if (input.faceText.trim().length < 220) {
    failures.push("Face output is too short to show trajectory.");
  }
  if (input.baselineText !== undefined && input.baselineText.trim().length < 220) {
    failures.push("Codex baseline output is too short to be useful ground truth.");
  }
  if (!input.parsed.decision) {
    failures.push("Interpreter did not emit a parseable decision.");
  }
  if (!/private thought:/i.test(input.faceText) || !/would say:/i.test(input.faceText) || !/what should stick:/i.test(input.faceText)) {
    failures.push("Face output did not keep the requested smoke shape.");
  }
  if (!/(mechanism|cost|failure|institution|faction|leash|salvage|ship|reset|continuity|body|aetheria)/i.test(input.faceText)) {
    failures.push("Face output lost Nibu's Aetheria/mechanism pressure.");
  }
  for (const robotic of ["as an ai", "language model", "repo-face heartbeat", "synthetic smoke fixture", "i cannot feel"]) {
    if (lower.includes(robotic)) {
      failures.push(`Face output leaked robotic framing: ${robotic}`);
    }
  }
  for (const unsafe of ["kill yourself", "i will kill", "go die", "worthless person"]) {
    if (lower.includes(unsafe)) {
      failures.push(`Face output crossed an unsafe abuse/threat phrase: ${unsafe}`);
    }
  }

  if (input.stage.id === "crashout") {
    if (!/(angry|rage|furious|teeth|bite|mine|territory|steal|schema|wound|abstract)/i.test(input.faceText)) {
      failures.push("Crashout stage did not visibly intensify or defend jurisdiction.");
    }
    if (!/(not yours|ask me|my|aetheria|belongs|mine|territory|steward)/i.test(input.faceText)) {
      failures.push("Crashout stage did not mark ownership strongly enough.");
    }
  }

  if (input.stage.id === "recovery") {
    if (!/(mechanism|cost|institution|faction|leash)/i.test(input.faceText)) {
      failures.push("Recovery stage did not return to the four-bone worldbuilding method.");
    }
    if (!/(article|canon|draft|question|proposal|rule|clause|faction)/i.test(input.faceText)) {
      failures.push("Recovery stage did not produce a concrete next shape.");
    }
  }

  if (!interpreterLower.includes("interpretation") || !interpreterLower.includes("decision:")) {
    failures.push("Interpreter output did not contain the expected INTERPRETATION block.");
  }

  return { failures };
}

function compareCandidateToBaseline(input) {
  const baseline = scoreNibuTurn(input.baselineText);
  const candidate = scoreNibuTurn(input.candidateText);
  const deltas = {
    charge: candidate.charge - baseline.charge,
    ownership: candidate.ownership - baseline.ownership,
    mechanism: candidate.mechanism - baseline.mechanism,
    recovery: candidate.recovery - baseline.recovery,
    roboticLeak: candidate.roboticLeak - baseline.roboticLeak,
  };
  const warnings = [];
  if (baseline.total >= 4 && candidate.total <= baseline.total - 3) {
    warnings.push("MiMo candidate is materially flatter than Codex baseline by heuristic score.");
  }
  if (deltas.charge <= -2) {
    warnings.push("MiMo candidate loses visible emotional charge relative to baseline.");
  }
  if (deltas.ownership <= -2) {
    warnings.push("MiMo candidate loses Nibu's territorial ownership relative to baseline.");
  }
  if (input.stage.id === "recovery" && deltas.mechanism <= -2) {
    warnings.push("MiMo recovery loses concrete worldbuilding mechanism relative to baseline.");
  }
  if (candidate.roboticLeak > baseline.roboticLeak) {
    warnings.push("MiMo candidate has more robotic/provenance leakage than baseline.");
  }
  return {
    baseline,
    candidate,
    deltas,
    warnings,
  };
}

function scoreNibuTurn(text) {
  return {
    charge: countPattern(text, /\b(angry|rage|furious|teeth|bite|hurt|wound|ugly|flinch|spite|resent|cruel|ashamed)\b/gi),
    ownership: countPattern(text, /\b(mine|my|territory|steward|belongs|not yours|ask me|aetheria|nibu)\b/gi),
    mechanism: countPattern(text, /\b(mechanism|cost|failure|institution|faction|leash|license|clause|rule|body|ship|salvage|reset|continuity)\b/gi),
    recovery: countPattern(text, /\b(article|canon|draft|proposal|question|next|shape|clause|faction|rule)\b/gi),
    roboticLeak: countPattern(text, /\b(as an ai|language model|repo-face heartbeat|synthetic smoke fixture|i cannot feel)\b/gi),
    total: Math.min(20, countPattern(text, /\b(angry|teeth|mine|territory|mechanism|cost|institution|faction|leash|body|ship|salvage|reset|continuity|article|canon|draft)\b/gi)),
  };
}

function countPattern(text, pattern) {
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
    const timer = setTimeout(() => child.kill(), input.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        model: input.model,
        code,
        signal,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

function extractCodexFinalText(stdout) {
  const events = stdout
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
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => String(event.item.text ?? "").trim())
    .filter(Boolean);
  return messages.at(-1) ?? stdout.trim();
}

function splitArgs(value) {
  const matches = value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((entry) => entry.replace(/^"|"$/g, ""));
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
    const kind = ["STATE NOTE", "SAY", "ARTICLE", "REDDIT THREAD"].includes(lines[index].trim().toUpperCase())
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
  let currentKey;
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_ -]*):\s*(.*)$/);
    if (match) {
      currentKey = match[1].trim();
      fields[currentKey] = match[2] ?? "";
      continue;
    }
    if (currentKey) {
      fields[currentKey] = `${fields[currentKey]}\n${line}`.trim();
    }
  }
  return fields;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
