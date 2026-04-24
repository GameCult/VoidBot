import {
  type RetrievalFilters,
  type RetrievalResult,
  type VectorStore,
} from "@voidbot/shared";

export class RetrievalService {
  public constructor(
    private readonly historyVectorStore: VectorStore,
    private readonly sourceVectorStore: VectorStore = historyVectorStore,
  ) {}

  public async search(
    query: string,
    limit = 5,
    filters?: RetrievalFilters,
  ): Promise<RetrievalResult[]> {
    return this.historyVectorStore.query(query, limit, filters);
  }

  public async searchHistory(
    query: string,
    limit = 5,
    filters?: Omit<RetrievalFilters, "corpusKind">,
  ): Promise<RetrievalResult[]> {
    return this.historyVectorStore.query(query, limit, {
      ...filters,
      corpusKind: "discord_history",
    });
  }

  public async searchRepositorySources(
    query: string,
    limit = 5,
    filters?: Omit<RetrievalFilters, "corpusKind" | "guildId" | "channelId" | "authorId">,
  ): Promise<RetrievalResult[]> {
    return this.sourceVectorStore.query(query, limit, {
      ...filters,
      corpusKind: "repository_source",
    });
  }
}
