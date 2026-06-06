#!/usr/bin/env node
import "dotenv/config";

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const core = require(resolve(repoRoot, "packages/core/dist/index.js"));

const args = parseArgs(process.argv.slice(2));
const registryPath = resolve(repoRoot, args.registry ?? ".voidbot/private/repo-discord-identities.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const identities = Array.isArray(registry.identities) ? registry.identities : [];
const failures = [];
const counts = [];

for (const identity of identities) {
  const id = String(identity.id ?? "").toLowerCase();
  const statePath = identity.personaStatePath
    ? resolve(identity.personaStatePath)
    : resolve(repoRoot, ".voidbot/private/repo-personas", `${id}.cc`);

  if (!existsSync(statePath)) {
    failures.push({ id, statePath, reason: "missing_state_path" });
    continue;
  }

  if (extname(statePath).toLowerCase() === ".cc") {
    const state = await core.loadVoidSelfStateTypedDocuments({ canonicalPath: statePath });
    const count = state.personaAffect.stressResponses.length;
    counts.push({ id, format: "cc", count });
    if (count < 1) {
      failures.push({ id, statePath, reason: "no_stress_responses" });
    }
    continue;
  }

  const doc = JSON.parse(readFileSync(statePath, "utf8"));
  const count = Array.isArray(doc.affect?.stressResponses) ? doc.affect.stressResponses.length : 0;
  counts.push({ id, format: "json", count });
  if (count < 1) {
    failures.push({ id, statePath, reason: "no_stress_responses" });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures, counts }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  identities: identities.length,
  counts,
}, null, 2));

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
