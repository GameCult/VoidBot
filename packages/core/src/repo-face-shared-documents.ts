import { resolve } from "node:path";

import {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentRegistry,
  defineDocumentType,
} from "cultcache-ts";
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const documentSchema = z.object({
  documentId: nonEmpty.max(120),
  title: nonEmpty.max(240),
  body: z.string().max(20_000),
  version: z.number().int().positive(),
  createdBy: nonEmpty.max(120),
  createdAt: nonEmpty,
  updatedBy: nonEmpty.max(120),
  updatedAt: nonEmpty,
}).strict();

export type RepoFaceSharedDocument = z.infer<typeof documentSchema>;

const documentDefinition = defineDocumentType({
  type: "voidbot.repo_face.shared_document",
  schema: documentSchema,
  name: "documentId",
});
const registry = defineDocumentRegistry(documentDefinition);

export function resolveRepoFaceSharedDocumentsPath(storageRoot: string): string {
  return resolve(storageRoot, "private", "repo-face-shared-documents.cc");
}

export async function listRepoFaceSharedDocuments(canonicalPath: string): Promise<RepoFaceSharedDocument[]> {
  const cache = createCache(canonicalPath);
  await cache.pullAllBackingStores();
  return cache.getAll(documentDefinition).sort((left, right) => left.documentId.localeCompare(right.documentId));
}

export async function createRepoFaceSharedDocument(input: {
  canonicalPath: string;
  documentId: string;
  title: string;
  body: string;
  actorId: string;
  now?: string;
}): Promise<RepoFaceSharedDocument> {
  const documentId = normalizeDocumentId(input.documentId);
  const cache = createCache(input.canonicalPath);
  await cache.pullAllBackingStores();
  if (cache.get(documentDefinition, documentId)) {
    throw new Error(`Shared document "${documentId}" already exists; update it instead.`);
  }
  const now = input.now ?? new Date().toISOString();
  const document = documentSchema.parse({
    documentId,
    title: input.title,
    body: input.body,
    version: 1,
    createdBy: input.actorId,
    createdAt: now,
    updatedBy: input.actorId,
    updatedAt: now,
  });
  return cache.put(documentDefinition, documentId, document);
}

export async function updateRepoFaceSharedDocument(input: {
  canonicalPath: string;
  documentId: string;
  title?: string;
  body: string;
  expectedVersion: number;
  actorId: string;
  now?: string;
}): Promise<RepoFaceSharedDocument> {
  const documentId = normalizeDocumentId(input.documentId);
  const cache = createCache(input.canonicalPath);
  await cache.pullAllBackingStores();
  const existing = cache.get(documentDefinition, documentId);
  if (!existing) {
    throw new Error(`Shared document "${documentId}" does not exist; create it first.`);
  }
  if (existing.version !== input.expectedVersion) {
    throw new Error(
      `Shared document "${documentId}" is at version ${existing.version}, not expected version ${input.expectedVersion}.`,
    );
  }
  const document = documentSchema.parse({
    ...existing,
    title: input.title ?? existing.title,
    body: input.body,
    version: existing.version + 1,
    updatedBy: input.actorId,
    updatedAt: input.now ?? new Date().toISOString(),
  });
  return cache.put(documentDefinition, documentId, document);
}

function createCache(canonicalPath: string): CultCache {
  return CultCache.builder()
    .withRegistry(registry)
    .withGenericStore(new SingleFileMessagePackBackingStore(resolve(canonicalPath)))
    .build();
}

function normalizeDocumentId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return nonEmpty.max(120).parse(normalized);
}
