import type { RetrievalFilters, RetrievalResult } from "@voidbot/shared";

import { FileMessageArchiveRepository } from "./message-archive";
import { RetrievalService } from "./retrieval-service";

const HISTORY_ECHO_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "could",
  "from",
  "have",
  "please",
  "pretty",
  "tell",
  "that",
  "them",
  "they",
  "this",
  "what",
  "with",
  "would",
  "your",
]);

interface HistorySearchWithArchiveFallbackOptions {
  retrievalService: RetrievalService;
  archiveRepository: FileMessageArchiveRepository;
  query: string;
  limit: number;
  guildId?: string;
  channelId?: string;
  authorId?: string;
  includeBotPrompts?: boolean;
  preserveOverfetch?: boolean;
}

export async function searchHistoryWithArchiveFallback(
  options: HistorySearchWithArchiveFallbackOptions,
): Promise<RetrievalResult[]> {
  const overfetchLimit = Math.max(options.limit * 3, options.limit + 4);
  const vectorResults = await options.retrievalService.searchHistory(
    options.query,
    overfetchLimit,
    {
      guildId: options.guildId,
      channelId: options.channelId,
      authorId: options.authorId,
    },
  );

  const lexicalResults = await options.archiveRepository.searchLexical(
    options.query,
    overfetchLimit,
    {
      guildId: options.guildId,
      channelId: options.channelId,
      authorId: options.authorId,
      includeBotPrompts: options.includeBotPrompts ?? false,
    },
  );

  if (lexicalResults.length === 0) {
    return options.preserveOverfetch
      ? vectorResults
      : vectorResults.slice(0, options.limit);
  }

  const merged = [...vectorResults];
  const seenSourceIds = new Set(merged.map((result) => result.sourceId));

  for (const result of lexicalResults) {
    if (seenSourceIds.has(result.sourceId)) {
      continue;
    }

    merged.push(result);
    seenSourceIds.add(result.sourceId);

    if (merged.length >= overfetchLimit) {
      break;
    }
  }

  return options.preserveOverfetch ? merged : merged.slice(0, options.limit);
}

export function filterPromptEchoHistoryResults<
  T extends {
    text: string;
  },
>(results: T[], query: string): T[] {
  const normalizedQuery = normalizeHistoryEchoText(query);
  const queryTokens = buildHistoryEchoTokens(normalizedQuery);

  if (normalizedQuery.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => {
    const normalizedResult = normalizeHistoryEchoText(result.text);

    if (normalizedResult.length === 0) {
      return true;
    }

    if (normalizedResult === normalizedQuery) {
      return false;
    }

    if (queryTokens.length >= 4) {
      const resultTokens = buildHistoryEchoTokens(normalizedResult);
      const sharedTokenCount = countSharedTokens(queryTokens, resultTokens);
      const similarity =
        sharedTokenCount /
        Math.max(Math.min(queryTokens.length, resultTokens.length), 1);

      if (similarity >= 0.7) {
        return false;
      }
    }

    if (
      normalizedQuery.length >= 48 &&
      (normalizedResult.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedResult))
    ) {
      return false;
    }

    return true;
  });

  return filtered.length > 0 ? filtered : results;
}

function normalizeHistoryEchoText(value: string): string {
  return value
    .replace(/<@!?\d+>/g, " ")
    .replace(/<@&\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildHistoryEchoTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4)
        .filter((token) => !HISTORY_ECHO_STOP_WORDS.has(token)),
    ),
  ];
}

function countSharedTokens(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.reduce(
    (count, token) => count + (rightSet.has(token) ? 1 : 0),
    0,
  );
}
