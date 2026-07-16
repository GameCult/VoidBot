import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadGamecultPersonaState, migrateCanonicalPortablePersonaState } from "@voidbot/core";
import { projectPortablePersonaState } from "../apps/persona-scheduler/dist/persona-portable-state-projector.js";
import { readPersonaStateObservation } from "../apps/persona-scheduler/dist/persona-state-source.js";

void main().catch((error) => { console.error(error); process.exitCode = 1; });

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voidbot-persona-migration-"));
  try {
    const targetPath = join(directory, "tengu.cc");
    const sourcePath = resolve(".voidbot/private/personas/tengu/tengu.persona_state.v0.json");
    await migrateCanonicalPortablePersonaState({ sourcePath, targetPath });
    const state = await loadGamecultPersonaState(targetPath);
    assert.equal(state.thoughtMemory.memories.length, 13, "legacy stress responses are preserved as standard memories");
    assert.ok(state.thoughtMemory.memories.some((memory) => memory.tags.includes("migration:legacy-stress-response") && memory.extensions?.legacyStressResponse), "legacy stress response provenance remains inspectable");
    const identity = { id: "tengu", displayName: "Tengu", repoName: "", roleId: "", identityKind: "native_persona" as const, personaStatePath: targetPath, allowedChannelIds: [] };
    const observation = await readPersonaStateObservation({ identity, storageRoot: directory });
    assert.equal(observation.status, "ok");
    assert.equal(observation.status === "ok" && observation.stateKind, "gamecult_persona");
    if (observation.status !== "ok" || observation.stateKind !== "gamecult_persona") throw new Error("Expected canonical standard Persona state.");
    const projection = projectPortablePersonaState(identity, { status: "ok", statePath: targetPath, state: observation.personaState, schemaVersion: "gamecult.persona_state.v0" });
    assert.match(projection, /canonical gamecult\.persona_state\.v0 state loaded from typed CultCache/);
    await assert.rejects(migrateCanonicalPortablePersonaState({ sourcePath: resolve(".voidbot/private/personas/muninn/muninn.persona_state.v0.json"), targetPath: join(directory, "muninn.cc") }), /Refusing to promote projection/);
    await assert.rejects(migrateCanonicalPortablePersonaState({ sourcePath, targetPath }), /Refusing to overwrite existing Persona state target/);
    console.log("Portable Persona migration smoke passed.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
