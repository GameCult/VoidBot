import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { normalizeText } from "./history-ingester";
import { SerializedFileStore } from "./file-store";

export interface ArchivedSourceDocument {
  id: string;
  repoName: string;
  path: string;
  language?: string;
  title?: string;
  content: string;
  lastModifiedAt?: string;
  metadata?: Record<string, string>;
}

export interface ArchivedSourceDocumentRecord extends ArchivedSourceDocument {
  normalizedContent: string;
  indexedAt: string;
}

export interface IndexedSourceRepoSummary {
  repoName: string;
  documentCount: number;
}

interface LegacySourceDocumentArchiveStore {
  version: 1;
  documents: ArchivedSourceDocumentRecord[];
}

interface SourceDocumentArchiveManifest {
  version: 2;
  repos: IndexedSourceRepoSummary[];
}

interface SourceDocumentRepoShardStore {
  version: 1;
  repoName: string;
  documents: ArchivedSourceDocumentRecord[];
}

export interface SourceDocumentSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  previousRepoSourceIds: string[];
  changedSourceIds: string[];
  changedDocuments: ArchivedSourceDocumentRecord[];
  activeDocuments: ArchivedSourceDocumentRecord[];
}

export interface SourceDocumentSyncPlan extends SourceDocumentSyncResult {
  previousDocuments: ArchivedSourceDocumentRecord[];
}

export class FileSourceDocumentArchiveRepository {
  private readonly manifestStore: SerializedFileStore<SourceDocumentArchiveManifest>;
  private readonly shardRoot: string;
  private initialization?: Promise<void>;

  public constructor(
    private readonly filePath: string,
    private readonly options: { readOnly?: boolean } = {},
  ) {
    this.manifestStore = new SerializedFileStore(filePath, () => ({
      version: 2,
      repos: [],
    }), options);
    this.shardRoot = deriveShardRoot(filePath);
  }

  public async syncRepoDocuments(
    repoName: string,
    documents: ArchivedSourceDocument[],
  ): Promise<SourceDocumentSyncResult> {
    const plan = await this.planRepoDocuments(repoName, documents);
    await this.commitRepoDocuments(repoName, plan);
    return plan;
  }

  public async planRepoDocuments(
    repoName: string,
    documents: ArchivedSourceDocument[],
  ): Promise<SourceDocumentSyncPlan> {
    await this.ensureInitialized();

    const shardStore = this.getRepoShardStore(repoName);
    const store = await shardStore.snapshot();
    return buildSyncPlan(store.documents, documents);
  }

  public async commitRepoDocuments(
    repoName: string,
    plan: SourceDocumentSyncPlan,
  ): Promise<void> {
    await this.ensureInitialized();

    const shardStore = this.getRepoShardStore(repoName);
    await shardStore.mutate((store) => {
      if (!sameDocumentSet(store.documents, plan.previousDocuments)) {
        throw new Error(`Source archive changed while ${repoName} was being indexed.`);
      }

      store.documents = plan.activeDocuments.slice();
    });

    await this.syncRepoSummary(repoName, plan.activeDocuments.length);

    if (plan.activeDocuments.length === 0) {
      await this.deleteRepoShard(repoName);
    }
  }

  public async get(sourceId: string): Promise<ArchivedSourceDocumentRecord | undefined> {
    await this.ensureInitialized();
    const repoName = parseRepoNameFromSourceId(sourceId);

    if (!repoName) {
      return undefined;
    }

    const store = await this.getRepoShardStore(repoName).snapshot();
    return store.documents.find((document) => document.id === sourceId);
  }

  public async listAll(): Promise<ArchivedSourceDocumentRecord[]> {
    await this.ensureInitialized();
    const summaries = await this.listRepoSummaries();
    const repoDocuments = await Promise.all(
      summaries.map((summary) => this.listByRepo(summary.repoName)),
    );

    return repoDocuments.flat().sort(compareDocuments);
  }

  public async listByRepo(repoName: string): Promise<ArchivedSourceDocumentRecord[]> {
    await this.ensureInitialized();
    const store = await this.getRepoShardStore(repoName).snapshot();
    return store.documents.slice().sort(compareDocuments);
  }

  public async listRepoSummaries(): Promise<IndexedSourceRepoSummary[]> {
    await this.ensureInitialized();
    const store = await this.manifestStore.snapshot();
    return store.repos
      .slice()
      .sort((left, right) => left.repoName.localeCompare(right.repoName));
  }

  public async count(): Promise<number> {
    const summaries = await this.listRepoSummaries();
    return summaries.reduce((total, summary) => total + summary.documentCount, 0);
  }

  public async normalizeStore(): Promise<void> {
    await this.ensureInitialized();

    const summaries = await this.listRepoSummaries();
    await this.manifestStore.normalize();

    for (const summary of summaries) {
      await this.getRepoShardStore(summary.repoName).normalize();
    }
  }

  public async removeRepo(repoName: string): Promise<string[]> {
    await this.ensureInitialized();

    const shardStore = this.getRepoShardStore(repoName);
    const store = await shardStore.snapshot();
    const deletedSourceIds = store.documents.map((document) => document.id);

    await this.deleteRepoShard(repoName);
    await this.syncRepoSummary(repoName, 0);

    return deletedSourceIds;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initialize();
    }

    await this.initialization;
  }

  private async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await mkdir(this.shardRoot, { recursive: true });

    const raw = await readRawFile(this.filePath);

    if (!raw) {
      return;
    }

    const parsed = parseArchivePayload(raw);

    if (isManifestStore(parsed)) {
      return;
    }

    if (isLegacyStore(parsed)) {
      await this.migrateLegacyStore(parsed);
    }
  }

  private async migrateLegacyStore(legacyStore: LegacySourceDocumentArchiveStore): Promise<void> {
    const documentsByRepo = new Map<string, ArchivedSourceDocumentRecord[]>();

    for (const document of legacyStore.documents) {
      const repoDocuments = documentsByRepo.get(document.repoName) ?? [];
      repoDocuments.push(document);
      documentsByRepo.set(document.repoName, repoDocuments);
    }

    for (const [repoName, documents] of documentsByRepo.entries()) {
      const shardStore = this.getRepoShardStore(repoName);
      await shardStore.overwrite({
        version: 1,
        repoName,
        documents: documents.slice().sort(compareDocuments),
      });
    }

    const backupPath = `${this.filePath}.legacy-${Date.now()}.bak`;
    await rename(this.filePath, backupPath).catch(async () => {
      await rm(backupPath, { force: true }).catch(() => undefined);
      await rename(this.filePath, backupPath);
    });

    await this.manifestStore.overwrite({
      version: 2,
      repos: [...documentsByRepo.entries()]
        .map(([repoName, documents]) => ({
          repoName,
          documentCount: documents.length,
        }))
        .sort((left, right) => left.repoName.localeCompare(right.repoName)),
    });
  }

  private getRepoShardStore(repoName: string): SerializedFileStore<SourceDocumentRepoShardStore> {
    return new SerializedFileStore(resolveRepoShardPath(this.shardRoot, repoName), () => ({
      version: 1,
      repoName,
      documents: [],
    }), this.options);
  }

  private async syncRepoSummary(repoName: string, documentCount: number): Promise<void> {
    await this.manifestStore.mutate((manifest) => {
      const retainedRepos = manifest.repos.filter((summary) => summary.repoName !== repoName);

      if (documentCount > 0) {
        retainedRepos.push({
          repoName,
          documentCount,
        });
      }

      manifest.repos = retainedRepos.sort((left, right) => left.repoName.localeCompare(right.repoName));
    });
  }

  private async deleteRepoShard(repoName: string): Promise<void> {
    await rm(resolveRepoShardPath(this.shardRoot, repoName), { force: true }).catch(() => undefined);
  }
}

function deriveShardRoot(filePath: string): string {
  const extension = extname(filePath);
  const baseName = extension.length > 0 ? basename(filePath, extension) : basename(filePath);
  return join(dirname(filePath), `${baseName}.repos`);
}

function resolveRepoShardPath(shardRoot: string, repoName: string): string {
  const safeRepoName = encodeURIComponent(repoName);
  return join(shardRoot, `${safeRepoName}.json`);
}

async function readRawFile(filePath: string): Promise<string | undefined> {
  try {
    return stripLeadingBom(await readFile(filePath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function parseArchivePayload(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    const lines = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length > 1) {
      return JSON.parse(lines[0]);
    }

    throw error;
  }
}

function isLegacyStore(value: unknown): value is LegacySourceDocumentArchiveStore {
  return Boolean(
    value &&
      typeof value === "object" &&
      "version" in value &&
      (value as { version?: unknown }).version === 1 &&
      "documents" in value &&
      Array.isArray((value as { documents?: unknown }).documents),
  );
}

function isManifestStore(value: unknown): value is SourceDocumentArchiveManifest {
  return Boolean(
    value &&
      typeof value === "object" &&
      "version" in value &&
      (value as { version?: unknown }).version === 2 &&
      "repos" in value &&
      Array.isArray((value as { repos?: unknown }).repos),
  );
}

function parseRepoNameFromSourceId(sourceId: string): string | undefined {
  const separatorIndex = sourceId.indexOf(":");

  if (separatorIndex <= 0) {
    return undefined;
  }

  return sourceId.slice(0, separatorIndex);
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function toArchivedSourceDocumentRecord(
  document: ArchivedSourceDocument,
  indexedAt: string,
): ArchivedSourceDocumentRecord {
  return {
    ...document,
    normalizedContent: normalizeText(document.content),
    indexedAt,
  };
}

function areEquivalent(
  left: ArchivedSourceDocumentRecord,
  right: ArchivedSourceDocumentRecord,
): boolean {
  return JSON.stringify(comparableFields(left)) === JSON.stringify(comparableFields(right));
}

function buildSyncPlan(
  previousDocuments: ArchivedSourceDocumentRecord[],
  documents: ArchivedSourceDocument[],
): SourceDocumentSyncPlan {
  const now = new Date().toISOString();
  const nextDocuments = documents.map((document) => toArchivedSourceDocumentRecord(document, now));
  const existingById = new Map(previousDocuments.map((document) => [document.id, document]));
  const nextIds = new Set(nextDocuments.map((document) => document.id));
  const changedSourceIds: string[] = [];
  const changedDocuments: ArchivedSourceDocumentRecord[] = [];
  const activeDocuments: ArchivedSourceDocumentRecord[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const document of nextDocuments) {
    const existing = existingById.get(document.id);

    if (!existing) {
      activeDocuments.push(document);
      changedSourceIds.push(document.id);
      changedDocuments.push(document);
      created += 1;
    } else if (areEquivalent(existing, document)) {
      activeDocuments.push(existing);
      unchanged += 1;
    } else {
      activeDocuments.push(document);
      changedSourceIds.push(document.id);
      changedDocuments.push(document);
      updated += 1;
    }
  }

  const deletedSourceIds = previousDocuments
    .filter((document) => !nextIds.has(document.id))
    .map((document) => document.id);
  changedSourceIds.push(...deletedSourceIds);

  return {
    created,
    updated,
    unchanged,
    deleted: deletedSourceIds.length,
    previousRepoSourceIds: previousDocuments.map((document) => document.id),
    changedSourceIds,
    changedDocuments,
    activeDocuments: activeDocuments.sort(compareDocuments),
    previousDocuments: previousDocuments.slice(),
  };
}

function sameDocumentSet(
  left: ArchivedSourceDocumentRecord[],
  right: ArchivedSourceDocumentRecord[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparableFields(document: ArchivedSourceDocumentRecord): Record<string, unknown> {
  return {
    id: document.id,
    repoName: document.repoName,
    path: document.path,
    language: document.language,
    title: document.title,
    content: canonicalizeLineEndings(document.content),
    metadata: document.metadata ?? {},
  };
}

function canonicalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function compareDocuments(
  left: ArchivedSourceDocumentRecord,
  right: ArchivedSourceDocumentRecord,
): number {
  const repoComparison = left.repoName.localeCompare(right.repoName);

  if (repoComparison !== 0) {
    return repoComparison;
  }

  return left.path.localeCompare(right.path);
}
