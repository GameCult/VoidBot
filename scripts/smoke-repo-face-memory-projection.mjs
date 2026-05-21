#!/usr/bin/env node
import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = process.argv[2] ?? "libby";
const tempDir = await mkdtemp(join(tmpdir(), "voidbot-face-projection-"));
const outPath = join(tempDir, `${identity}.md`);

try {
  const run = await runCommand(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "scripts/run-repo-face-heartbeats.ts",
    "--assemble-prompt",
    identity,
    "--out",
    outPath,
  ]);
  if (run.code !== 0) {
    throw new Error(`prompt assembly failed with ${run.code}:\n${run.stderr || run.stdout}`);
  }

  const prompt = await readFile(outPath, "utf8");
  const memorySurface = extractSection(
    prompt,
    "What you remember, feel, and want right now:",
    "What the nearby conversation feels like right now:",
  );
  const forbidden = [
    /\bgrants:/i,
    /\bjurisdictions:/i,
    /\bFace of\b/i,
    /\brepo=[^\s]+/i,
    /\bpath=[^\s]+/i,
    /\bdo not prompt\b/i,
    /\bprompt (?:her|him|them|it)\b/i,
    /Private truths tugging/i,
    /Values that should bend/i,
    /Live needs and frictions/i,
    /Relationship pressure/i,
    /Status reads/i,
    /Agency pressure/i,
    /You understand yourself this way/i,
  ];
  const leaked = forbidden.find((pattern) => pattern.test(memorySurface));
  if (leaked) {
    throw new Error(`projected memory surface leaked forbidden pattern ${leaked}:\n${memorySurface}`);
  }
  if (memorySurface.trim().length < 240) {
    throw new Error(`projected memory surface is too thin:\n${memorySurface}`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, identity, outPath, chars: memorySurface.length })}\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

function extractSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`could not find memory projection section in assembled prompt`);
  }
  return text.slice(start + startMarker.length, end).trim();
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
