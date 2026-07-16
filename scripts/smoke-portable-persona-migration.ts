import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { encapsulatePortablePersonaProjection, loadGamecultPersonaState, loadPersonaProjectionImport, migrateCanonicalPortablePersonaState } from "@voidbot/core";
import { projectGamecultPersonaState } from "../apps/persona-scheduler/dist/persona-standard-state-projector.js";
import { buildGamecultPersonaMemoryChunks } from "../apps/persona-scheduler/dist/persona-memory-context-source.js";
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
    const projection = projectGamecultPersonaState(identity, observation.personaState);
    assert.match(projection, /canonical gamecult\.persona_state\.v0 state loaded from typed CultCache/);
    const chunks = buildGamecultPersonaMemoryChunks({ identity, statePath: targetPath, state: observation.personaState, projectedMemory: projection, observedAt: new Date("2026-07-16T00:00:00Z") });
    assert.ok(chunks.some((chunk) => chunk.id.endsWith(":memory:tengu-stress-wrathful-stillness-test")), "canonical standard memories enter semantic recall indexing");
    assert.ok(chunks.some((chunk) => chunk.id.endsWith(":doctrine:tengu-stance-user-agency")), "canonical doctrine enters semantic recall indexing");
    await assert.rejects(migrateCanonicalPortablePersonaState({ sourcePath: resolve(".voidbot/private/personas/muninn/muninn.persona_state.v0.json"), targetPath: join(directory, "muninn.cc") }), /Refusing to promote projection/);
    const projectionPath = join(directory, "muninn-projection.cc");
    await encapsulatePortablePersonaProjection({ sourcePath: resolve(".voidbot/private/personas/muninn/muninn.persona_state.v0.json"), targetPath: projectionPath, importedAt: "2026-07-16T00:00:00Z" });
    const projectionImport = await loadPersonaProjectionImport(projectionPath);
    assert.equal(projectionImport.authority, "projection", "typed quarantine preserves non-canonical authority");
    assert.equal(projectionImport.payload.personaId, "muninn", "typed quarantine preserves the raw projection payload");
    const projectedIdentity = { ...identity, id: "muninn", displayName: "Muninn", personaStatePath: projectionPath };
    const projectedObservation = await readPersonaStateObservation({ identity: projectedIdentity, storageRoot: directory });
    assert.equal(projectedObservation.status === "ok" && projectedObservation.stateKind, "persona_projection_import", "scheduler distinguishes quarantined projection state from canonical Mind");
    await assert.rejects(migrateCanonicalPortablePersonaState({ sourcePath, targetPath }), /Refusing to overwrite existing Persona state target/);
    console.log("Portable Persona migration smoke passed.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
