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

interface SourceDocumentArchiveStore {
  version: 1;
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

export class FileSourceDocumentArchiveRepository {
  private readonly store: SerializedFileStore<SourceDocumentArchiveStore>;

  public constructor(filePath: string) {
    this.store = new SerializedFileStore(filePath, () => ({
      version: 1,
      documents: [],
    }));
  }

  public async syncRepoDocuments(
    repoName: string,
    documents: ArchivedSourceDocument[],
  ): Promise<SourceDocumentSyncResult> {
    return this.store.mutate((store) => {
      const now = new Date().toISOString();
      const previousRepoSourceIds = store.documents
        .filter((document) => document.repoName === repoName)
        .map((document) => document.id);
      const nextDocuments = documents.map((document) => toArchivedSourceDocumentRecord(document, now));
      const existingById = new Map(store.documents.map((document, index) => [document.id, index]));
      const nextIds = new Set(nextDocuments.map((document) => document.id));
      const changedSourceIds: string[] = [];
      const changedDocuments: ArchivedSourceDocumentRecord[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      let deleted = 0;

      for (const document of nextDocuments) {
        const position = existingById.get(document.id);

        if (position === undefined) {
          store.documents.push(document);
          existingById.set(document.id, store.documents.length - 1);
          changedSourceIds.push(document.id);
          changedDocuments.push(document);
          created += 1;
          continue;
        }

        const existing = store.documents[position];

        if (areEquivalent(existing, document)) {
          unchanged += 1;
          continue;
        }

        store.documents[position] = document;
        changedSourceIds.push(document.id);
        changedDocuments.push(document);
        updated += 1;
      }

      const retainedDocuments = store.documents.filter((document) => {
        if (document.repoName !== repoName) {
          return true;
        }

        if (nextIds.has(document.id)) {
          return true;
        }

        changedSourceIds.push(document.id);
        deleted += 1;
        return false;
      });

      store.documents = retainedDocuments;

      return {
        created,
        updated,
        unchanged,
        deleted,
        previousRepoSourceIds,
        changedSourceIds,
        changedDocuments,
        activeDocuments: retainedDocuments
          .filter((document) => document.repoName === repoName)
          .sort((left, right) => left.path.localeCompare(right.path)),
      };
    });
  }

  public async get(sourceId: string): Promise<ArchivedSourceDocumentRecord | undefined> {
    const store = await this.store.snapshot();
    return store.documents.find((document) => document.id === sourceId);
  }

  public async listAll(): Promise<ArchivedSourceDocumentRecord[]> {
    const store = await this.store.snapshot();
    return store.documents.slice().sort(compareDocuments);
  }

  public async listByRepo(repoName: string): Promise<ArchivedSourceDocumentRecord[]> {
    const documents = await this.listAll();
    return documents.filter((document) => document.repoName === repoName);
  }

  public async listRepoSummaries(): Promise<IndexedSourceRepoSummary[]> {
    const store = await this.store.snapshot();
    const counts = new Map<string, number>();

    for (const document of store.documents) {
      counts.set(document.repoName, (counts.get(document.repoName) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([repoName, documentCount]) => ({
        repoName,
        documentCount,
      }))
      .sort((left, right) => left.repoName.localeCompare(right.repoName));
  }

  public async count(): Promise<number> {
    const store = await this.store.snapshot();
    return store.documents.length;
  }
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

function comparableFields(document: ArchivedSourceDocumentRecord): Record<string, unknown> {
  return {
    id: document.id,
    repoName: document.repoName,
    path: document.path,
    language: document.language,
    title: document.title,
    content: document.content,
    lastModifiedAt: document.lastModifiedAt,
    metadata: document.metadata ?? {},
  };
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
