import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import {
  type ArchivedMessage,
  type ChannelIndexingPolicy,
  shouldIndexChannel,
} from "@voidbot/shared";

import { type ImportedFileState, type RagImportState } from "./import-state";

export interface DiscordLogImportOptions {
  recursive?: boolean;
  channelIndexing?: ChannelIndexingPolicy;
  previousState?: RagImportState;
}

export interface DiscordLogImportResult {
  messages: ArchivedMessage[];
  filesScanned: number;
  filesImported: number;
  filesSkipped: number;
  invalidRecords: number;
  nextState: RagImportState;
}

export async function importDiscordLogs(
  inputPath: string,
  options: DiscordLogImportOptions = {},
): Promise<DiscordLogImportResult> {
  const recursive = options.recursive ?? true;
  const logFiles = await collectLogFiles(resolve(inputPath), recursive);
  const previousFileState = new Map(
    (options.previousState?.files ?? []).map((file) => [resolve(file.path), file]),
  );
  const nextFiles: ImportedFileState[] = [];
  const messagesById = new Map<string, ArchivedMessage>();
  let filesImported = 0;
  let filesSkipped = 0;
  let invalidRecords = 0;

  for (const filePath of logFiles) {
    const metadata = await stat(filePath);
    const descriptor: ImportedFileState = {
      path: filePath,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
    nextFiles.push(descriptor);

    const previous = previousFileState.get(filePath);

    if (previous && previous.size === descriptor.size && previous.mtimeMs === descriptor.mtimeMs) {
      filesSkipped += 1;
      continue;
    }

    const importResult = await parseLogFile(filePath, options.channelIndexing);
    filesImported += 1;
    invalidRecords += importResult.invalidRecords;

    for (const message of importResult.messages) {
      messagesById.set(message.id, message);
    }
  }

  return {
    messages: [...messagesById.values()],
    filesScanned: logFiles.length,
    filesImported,
    filesSkipped,
    invalidRecords,
    nextState: {
      lastRunAt: new Date().toISOString(),
      files: nextFiles.sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
}

async function collectLogFiles(inputPath: string, recursive: boolean): Promise<string[]> {
  const inputStats = await stat(inputPath);

  if (inputStats.isFile()) {
    return isSupportedLogFile(inputPath) ? [inputPath] : [];
  }

  const entries = await readdir(inputPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(inputPath, entry.name);

    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...(await collectLogFiles(fullPath, recursive)));
      }

      continue;
    }

    if (entry.isFile() && isSupportedLogFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function isSupportedLogFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return extension === ".json" || extension === ".jsonl" || extension === ".ndjson";
}

async function parseLogFile(
  filePath: string,
  channelIndexing?: ChannelIndexingPolicy,
): Promise<{ messages: ArchivedMessage[]; invalidRecords: number }> {
  const extension = extname(filePath).toLowerCase();
  const raw = stripLeadingBom(await readFile(filePath, "utf8"));
  const messages: ArchivedMessage[] = [];
  let invalidRecords = 0;

  if (extension === ".jsonl" || extension === ".ndjson") {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (trimmed.length === 0) {
        continue;
      }

      try {
        const candidate = JSON.parse(trimmed) as unknown;
        const normalized = normalizeArchivedMessage(candidate, filePath);

        if (!normalized) {
          invalidRecords += 1;
          continue;
        }

        if (!shouldImportArchivedMessage(normalized, channelIndexing)) {
          continue;
        }

        messages.push(normalized);
      } catch {
        invalidRecords += 1;
      }
    }

    return { messages, invalidRecords };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const candidates = flattenCandidates(parsed);

    for (const candidate of candidates) {
      const normalized = normalizeArchivedMessage(candidate, filePath);

      if (!normalized) {
        invalidRecords += 1;
        continue;
      }

      if (!shouldImportArchivedMessage(normalized, channelIndexing)) {
        continue;
      }

      messages.push(normalized);
    }
  } catch {
    invalidRecords += 1;
  }

  return { messages, invalidRecords };
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function flattenCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value)) {
    for (const key of ["messages", "items", "data", "results"]) {
      const candidate = value[key];

      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
  }

  return [value];
}

function normalizeArchivedMessage(
  candidate: unknown,
  sourceFile: string,
): ArchivedMessage | undefined {
  if (!isRecord(candidate)) {
    return undefined;
  }

  const id = readString(candidate, ["id"]) ?? readString(candidate, ["messageId"]);
  const channelId =
    readString(candidate, ["channelId"]) ??
    readString(candidate, ["channel_id"]) ??
    readString(candidate, ["channel", "id"]);
  const authorId =
    readString(candidate, ["authorId"]) ??
    readString(candidate, ["author_id"]) ??
    readString(candidate, ["author", "id"]) ??
    readString(candidate, ["user", "id"]);
  const authorName =
    readString(candidate, ["authorName"]) ??
    readString(candidate, ["author_name"]) ??
    readString(candidate, ["author", "displayName"]) ??
    readString(candidate, ["author", "username"]) ??
    readString(candidate, ["user", "displayName"]) ??
    readString(candidate, ["user", "username"]);
  const content =
    readString(candidate, ["content"]) ??
    readString(candidate, ["message"]) ??
    readString(candidate, ["text"]);
  const timestamp =
    readString(candidate, ["timestamp"]) ??
    readString(candidate, ["createdAt"]) ??
    readString(candidate, ["created_at"]);

  if (!id || !channelId || !authorId || !authorName || content === undefined || !timestamp) {
    return undefined;
  }

  const channelName =
    readString(candidate, ["channelName"]) ??
    readString(candidate, ["channel_name"]) ??
    readString(candidate, ["channel", "name"]);
  const parentChannelId =
    readString(candidate, ["parentChannelId"]) ??
    readString(candidate, ["parent_channel_id"]) ??
    readString(candidate, ["parentChannel", "id"]) ??
    readString(candidate, ["parent", "id"]);
  const parentChannelName =
    readString(candidate, ["parentChannelName"]) ??
    readString(candidate, ["parent_channel_name"]) ??
    readString(candidate, ["parentChannel", "name"]) ??
    readString(candidate, ["parent", "name"]);
  const metadata: Record<string, string> = {
    sourceFile: basename(sourceFile),
  };

  if (channelName) {
    metadata.channelName = channelName;
  }

  if (parentChannelId) {
    metadata.parentChannelId = parentChannelId;
  }

  if (parentChannelName) {
    metadata.parentChannelName = parentChannelName;
  }

  return {
    id,
    guildId:
      readString(candidate, ["guildId"]) ??
      readString(candidate, ["guild_id"]) ??
      readString(candidate, ["guild", "id"]),
    channelId,
    authorId,
    authorName,
    content,
    timestamp: normalizeTimestamp(timestamp),
    editedAt:
      readString(candidate, ["editedAt"]) ??
      readString(candidate, ["edited_at"]) ??
      readString(candidate, ["editedTimestamp"]),
    deletedAt:
      readString(candidate, ["deletedAt"]) ??
      readString(candidate, ["deleted_at"]),
    threadId:
      readString(candidate, ["threadId"]) ??
      readString(candidate, ["thread_id"]) ??
      readString(candidate, ["thread", "id"]),
    attachments: readAttachments(candidate),
    metadata,
  };
}

function shouldImportArchivedMessage(
  message: ArchivedMessage,
  channelIndexing?: ChannelIndexingPolicy,
): boolean {
  if (!channelIndexing) {
    return true;
  }

  return shouldIndexChannel(channelIndexing, {
    channelId: message.channelId,
    channelName: message.metadata?.channelName,
    parentChannelId: message.metadata?.parentChannelId,
    parentChannelName: message.metadata?.parentChannelName,
  });
}

function readAttachments(candidate: Record<string, unknown>): string[] | undefined {
  const rawAttachments = candidate.attachments;

  if (!Array.isArray(rawAttachments)) {
    return undefined;
  }

  const attachments = rawAttachments
    .map((attachment) => {
      if (!isRecord(attachment)) {
        return undefined;
      }

      return (
        readString(attachment, ["url"]) ??
        readString(attachment, ["proxy_url"]) ??
        readString(attachment, ["name"]) ??
        readString(attachment, ["filename"])
      );
    })
    .filter((attachment): attachment is string => Boolean(attachment));

  return attachments.length > 0 ? attachments : undefined;
}

function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function readString(source: Record<string, unknown>, path: string[]): string | undefined {
  let cursor: unknown = source;

  for (const segment of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }

    cursor = cursor[segment];
  }

  return typeof cursor === "string" ? cursor : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
