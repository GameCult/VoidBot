import { type ArchivedMessage } from "@voidbot/shared";

import { normalizeText } from "./history-ingester";
import { SerializedFileStore } from "./file-store";

export interface ArchivedMessageRecord extends ArchivedMessage {
  normalizedContent: string;
  indexedAt: string;
}

interface MessageArchiveStore {
  version: 1;
  messages: ArchivedMessageRecord[];
}

export interface MessageArchiveMutationResult {
  created: number;
  updated: number;
  unchanged: number;
  storedMessages: ArchivedMessageRecord[];
  changedMessageIds: string[];
}

export class FileMessageArchiveRepository {
  private readonly store: SerializedFileStore<MessageArchiveStore>;

  public constructor(filePath: string) {
    this.store = new SerializedFileStore(filePath, () => ({
      version: 1,
      messages: [],
    }));
  }

  public async upsert(messages: ArchivedMessage[]): Promise<MessageArchiveMutationResult> {
    return this.store.mutate((store) => {
      const now = new Date().toISOString();
      const positions = new Map(store.messages.map((message, index) => [message.id, index]));
      const storedMessages: ArchivedMessageRecord[] = [];
      const changedMessageIds: string[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;

      for (const message of messages) {
        const normalized = toArchivedMessageRecord(message, now);
        const position = positions.get(message.id);

        if (position === undefined) {
          store.messages.push(normalized);
          positions.set(message.id, store.messages.length - 1);
          storedMessages.push(normalized);
          changedMessageIds.push(message.id);
          created += 1;
          continue;
        }

        const existing = store.messages[position];

        if (areEquivalent(existing, normalized)) {
          storedMessages.push(existing);
          unchanged += 1;
          continue;
        }

        const nextRecord: ArchivedMessageRecord = {
          ...normalized,
          indexedAt: now,
        };
        store.messages[position] = nextRecord;
        storedMessages.push(nextRecord);
        changedMessageIds.push(message.id);
        updated += 1;
      }

      return {
        created,
        updated,
        unchanged,
        storedMessages,
        changedMessageIds,
      };
    });
  }

  public async markDeleted(messageId: string, deletedAt = new Date().toISOString()): Promise<boolean> {
    return this.store.mutate((store) => {
      const message = store.messages.find((candidate) => candidate.id === messageId);

      if (!message) {
        return false;
      }

      if (message.deletedAt === deletedAt) {
        return false;
      }

      message.deletedAt = deletedAt;
      message.indexedAt = new Date().toISOString();
      return true;
    });
  }

  public async get(messageId: string): Promise<ArchivedMessageRecord | undefined> {
    const store = await this.store.snapshot();
    return store.messages.find((message) => message.id === messageId);
  }

  public async listByChannel(channelId: string, limit = 100): Promise<ArchivedMessageRecord[]> {
    const store = await this.store.snapshot();

    return store.messages
      .filter((message) => message.channelId === channelId && !message.deletedAt)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-limit);
  }

  public async listContextWindow(
    messageId: string,
    before = 4,
    after = 4,
  ): Promise<ArchivedMessageRecord[]> {
    const store = await this.store.snapshot();
    const anchor = store.messages.find((message) => message.id === messageId);

    if (!anchor) {
      return [];
    }

    const messages = store.messages
      .filter((message) => !message.deletedAt && belongsToSameConversation(message, anchor))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const anchorIndex = messages.findIndex((message) => message.id === messageId);

    if (anchorIndex === -1) {
      return [];
    }

    const start = Math.max(0, anchorIndex - before);
    const end = Math.min(messages.length, anchorIndex + after + 1);
    return messages.slice(start, end);
  }

  public async listAll(): Promise<ArchivedMessageRecord[]> {
    const store = await this.store.snapshot();

    return store.messages
      .slice()
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  public async listAllActive(): Promise<ArchivedMessageRecord[]> {
    const messages = await this.listAll();
    return messages.filter((message) => !message.deletedAt);
  }

  public async count(): Promise<number> {
    const store = await this.store.snapshot();
    return store.messages.length;
  }
}

function toArchivedMessageRecord(
  message: ArchivedMessage,
  indexedAt: string,
): ArchivedMessageRecord {
  return {
    ...message,
    normalizedContent: normalizeText(message.content),
    indexedAt,
  };
}

function areEquivalent(left: ArchivedMessageRecord, right: ArchivedMessageRecord): boolean {
  return JSON.stringify(comparableFields(left)) === JSON.stringify(comparableFields(right));
}

function comparableFields(message: ArchivedMessageRecord): Record<string, unknown> {
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.authorId,
    authorName: message.authorName,
    content: message.content,
    timestamp: message.timestamp,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    threadId: message.threadId,
    attachments: message.attachments ?? [],
    metadata: message.metadata ?? {},
  };
}

function belongsToSameConversation(
  candidate: ArchivedMessageRecord,
  anchor: ArchivedMessageRecord,
): boolean {
  if (anchor.threadId || candidate.threadId) {
    return Boolean(anchor.threadId && candidate.threadId && anchor.threadId === candidate.threadId);
  }

  return candidate.channelId === anchor.channelId;
}
