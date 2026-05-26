#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const promptsRoot = resolve(repoRoot, "prompts");
const defaultScenarioPath = resolve(repoRoot, "scenarios", "cotsc-praxis-socratic-sermon.json");
const retrievalToolAllowlist = [
  "search_history",
  "get_message_context",
  "list_indexed_repos",
  "search_sources",
  "get_source_context",
].join(",");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarioPath = resolve(repoRoot, options.scenario ?? defaultScenarioPath);
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  const maxPhases = numberOption(options["max-phases"], scenario.phases.length);
  const maxDepth = numberOption(options["max-depth"], scenario.ctb?.maxFaceTurnsPerPhase ?? 3);
  const choiceCount = numberOption(options["choice-count"], scenario.ctb?.choiceCount ?? 3);
  const faceModel = options["face-model"] ?? process.env.REPO_FACE_TURN_CODEX_MODEL ?? "gpt-5.4";
  const mindModel = options["mind-model"] ?? process.env.REPO_FACE_MIND_CODEX_MODEL ?? "gpt-5.4";
  const voidModel = options["void-model"] ?? options.model ?? process.env.REPO_FACE_MIND_CODEX_MODEL ?? "gpt-5.4";
  const faceReasoningEffort = options["face-reasoning-effort"] ?? process.env.REPO_FACE_TURN_CODEX_REASONING_EFFORT ?? "low";
  const mindReasoningEffort = options["mind-reasoning-effort"] ?? process.env.REPO_FACE_MIND_CODEX_REASONING_EFFORT ?? "none";
  const voidReasoningEffort = options["void-reasoning-effort"] ?? "low";
  const foldMode = options["void-fold-mode"] ?? "generated";
  const outPath = resolve(repoRoot, options.out ?? scenario.outputInkPath);
  const receiptPath = resolve(repoRoot, options.receipts ?? scenario.receiptPath);
  const globalAgentDoctrine = await loadGlobalAgentDoctrine();
  const basePromptCache = new Map();
  const receipts = {
    schemaVersion: "voidbot.socratic_ink_receipts.v0",
    scenarioPath,
    generatedAt: new Date().toISOString(),
    options: {
      maxPhases,
      maxDepth,
      choiceCount,
      faceModel,
      mindModel,
      voidModel,
      faceReasoningEffort,
      mindReasoningEffort,
      voidReasoningEffort,
      foldMode,
    },
    faceTurns: [],
    voidFolds: [],
  };

  const actors = scenario.actors.map((actor, index) => ({
    ...actor,
    displayName: actor.displayName ?? actor.identityId,
    speed: Number.isFinite(actor.speed) ? actor.speed : 1,
    order: index,
    nextReady: index / Math.max(1, scenario.actors.length),
  }));

  const ink = [];
  ink.push(`// ghostlight.scenario: ${scenario.scenarioId}`);
  ink.push(`// ghostlight.generated_at: ${receipts.generatedAt}`);
  ink.push(`// ghostlight.receipts: ${toInkCommentPath(receiptPath)}`);
  ink.push(`VAR face_turns = 0`);
  ink.push(`VAR void_folds = 0`);
  ink.push("");
  ink.push(`# ${scenario.title}`);
  if (scenario.subtitle) {
    ink.push(`# ${scenario.subtitle}`);
  }
  ink.push("");
  ink.push("-> phase_1");
  ink.push("");

  const phaseCount = Math.min(maxPhases, scenario.phases.length);
  for (let phaseIndex = 0; phaseIndex < phaseCount; phaseIndex += 1) {
    const phase = scenario.phases[phaseIndex];
    const nextPhaseKnot = phaseIndex + 1 < phaseCount ? `phase_${phaseIndex + 2}` : "closing";
    const phaseCtb = cloneCtb(actors, phaseIndex * choiceCount);
    ink.push(`=== phase_${phaseIndex + 1} ===`);
    ink.push(`// ghostlight.phase_id: ${phase.phaseId}`);
    ink.push(`// ghostlight.topic: ${phase.topic}`);
    ink.push("");
    ink.push(`Void says, ${quoteInk(phase.voidOpening)}`);
    ink.push("");
    ink.push(`-> ${nodeName(phaseIndex, [])}`);
    ink.push("");

    await buildBranchNode({
      scenario,
      phase,
      phaseIndex,
      nextPhaseKnot,
      depth: 0,
      maxDepth,
      choiceCount,
      ctb: phaseCtb,
      transcript: [{ speaker: "Void", text: phase.voidOpening }],
      voidLine: phase.voidOpening,
      basePromptCache,
      globalAgentDoctrine,
      faceModel,
      mindModel,
      voidModel,
      faceReasoningEffort,
      mindReasoningEffort,
      voidReasoningEffort,
      foldMode,
      ink,
      receipts,
    });
  }

  ink.push("=== closing ===");
  ink.push(`Void says, ${quoteInk(scenario.closing)}`);
  ink.push("-> END");
  ink.push("");

  await mkdir(dirname(outPath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(outPath, `${ink.join("\n")}\n`, "utf8");
  await writeFile(receiptPath, `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    scenarioId: scenario.scenarioId,
    outPath,
    receiptPath,
    faceTurns: receipts.faceTurns.length,
    voidFolds: receipts.voidFolds.length,
  }, null, 2)}\n`);
}

async function buildBranchNode(input) {
  const knot = nodeName(input.phaseIndex, input.transcriptPath ?? []);
  const path = input.transcriptPath ?? [];
  input.ink.push(`=== ${knot} ===`);
  input.ink.push(`// ghostlight.branch_depth: ${input.depth}`);
  input.ink.push(`// ghostlight.ctb_next: ${nextActors(input.ctb, input.choiceCount).map((actor) => actor.identityId).join(",")}`);
  input.ink.push("");

  const candidates = nextActors(input.ctb, input.choiceCount);
  for (const actor of candidates) {
    const turn = await generateFaceTurn({ ...input, actor });
    const choiceKnot = afterChoiceName(input.phaseIndex, path, actor.identityId);
    input.ink.push(`+ [${sanitizeChoiceLabel(turn.choiceLabel)}]`);
    input.ink.push(`  ~ face_turns += 1`);
    input.ink.push(`  ${turn.displayName} says, ${quoteInk(turn.speech)}`);
    input.ink.push(`  -> ${choiceKnot}`);
    input.ink.push("");

    const branchCtb = spendActor(input.ctb, actor, input.scenario.ctb?.recoveryBase ?? 1);
    const branchTranscript = [
      ...input.transcript,
      { speaker: turn.displayName, text: turn.speech },
    ];
    const branchPath = [...path, actor.identityId];
    const fold = await generateVoidFold({
      ...input,
      transcript: branchTranscript,
      actor,
    });
    input.ink.push(`=== ${choiceKnot} ===`);
    input.ink.push(`// ghostlight.selected_face: ${actor.identityId}`);
    input.ink.push(`// ghostlight.unspent_faces: ${candidates.filter((candidate) => candidate.identityId !== actor.identityId).map((candidate) => candidate.identityId).join(",")}`);
    input.ink.push("");
    if (input.depth + 1 < input.maxDepth) {
      const continueKnot = nodeName(input.phaseIndex, branchPath);
      input.ink.push(`+ [Let the Faces keep worrying the question.]`);
      input.ink.push(`  -> ${continueKnot}`);
      input.ink.push(`+ [Void folds this branch back to the lesson.]`);
      input.ink.push(`  ~ void_folds += 1`);
      input.ink.push(`  Void says, ${quoteInk(fold.text)}`);
      input.ink.push(`  -> ${input.nextPhaseKnot}`);
      input.ink.push("");
      await buildBranchNode({
        ...input,
        depth: input.depth + 1,
        ctb: branchCtb,
        transcript: branchTranscript,
        voidLine: fold.text,
        transcriptPath: branchPath,
      });
    } else {
      input.ink.push(`~ void_folds += 1`);
      input.ink.push(`Void says, ${quoteInk(fold.text)}`);
      input.ink.push(`-> ${input.nextPhaseKnot}`);
      input.ink.push("");
    }
  }
}

async function generateFaceTurn(input) {
  const baseFacePrompt = await getBaseFacePrompt(input.actor.identityId, input.basePromptCache);
  const transcript = renderTranscript(input.transcript);
  const prompt = renderTemplate("socratic-ink-face-turn.prompt.md", {
    baseFacePrompt,
    title: input.scenario.title,
    phaseTopic: input.phase.topic,
    phaseLesson: input.phase.lesson,
    voidLine: input.voidLine,
    transcript,
    actorRole: input.actor.role ?? "",
    displayName: input.actor.displayName ?? input.actor.identityId,
  });
  const faceRun = await runCodex(prompt, {
    model: input.faceModel,
    reasoningEffort: input.faceReasoningEffort,
    mcpMode: "real-readonly",
    timeoutMs: 240_000,
  });
  const faceText = extractFinalText(parseJsonEvents(faceRun.stdout), faceRun.stdout);
  const parsedFace = parseFaceResponse(faceText, input.actor);
  const mindPrompt = renderTemplate("repo-face-turn-interpreter.prompt.md", {
    attempt: "1",
    facePrompt: prompt,
    faceOutput: faceText,
    globalAgentDoctrine: input.globalAgentDoctrine,
  });
  const mindRun = await runCodex(mindPrompt, {
    model: input.mindModel,
    reasoningEffort: input.mindReasoningEffort,
    mcpMode: "none",
    timeoutMs: 240_000,
  });
  const mindText = extractFinalText(parseJsonEvents(mindRun.stdout), mindRun.stdout);
  const parsedMind = parseInterpreterOutput(mindText);
  const say = parsedMind.blocks.find((block) => block.kind === "SAY")?.fields.content;
  const speech = cleanSpeech(say || parsedFace.speech || faceText);
  const choiceLabel = parsedFace.choiceLabel || `${input.actor.displayName ?? input.actor.identityId}: ${speech}`;
  const receipt = {
    phaseId: input.phase.phaseId,
    depth: input.depth,
    identityId: input.actor.identityId,
    displayName: input.actor.displayName ?? input.actor.identityId,
    prompt,
    face: {
      exitCode: faceRun.code,
      durationMs: faceRun.durationMs,
      text: faceText,
      parsed: parsedFace,
      stderrTail: faceRun.stderr.slice(-2000),
    },
    mind: {
      exitCode: mindRun.code,
      durationMs: mindRun.durationMs,
      text: mindText,
      parsed: parsedMind,
      stderrTail: mindRun.stderr.slice(-2000),
    },
    selectedSpeech: speech,
    choiceLabel,
  };
  input.receipts.faceTurns.push(receipt);
  return {
    displayName: input.actor.displayName ?? input.actor.identityId,
    speech,
    choiceLabel,
  };
}

async function generateVoidFold(input) {
  if (input.foldMode === "template") {
    const text = `Good. Hold that answer against the next question: ${input.phase.foldTarget}`;
    input.receipts.voidFolds.push({ phaseId: input.phase.phaseId, depth: input.depth, mode: "template", text });
    return { text };
  }
  const prompt = renderTemplate("socratic-ink-void-fold.prompt.md", {
    globalAgentDoctrine: input.globalAgentDoctrine,
    title: input.scenario.title,
    phaseTopic: input.phase.topic,
    phaseLesson: input.phase.lesson,
    foldTarget: input.phase.foldTarget,
    transcript: renderTranscript(input.transcript),
  });
  const run = await runCodex(prompt, {
    model: input.voidModel,
    reasoningEffort: input.voidReasoningEffort,
    mcpMode: "none",
    timeoutMs: 180_000,
  });
  const text = cleanSpeech(extractFinalText(parseJsonEvents(run.stdout), run.stdout));
  input.receipts.voidFolds.push({
    phaseId: input.phase.phaseId,
    depth: input.depth,
    mode: "generated",
    prompt,
    exitCode: run.code,
    durationMs: run.durationMs,
    text,
    stderrTail: run.stderr.slice(-2000),
  });
  return { text };
}

async function getBaseFacePrompt(identityId, cache) {
  if (cache.has(identityId)) {
    return cache.get(identityId);
  }
  const outPath = resolve(repoRoot, ".voidbot", "artifacts", "socratic-ink", "base-prompts", `${identityId}.md`);
  await mkdir(dirname(outPath), { recursive: true });
  await runProcess(process.execPath, [
    resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    resolve(repoRoot, "scripts", "run-repo-face-heartbeats.ts"),
    "--assemble-prompt",
    identityId,
    "--out",
    outPath,
  ], { cwd: repoRoot, timeoutMs: 180_000 });
  const prompt = await readFile(outPath, "utf8");
  cache.set(identityId, prompt);
  return prompt;
}

function nextActors(ctb, count) {
  return [...ctb]
    .sort((left, right) =>
      left.nextReady - right.nextReady ||
      right.speed - left.speed ||
      left.order - right.order
    )
    .slice(0, count);
}

function spendActor(ctb, selected, recoveryBase) {
  const clock = selected.nextReady;
  return ctb.map((actor) => {
    if (actor.identityId !== selected.identityId) {
      return { ...actor };
    }
    return {
      ...actor,
      nextReady: clock + (recoveryBase / Math.max(0.1, actor.speed)),
    };
  });
}

function cloneCtb(actors, phaseOffset = 0) {
  const count = Math.max(1, actors.length);
  return actors.map((actor) => ({
    ...actor,
    nextReady: ((actor.order - phaseOffset) % count + count) % count / count,
  }));
}

function nodeName(phaseIndex, path) {
  return `p${phaseIndex + 1}_${path.length === 0 ? "root" : path.map(safeId).join("_")}`;
}

function afterChoiceName(phaseIndex, path, identityId) {
  return `${nodeName(phaseIndex, path)}__after_${safeId(identityId)}`;
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function sanitizeChoiceLabel(value) {
  return cleanSpeech(value)
    .replace(/[\[\]\{\}\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140) || "Someone answers Void";
}

function quoteInk(value) {
  const cleaned = cleanSpeech(value).replace(/"/g, '\\"');
  return `"${cleaned}"`;
}

function cleanSpeech(value) {
  return normalizeAscii(String(value ?? ""))
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAscii(value) {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2014/g, "--")
    .replace(/\u2013/g, "-")
    .replace(/\u2026/g, "...");
}

function renderTranscript(entries) {
  if (!entries.length) {
    return "- No prior branch dialogue.";
  }
  return entries.map((entry) => `- ${entry.speaker}: ${entry.text}`).join("\n");
}

function parseFaceResponse(text, actor) {
  const choiceLabel = section(text, "CHOICE LABEL") || "";
  const speech = section(text, "SPOKEN RESPONSE") || "";
  const privateNote = section(text, "PRIVATE NOTE") || "";
  return {
    choiceLabel: cleanSpeech(choiceLabel).replace(new RegExp(`^${actor.displayName ?? actor.identityId}:\\s*`, "i"), ""),
    speech: cleanSpeech(speech),
    privateNote: cleanSpeech(privateNote),
  };
}

function section(text, label) {
  const pattern = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z ]+:|$)`, "i");
  return text.match(pattern)?.[1]?.trim();
}

function parseInterpreterOutput(text) {
  const decision = text.match(/decision:\s*(route|retry|drop)/i)?.[1]?.toLowerCase();
  return {
    decision,
    blocks: parseDslBlocks(text),
  };
}

function parseDslBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = ["STATE NOTE", "SAY", "ARTICLE", "BIFROST TOPIC"].includes(lines[index].trim().toUpperCase())
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
        `mcp_servers.voidbot.env.VOIDBOT_MCP_TOOL_ALLOWLIST=${JSON.stringify(retrievalToolAllowlist)}`,
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
    const timer = setTimeout(() => child.kill(), input.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, durationMs: Date.now() - started, stdout, stderr });
    });
  });
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
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
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
    template = template.replaceAll(`{{${key}}}`, String(value ?? ""));
  }
  return template;
}

async function loadGlobalAgentDoctrine() {
  const candidates = [
    process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, "AGENTS.md") : undefined,
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, ".codex", "AGENTS.md") : undefined,
    resolve(homedir(), ".codex", "AGENTS.md"),
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const content = await readFile(candidate, "utf8");
      if (content.trim()) {
        return content.trim();
      }
    } catch {
      // Try the next known global doctrine path.
    }
  }
  return "# Global Agent Instructions Unavailable\n\nNo readable global AGENTS.md file was found.";
}

function splitArgs(value) {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((entry) => entry.replace(/^"|"$/g, "")) ?? [];
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
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

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toInkCommentPath(path) {
  return path.replace(/\\/g, "/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
