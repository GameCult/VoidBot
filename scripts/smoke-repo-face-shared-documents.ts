import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRepoFaceSharedDocument,
  listRepoFaceSharedDocuments,
  updateRepoFaceSharedDocument,
} from "@voidbot/core";

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voidbot-shared-documents-"));
  const path = join(directory, "shared.cc");

  try {
  const created = await createRepoFaceSharedDocument({
    canonicalPath: path,
    documentId: "coordination-note",
    title: "Coordination note",
    body: "Initial state",
    actorId: "face-a",
    now: "2026-07-12T00:00:00.000Z",
  });
  if (created.version !== 1 || created.createdBy !== "face-a") {
    throw new Error("Create lost initial revision provenance.");
  }

  const updated = await updateRepoFaceSharedDocument({
    canonicalPath: path,
    documentId: "coordination-note",
    body: "Updated state",
    expectedVersion: 1,
    actorId: "face-b",
    now: "2026-07-12T00:05:00.000Z",
  });
  if (updated.version !== 2 || updated.updatedBy !== "face-b") {
    throw new Error("Update lost revision provenance.");
  }

  let rejected = false;
  try {
    await updateRepoFaceSharedDocument({
      canonicalPath: path,
      documentId: "coordination-note",
      body: "Stale overwrite",
      expectedVersion: 1,
      actorId: "face-c",
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("A stale update overwrote shared state.");
  }

  const documents = await listRepoFaceSharedDocuments(path);
  if (documents.length !== 1 || documents[0]?.body !== "Updated state") {
    throw new Error("Canonical shared state was not preserved.");
  }
  console.log(JSON.stringify({ ok: true, document: documents[0] }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void main();
