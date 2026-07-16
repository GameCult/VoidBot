import { resolve } from "node:path";

import { encapsulatePortablePersonaProjection, migrateCanonicalPortablePersonaState, readCanonicalPortablePersonaState } from "@voidbot/core";

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

async function main(): Promise<void> {
  const sourcePath = value("--source");
  const targetPath = value("--target");
  if (!sourcePath || !targetPath) throw new Error("Usage: migrate-portable-persona-state --source <canonical.json> --target <persona.cc> [--write]");
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (process.argv.includes("--projection-import")) {
    if (!process.argv.includes("--write")) {
      process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, mode: "projection_import", sourcePath: source, targetPath: target })}\n`);
      return;
    }
    const result = await encapsulatePortablePersonaProjection({ sourcePath: source, targetPath: target });
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: false, mode: "projection_import", ...result })}\n`);
    return;
  }
  if (!process.argv.includes("--write")) {
    const state = await readCanonicalPortablePersonaState(source);
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, sourcePath: source, targetPath: target, personaId: state.personaId, memoryCount: state.thoughtMemory.memories.length, pressureCount: state.agencyPressure.pressures.length })}\n`);
    return;
  }
  const result = await migrateCanonicalPortablePersonaState({ sourcePath: source, targetPath: target });
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: false, ...result })}\n`);
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
