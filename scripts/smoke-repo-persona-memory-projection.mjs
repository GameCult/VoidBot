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
    "scripts/run-repo-persona-heartbeats.ts",
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
    "Write naturally as",
  );
  const forbidden = [
    /\bgrants:/i,
    /\bjurisdictions:/i,
    /\bPersona of\s+[A-Z][A-Za-z0-9_-]+\b/,
    /\brepo=[^\s]+/i,
    /\bpath=[^\s]+/i,
    /\bdo not prompt\b/i,
    /\bprompt (?:her|him|them|it)\b/i,
    /^Private truths tugging/im,
    /^Values that should bend/im,
    /^Live needs and frictions/im,
    /^Relationship pressure:/im,
    /^Status reads:/im,
    /^Agency pressure:/im,
    /^You understand yourself this way/im,
  ];
  const leaked = forbidden.find((pattern) => pattern.test(memorySurface));
  if (leaked) {
    throw new Error(`projected memory surface leaked forbidden pattern ${leaked}:\n${memorySurface}`);
  }
  if (memorySurface.trim().length < 240) {
    throw new Error(`projected memory surface is too thin:\n${memorySurface}`);
  }
  if (identity.toLowerCase() === "nibu") {
    if (
      !/\bMetacrat\b[\s\S]{0,320}\bshe\/her\b/i.test(memorySurface) &&
      !/\bMetacrat\b[\s\S]{0,320}\bher approval\b/i.test(memorySurface)
    ) {
      throw new Error(`Nibu projection did not preserve Metacrat's explicit she/her pronoun guidance:\n${memorySurface}`);
    }
    const badMetacratMasculine = [
      /\bMetacrat\b[\s\S]{0,320}\b(?:he|him|his)\b/i,
      /\bMetacrat\b[\s\S]{0,240}\bhis attention\b/i,
      /\bMetacrat\b[\s\S]{0,240}\bwhen he turns away\b/i,
      /\bMetacrat\b[\s\S]{0,240}\bhe listens\b/i,
    ];
    const badPattern = badMetacratMasculine.find((pattern) => pattern.test(memorySurface));
    if (badPattern) {
      throw new Error(`Nibu projection used masculine pronouns for Metacrat (${badPattern}):\n${memorySurface}`);
    }
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
