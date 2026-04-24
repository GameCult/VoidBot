import { type VectorStore } from "@voidbot/shared";

import {
  type ArchivedSourceDocument,
  type SourceDocumentSyncResult,
  FileSourceDocumentArchiveRepository,
} from "./source-document-archive";
import { SourceDocumentIngester } from "./source-document-ingester";

const SOURCE_UPSERT_BATCH_SIZE = 64;

export interface SourceRagIngestResult {
  createdDocuments: number;
  updatedDocuments: number;
  unchangedDocuments: number;
  deletedDocuments: number;
  indexedChunks: number;
}

export class SourceRagPipeline {
  public constructor(
    private readonly archiveRepository: FileSourceDocumentArchiveRepository,
    private readonly sourceIngester: SourceDocumentIngester,
    private readonly vectorStore: VectorStore,
  ) {}

  public async syncRepoDocuments(
    repoName: string,
    documents: ArchivedSourceDocument[],
    options?: {
      forceReindex?: boolean;
    },
  ): Promise<SourceRagIngestResult> {
    const mutation = await this.archiveRepository.syncRepoDocuments(repoName, documents);
    await this.replaceChangedChunks(repoName, mutation, options?.forceReindex ?? false);

    return {
      createdDocuments: mutation.created,
      updatedDocuments: mutation.updated,
      unchangedDocuments: mutation.unchanged,
      deletedDocuments: mutation.deleted,
      indexedChunks: this.sourceIngester.chunkDocuments(mutation.activeDocuments).length,
    };
  }

  private async replaceChangedChunks(
    repoName: string,
    mutation: SourceDocumentSyncResult,
    forceReindex: boolean,
  ): Promise<void> {
    const documentsToUpsert = forceReindex ? mutation.activeDocuments : mutation.changedDocuments;

    if (forceReindex) {
      await this.vectorStore.deleteByFilters({
        corpusKind: "repository_source",
        repoName,
      });
    } else if (mutation.changedSourceIds.length > 0) {
      await this.vectorStore.deleteBySourceIds(mutation.changedSourceIds);
    }

    if (documentsToUpsert.length === 0) {
      return;
    }

    const chunks = this.sourceIngester.chunkDocuments(documentsToUpsert);

    for (let index = 0; index < chunks.length; index += SOURCE_UPSERT_BATCH_SIZE) {
      const batch = chunks.slice(index, index + SOURCE_UPSERT_BATCH_SIZE);

      if (batch.length === 0) {
        continue;
      }

      await this.vectorStore.upsert(batch);
    }
  }
}
