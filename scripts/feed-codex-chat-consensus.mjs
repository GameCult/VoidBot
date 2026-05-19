#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AQUARIUM_CHANNEL_ID = "1501196543150264332";

function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = readLocalEnv();
  const archivePath = resolve(
    repoRoot,
    options.archivePath ?? env.RAG_ARCHIVE_PATH ?? ".voidbot/rag/messages.json",
  );
  const messages = readArchiveMessages(archivePath);
  const selected = filterMessages(messages, options).slice(-options.limit);
  const packet = buildConsensusPacket(selected, options, archivePath);
  const outputPath = resolve(
    repoRoot,
    options.out ??
      `.voidbot/artifacts/chat-consensus/${timestampSlug(new Date())}-${slugify(options.agent)}.md`,
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, packet, "utf8");

  const prompt = buildCodexPrompt(packet, outputPath, options);
  const promptPath = outputPath.replace(/\.md$/i, ".prompt.md");
  writeFileSync(promptPath, prompt, "utf8");

  process.stdout.write(`Wrote consensus packet: ${outputPath}\n`);
  process.stdout.write(`Wrote Codex prompt: ${promptPath}\n`);
  process.stdout.write(
    `Target: ${options.agent}; cwd=${resolve(options.cwd)}; messages=${selected.length}\n`,
  );

  if (!options.execute) {
    process.stdout.write(
      `Dry run. Re-run with --execute to feed this to Codex, or pass the prompt file to the target agent.\n`,
    );
    return;
  }

  const codexExecutable = options.codexExecutable ?? env.CODEX_EXECUTABLE ?? "codex";
  const model = options.model ?? env.CODEX_MODEL ?? "gpt-5.4";
  const reasoningEffort = options.reasoningEffort ?? env.CODEX_MODEL_REASONING_EFFORT ?? "medium";
  const executableArgs = splitCommandArgs(options.codexExecArgs ?? env.CODEX_EXEC_ARGS ?? "");
  const args = [
    ...executableArgs,
    "exec",
    "-m",
    model,
    "-c",
    'approval_policy="never"',
    "-c",
    `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    "--skip-git-repo-check",
    "-s",
    options.sandbox,
    "-",
  ];

  const result = spawnSync(codexExecutable, args, {
    cwd: resolve(options.cwd),
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

function parseArgs(args) {
  const options = {
    agent: "codex",
    channelId: AQUARIUM_CHANNEL_ID,
    cwd: repoRoot,
    hours: 3,
    limit: 80,
    sandbox: "read-only",
    execute: false,
    includeBotPrompts: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--agent":
        options.agent = requireValue(args, ++index, arg);
        break;
      case "--repo":
        options.repo = requireValue(args, ++index, arg);
        break;
      case "--cwd":
        options.cwd = requireValue(args, ++index, arg);
        break;
      case "--task":
        options.task = requireValue(args, ++index, arg);
        break;
      case "--channel-id":
        options.channelId = requireValue(args, ++index, arg);
        break;
      case "--after":
        options.after = requireValue(args, ++index, arg);
        break;
      case "--hours":
        options.hours = parsePositiveNumber(requireValue(args, ++index, arg), arg);
        break;
      case "--limit":
        options.limit = parsePositiveInteger(requireValue(args, ++index, arg), arg);
        break;
      case "--out":
        options.out = requireValue(args, ++index, arg);
        break;
      case "--archive-path":
        options.archivePath = requireValue(args, ++index, arg);
        break;
      case "--codex-executable":
        options.codexExecutable = requireValue(args, ++index, arg);
        break;
      case "--codex-exec-args":
        options.codexExecArgs = requireValue(args, ++index, arg);
        break;
      case "--model":
        options.model = requireValue(args, ++index, arg);
        break;
      case "--reasoning-effort":
        options.reasoningEffort = requireValue(args, ++index, arg);
        break;
      case "--sandbox":
        options.sandbox = requireValue(args, ++index, arg);
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--include-bot-prompts":
        options.includeBotPrompts = true;
        break;
      case "--help":
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.after && Number.isNaN(Date.parse(options.after))) {
    throw new Error("--after must be an ISO timestamp.");
  }

  return options;
}

function buildConsensusPacket(messages, options, archivePath) {
  const generatedAt = new Date().toISOString();
  const transcript = messages.map(formatTranscriptLine).join("\n");
  const consensusCandidates = extractConsensusCandidates(messages);
  const openQuestions = extractOpenQuestions(messages);
  const action = options.task?.trim() || "Read the recent chat consensus and take the next useful repo-local action.";

  return [
    `# Recent Chat Consensus Packet`,
    ``,
    `Generated: ${generatedAt}`,
    `Target agent: ${options.agent}`,
    options.repo ? `Target repo: ${options.repo}` : undefined,
    `Target workspace: ${resolve(options.cwd)}`,
    `Source channel: ${options.channelId}`,
    options.after ? `Source window: after ${options.after}` : `Source window: last ${options.hours} hour(s)`,
    `Archive: ${archivePath}`,
    `Messages included: ${messages.length}`,
    ``,
    `## What Needs To Be Done`,
    ``,
    action,
    ``,
    `## Consensus To Carry Forward`,
    ``,
    consensusCandidates.length > 0
      ? consensusCandidates.map((item) => `- ${item}`).join("\n")
      : "- No explicit consensus markers were detected. Treat the transcript below as the authority.",
    ``,
    `## Open Questions`,
    ``,
    openQuestions.length > 0
      ? openQuestions.map((item) => `- ${item}`).join("\n")
      : "- No explicit question marks were detected in the selected window.",
    ``,
    `## Instructions For The Target Codex Agent`,
    ``,
    `Use this packet as fresh local consensus from Discord. Prefer repo-local evidence before making edits. If the packet contains a concrete request, act in the target workspace. If it is not enough to act, write down the smallest missing question instead of pretending consensus is stronger than it is.`,
    ``,
    `## Recent Transcript`,
    ``,
    "```text",
    transcript || "(no messages selected)",
    "```",
    ``,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function buildCodexPrompt(packet, packetPath, options) {
  return [
    `You are ${options.agent}, receiving a recent Discord consensus packet from VoidBot.`,
    options.repo ? `Your target repo is ${options.repo}.` : undefined,
    `Consensus packet path: ${packetPath}`,
    ``,
    packet,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function extractConsensusCandidates(messages) {
  const markers = [
    /\bsounds good\b/i,
    /\blove it\b/i,
    /\bdefinitely\b/i,
    /\bneed\b/i,
    /\bshould\b/i,
    /\bisn't\b/i,
    /\bis not\b/i,
    /\bis the\b/i,
    /\bcan\b/i,
  ];

  return messages
    .filter((message) => markers.some((marker) => marker.test(message.content ?? "")))
    .map((message) => `${message.authorName}: ${singleLine(message.content)}`)
    .slice(-12);
}

function extractOpenQuestions(messages) {
  return messages
    .filter((message) => (message.content ?? "").includes("?"))
    .map((message) => `${message.authorName}: ${singleLine(message.content)}`)
    .slice(-12);
}

function filterMessages(messages, options) {
  const lowerBoundMs = options.after
    ? Date.parse(options.after)
    : Date.now() - options.hours * 60 * 60 * 1000;

  return messages
    .filter((message) => !message.deletedAt)
    .filter((message) => (options.includeBotPrompts ? true : readMessageKind(message) !== "bot_prompt"))
    .filter((message) => (options.channelId ? message.channelId === options.channelId : true))
    .filter((message) => {
      const timestampMs = Date.parse(message.timestamp ?? "");
      return Number.isFinite(timestampMs) && timestampMs > lowerBoundMs;
    })
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function readArchiveMessages(archivePath) {
  const raw = stripLeadingBom(readFileSync(archivePath, "utf8"));
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
    throw new Error(`Archive at ${archivePath} does not have a messages array.`);
  }
  return parsed.messages;
}

function readLocalEnv() {
  const envPath = resolve(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return {};
  }

  return parseDotEnv(stripLeadingBom(readFileSync(envPath, "utf8")));
}

function parseDotEnv(raw) {
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function readMessageKind(message) {
  return typeof message.messageKind === "string"
    ? message.messageKind
    : typeof message.metadata?.messageKind === "string"
      ? message.metadata.messageKind
      : "default";
}

function formatTranscriptLine(message) {
  return `[${message.timestamp}] ${message.authorName} (${message.authorId}): ${singleLine(message.content)}`;
}

function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stripLeadingBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return parsed;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function timestampSlug(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function slugify(value) {
  return String(value ?? "codex")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "codex";
}

function splitCommandArgs(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function printHelpAndExit() {
  process.stdout.write(`Usage:
  node scripts/feed-codex-chat-consensus.mjs --agent nibu --cwd E:/Projects/AetheriaLore --task "Update Nibu lore notes from this consensus"

Options:
  --agent <name>              Target agent label.
  --cwd <path>                Target workspace. Defaults to this repo.
  --task <text>               Instruction embedded in the consensus packet.
  --channel-id <id>           Discord channel id. Defaults to Aquarium.
  --hours <number>            Recent time window. Defaults to 3.
  --after <iso>               Use messages after an ISO timestamp instead of --hours.
  --limit <number>            Max messages. Defaults to 80.
  --out <path>                Packet output path.
  --execute                   Feed the generated prompt to codex exec.
  --sandbox <profile>         Codex sandbox for --execute. Defaults to read-only.
`);
  process.exit(0);
}

main();
