#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decode, encode } from "@msgpack/msgpack";
import { z } from "zod";

const envelopeSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  payload: z.union([
    z.instanceof(Uint8Array),
    z.object({
      type: z.literal("Buffer"),
      data: z.array(z.number().int().min(0).max(255)),
    }),
    z.array(z.number().int().min(0).max(255)),
  ]),
  storedAt: z.string().min(1),
}).passthrough();

const envelopeArraySchema = z.array(envelopeSchema);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const statePath = resolve(repoRoot, requireArg(args, "state"));

const legacyType = "void.face_affect";
const currentType = "void.persona_affect";

const raw = await readFile(statePath);
const entries = envelopeArraySchema.parse(decode(raw)).map((entry) => ({
  ...entry,
  payload: normalizePayload(entry.payload),
}));

const legacyEntries = entries.filter((entry) => entry.type === legacyType);
const currentEntries = entries.filter((entry) => entry.type === currentType);

if (legacyEntries.length === 0) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    statePath,
    migrated: 0,
    reason: "no_legacy_face_affect_document",
  })}\n`);
  process.exit(0);
}

if (currentEntries.length > 0) {
  throw new Error(
    `Refusing to migrate ${statePath}: found ${legacyEntries.length} ${legacyType} and ${currentEntries.length} ${currentType} document(s). Merge by hand.`,
  );
}

const migrated = entries.map((entry) =>
  entry.type === legacyType
    ? {
      ...entry,
      type: currentType,
      storedAt: new Date().toISOString(),
    }
    : entry
);

await writeFile(statePath, encode(migrated));

process.stdout.write(`${JSON.stringify({
  ok: true,
  statePath,
  migrated: legacyEntries.length,
  from: legacyType,
  to: currentType,
})}\n`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requireArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required --${key} argument.`);
  }
  return value;
}

function normalizePayload(payload) {
  if (payload instanceof Uint8Array) {
    return payload;
  }
  if (Array.isArray(payload)) {
    return Uint8Array.from(payload);
  }
  return Uint8Array.from(payload.data);
}
