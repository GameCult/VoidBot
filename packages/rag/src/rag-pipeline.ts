import { type ArchivedMessage, type VectorStore } from "@voidbot/shared";

import { HistoryIngester } from "./history-ingester";
import {
  type ArchivedMessageRecord,
  type MessageArchiveMutationResult,
  FileMessageArchiveRepository,
} from "./message-archive";

export interface RagIngestResult {
  createdMessages: number;
  updatedMessages: number;
  unchangedMessages: number;
  indexedChunks: number;
}

export class RagPipeline {
  public constructor(
    private readonly archiveRepository: FileMessageArchiveRepository,
    private readonly historyIngester: HistoryIngester,
    private readonly vectorStore: VectorStore,
  ) {}

  public async upsertMessages(messages: ArchivedMessage[]): Promise<RagIngestResult> {
    const mutation = await this.archiveRepository.upsert(messages);
    await this.replaceChangedChunks(mutation);

    return {
      createdMessages: mutation.created,
      updatedMessages: mutation.updated,
      unchangedMessages: mutation.unchanged,
      indexedChunks: this.historyIngester.chunkMessages(
        mutation.storedMessages.filter((message) => !message.deletedAt),
      ).length,
    };
  }

  public async markDeleted(messageId: string, deletedAt?: string): Promise<boolean> {
    const changed = await this.archiveRepository.markDeleted(messageId, deletedAt);

    if (!changed) {
      return false;
    }

    await this.vectorStore.deleteBySourceIds([messageId]);
    return true;
  }

  public async listChannelMessages(channelId: string, limit = 100): Promise<ArchivedMessageRecord[]> {
    return this.archiveRepository.listByChannel(channelId, limit);
  }

  private async replaceChangedChunks(mutation: MessageArchiveMutationResult): Promise<void> {
    if (mutation.changedMessageIds.length === 0) {
      return;
    }

    await this.vectorStore.deleteBySourceIds(mutation.changedMessageIds);

    const activeMessages = mutation.storedMessages.filter((message) => !message.deletedAt);
    const chunks = this.historyIngester.chunkMessages(activeMessages);

    if (chunks.length > 0) {
      await this.vectorStore.upsert(chunks);
    }
  }
}
