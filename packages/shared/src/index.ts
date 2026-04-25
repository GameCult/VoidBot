export * from "./channel-indexing";

export const commandNames = [
  "ask",
  "search-history",
  "summarize-channel",
  "queue-codex",
  "approve-job",
  "reject-job",
  "provider-status",
  "reindex-channel",
  "set-style",
] as const;

export type CommandName = (typeof commandNames)[number];

export const providerNames = ["owner_codex", "openai_api", "local_llm"] as const;
export type ProviderName = (typeof providerNames)[number];

export const trustTiers = ["T0", "T1", "T2"] as const;
export type TrustTier = (typeof trustTiers)[number];

export const jobStates = [
  "queued",
  "awaiting_approval",
  "approved",
  "running",
  "awaiting_post_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobState = (typeof jobStates)[number];

export const sandboxProfileNames = [
  "read_only_lookup",
  "rag_maintenance",
  "owner_workflow",
  "public_low_risk",
] as const;

export type SandboxProfileName = (typeof sandboxProfileNames)[number];

export const ownerCodexModes = [
  "manual_package",
  "local_exec_owner_only",
] as const;

export type OwnerCodexMode = (typeof ownerCodexModes)[number];

export const DEFAULT_RETRIEVAL_RESULT_LIMIT = 5;
export const MAX_RETRIEVAL_RESULT_LIMIT = 12;

export interface Actor {
  id: string;
  displayName: string;
  isAdmin: boolean;
  isBot?: boolean;
}

export interface GuildContext {
  guildId?: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  threadId?: string;
}

export interface SourceMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
}

export interface RetrievalResult {
  chunkId: string;
  score: number;
  text: string;
  sourceId: string;
  sourceKind: "discord_message" | "source_document";
  metadata: Record<string, string>;
}

export interface RetrievalFilters {
  corpusKind?: "discord_history" | "repository_source";
  guildId?: string;
  channelId?: string;
  authorId?: string;
  repoName?: string;
  pathPrefix?: string;
  language?: string;
  sourceId?: string;
}

export interface StylePack {
  name: string;
  instructions: string;
  enabled: boolean;
}

export const interactionMemorySentiments = [
  "warm",
  "positive",
  "neutral",
  "negative",
  "hostile",
] as const;

export type InteractionMemorySentiment =
  (typeof interactionMemorySentiments)[number];

export const interactionMemorySourceKinds = [
  "direct_prompt",
  "ambient_mention",
] as const;

export type InteractionMemorySourceKind =
  (typeof interactionMemorySourceKinds)[number];

export const interactionMemoryDispositions = [
  "warm",
  "friendly",
  "neutral",
  "mixed",
  "wary",
  "hostile",
] as const;

export type InteractionMemoryDisposition =
  (typeof interactionMemoryDispositions)[number];

export interface InteractionMemoryEvent {
  id: string;
  actorId: string;
  actorName: string;
  sourceKind: InteractionMemorySourceKind;
  guildId?: string;
  channelId: string;
  channelName?: string;
  command?: CommandName;
  prompt: string;
  excerpt: string;
  summary: string;
  sentiment: InteractionMemorySentiment;
  score: number;
  tags: string[];
  timestamp: string;
}

export interface InteractionMemoryProfile {
  actorId: string;
  actorName: string;
  disposition: InteractionMemoryDisposition;
  affinityScore: number;
  totalInteractions: number;
  directInteractionCount: number;
  ambientMentionCount: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  summary: string;
  psychologicalProfile: string;
  inferredTraits: string[];
  responseGuidance: string;
  lastInteractionAt?: string;
  recentEvents: InteractionMemoryEvent[];
}

export interface SourceGroundingHint {
  required: boolean;
  reasons: string[];
  matchedRepoNames: string[];
}

export interface ContextBundle {
  prompt: string;
  actor: Actor;
  guildContext: GuildContext;
  recentMessages: SourceMessage[];
  retrieval: RetrievalResult[];
  interactionMemory?: InteractionMemoryProfile;
  sourceGrounding?: SourceGroundingHint;
  stylePack?: StylePack;
  createdAt: string;
}

export interface JobApprovalRecord {
  stage: "run" | "post";
  status: "approved" | "rejected";
  actorId: string;
  reason?: string;
  createdAt: string;
}

export interface JobRecord {
  id: string;
  command: CommandName;
  state: JobState;
  provider: ProviderName;
  runApprovalRequired: boolean;
  postApprovalRequired: boolean;
  requester: Actor;
  guildContext: GuildContext;
  prompt: string;
  contextBundle: ContextBundle;
  createdAt: string;
  updatedAt: string;
  outputChannelId: string;
  requestMessageId?: string;
  summary?: string;
  manualArtifacts?: Record<string, string>;
  finalResponse?: string;
  approvals: JobApprovalRecord[];
  error?: string;
}

export interface ProviderRequest {
  provider: ProviderName;
  contextBundle: ContextBundle;
  options?: Record<string, unknown>;
}

export interface ProviderArtifact {
  name: string;
  contentType: "markdown" | "json" | "text";
  content: string;
}

export interface CodexMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export const providerNotificationChannels = ["owner_dm"] as const;
export type ProviderNotificationChannel = (typeof providerNotificationChannels)[number];

export const providerNotificationReasons = [
  "completion",
  "failure",
  "handoff",
  "custom",
] as const;
export type ProviderNotificationReason = (typeof providerNotificationReasons)[number];

export interface ProviderNotificationIntent {
  channel: ProviderNotificationChannel;
  reason: ProviderNotificationReason;
  message: string;
}

export interface ProviderResponse {
  status: "ready_for_review" | "completed";
  summary: string;
  outputText?: string;
  artifacts?: ProviderArtifact[];
  metadata?: Record<string, string>;
  notifications?: ProviderNotificationIntent[];
}

export interface ModerationResult {
  allowed: boolean;
  reason?: string;
}

export interface ProviderAdapter {
  getName(): ProviderName;
  getCapabilities(): string[];
  isEnabled(): boolean;
  isAllowedForActor(actor: Actor, guildContext: GuildContext): boolean;
  buildRequest(
    contextBundle: ContextBundle,
    options?: Record<string, unknown>,
  ): ProviderRequest;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
  estimateCost(request: ProviderRequest): Promise<number>;
  moderateInput?(request: ProviderRequest): Promise<ModerationResult>;
  moderateOutput?(response: ProviderResponse): Promise<ModerationResult>;
  getAuditRedactions(): string[];
}

export interface AuditEvent {
  id: string;
  type: string;
  timestamp: string;
  actorId?: string;
  jobId?: string;
  provider?: ProviderName;
  details: Record<string, unknown>;
}

export interface ArchivedMessage {
  id: string;
  guildId?: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  editedAt?: string;
  deletedAt?: string;
  threadId?: string;
  attachments?: string[];
  metadata?: Record<string, string>;
}

export interface EmbeddingChunk {
  id: string;
  sourceId: string;
  sourceKind: "discord_message" | "source_document";
  text: string;
  normalizedText: string;
  metadata: Record<string, string>;
}

export interface VectorStore {
  upsert(chunks: EmbeddingChunk[]): Promise<void>;
  clear(): Promise<void>;
  deleteBySourceIds(sourceIds: string[]): Promise<void>;
  deleteByFilters(filters: RetrievalFilters): Promise<void>;
  query(query: string, limit: number, filters?: RetrievalFilters): Promise<RetrievalResult[]>;
}

export interface SandboxProfile {
  name: SandboxProfileName;
  allowedCommands: string[];
  networkAccess: boolean;
  timeoutMs: number;
  requiresApproval: boolean;
}

export interface SandboxCommandRequest {
  profile: SandboxProfileName;
  command: string;
  args: string[];
  workingDirectory?: string;
  networkAccess?: boolean;
  approved?: boolean;
}

export interface SandboxExecutionResult {
  status: "planned" | "denied";
  stdout: string;
  stderr: string;
  exitCode: number;
  deniedReason?: string;
  dryRun: boolean;
}

export function isProviderName(value: string): value is ProviderName {
  return providerNames.includes(value as ProviderName);
}

export function isOwnerCodexMode(value: string): value is OwnerCodexMode {
  return ownerCodexModes.includes(value as OwnerCodexMode);
}
