import { z } from "zod/v3";

import {
  MAX_RETRIEVAL_RESULT_LIMIT,
  type RetrievalResult,
} from "@voidbot/shared";
import { type ArchivedMessageRecord } from "@voidbot/rag";

export const searchHistoryInputSchema = {
  query: z.string().min(1).max(240),
  limit: z.number().int().min(1).max(MAX_RETRIEVAL_RESULT_LIMIT).optional(),
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  authorId: z.string().min(1).optional(),
};

export const messageContextInputSchema = {
  messageId: z.string().min(1),
  before: z.number().int().min(0).max(20).optional(),
  after: z.number().int().min(0).max(20).optional(),
};

export const notifyOwnerInputSchema = {
  message: z.string().min(1).max(1800),
};

export const postDiscordMessageInputSchema = {
  channelId: z.string().min(1),
  content: z.string().min(1).max(1800),
  replyToMessageId: z.string().min(1).optional(),
  personaName: z.string().min(1).max(80).optional(),
  personaAvatarUrl: z.string().url().max(512).optional(),
};

export const postRepoIdentityMessageInputSchema = {
  identity: z.string().min(1),
  channelId: z.string().min(1),
  content: z.string().min(1).max(1800),
  replyToMessageId: z.string().min(1).optional(),
};

export const repoFaceStateInputSchema = {
  identity: z.string().min(1),
};

export const applyRepoFaceStateOperationInputSchema = {
  identity: z.string().min(1),
  operation: z.record(z.unknown()),
};

export const runtimeInfoInputSchema = {};

export const searchSourcesInputSchema = {
  query: z.string().min(1).max(240),
  limit: z.number().int().min(1).max(MAX_RETRIEVAL_RESULT_LIMIT).optional(),
  repoName: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
};

export const searchWebInputSchema = {
  query: z.string().min(1).max(240),
  limit: z.number().int().min(1).max(8).optional(),
};

export const readWebpageInputSchema = {
  url: z.string().url().max(2048),
  maxChars: z.number().int().min(500).max(12000).optional(),
};

export const sourceContextInputSchema = {
  sourceId: z.string().min(1),
  chunkIndex: z.number().int().min(0).optional(),
  before: z.number().int().min(0).max(20).optional(),
  after: z.number().int().min(0).max(20).optional(),
};

export interface SearchHistoryArgs {
  query: string;
  limit?: number;
  guildId?: string;
  channelId?: string;
  authorId?: string;
}

export interface MessageContextArgs {
  messageId: string;
  before?: number;
  after?: number;
}

export interface NotifyOwnerArgs {
  message: string;
}

export interface PostDiscordMessageArgs {
  channelId: string;
  content: string;
  replyToMessageId?: string;
  personaName?: string;
  personaAvatarUrl?: string;
}

export interface PostRepoIdentityMessageArgs {
  identity: string;
  channelId: string;
  content: string;
  replyToMessageId?: string;
}

export interface RepoFaceStateArgs {
  identity: string;
}

export interface ApplyRepoFaceStateOperationArgs {
  identity: string;
  operation: Record<string, unknown>;
}

export interface RuntimeInfoArgs {
  [key: string]: never;
}

export interface ListIndexedReposArgs {
  [key: string]: never;
}

export interface SearchSourcesArgs {
  query: string;
  limit?: number;
  repoName?: string;
  pathPrefix?: string;
  language?: string;
}

export interface SearchWebArgs {
  query: string;
  limit?: number;
}

export interface ReadWebpageArgs {
  url: string;
  maxChars?: number;
}

export interface SourceContextArgs {
  sourceId: string;
  chunkIndex?: number;
  before?: number;
  after?: number;
}

export function formatArchivedMessage(
  message: ArchivedMessageRecord,
  anchorMessageId: string,
): Record<string, unknown> {
  return {
    id: message.id,
    isAnchor: message.id === anchorMessageId,
    timestamp: message.timestamp,
    authorId: message.authorId,
    authorName: message.authorName,
    channelId: message.channelId,
    channelName: message.metadata?.channelName,
    threadId: message.threadId,
    content: message.content,
    jumpUrl: message.metadata?.jumpUrl,
    editedAt: message.editedAt,
  };
}

export function renderJsonBlock(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function jsonResource(uri: URL, payload: Record<string, unknown>) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function getRequiredVariable(
  variables: Record<string, string | string[]>,
  key: string,
  context: string,
): string {
  const value = getOptionalVariable(variables, key);

  if (!value) {
    throw new Error(`Missing required ${key} for ${context}.`);
  }

  return value;
}

export function getOptionalVariable(
  variables: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const value = variables[key];

  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseOptionalInt(value: string | string[] | undefined): number | undefined {
  const normalized = Array.isArray(value) ? value[0] : value;

  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function formatHistoryResults(results: RetrievalResult[]) {
  return results.map((result) => ({
    score: Number(result.score.toFixed(4)),
    text: result.text,
    sourceId: result.sourceId,
    channelId: result.metadata.channelId,
    channelName: result.metadata.channelName,
    authorId: result.metadata.authorId,
    authorName: result.metadata.authorName,
    timestamp: result.metadata.timestamp,
    jumpUrl: result.metadata.jumpUrl,
    threadId: result.metadata.threadId,
  }));
}

export function formatSourceResults(results: RetrievalResult[]) {
  return results.map((result) => ({
    score: Number(result.score.toFixed(4)),
    text: result.text,
    sourceId: result.sourceId,
    repoName: result.metadata.repoName,
    path: result.metadata.path,
    language: result.metadata.language,
    title: result.metadata.title,
    chunkIndex: Number(result.metadata.chunkIndex ?? 0),
    lineStart: Number(result.metadata.lineStart ?? 1),
    lineEnd: Number(result.metadata.lineEnd ?? 1),
    lastModifiedAt: result.metadata.lastModifiedAt,
  }));
}
