export * from "./channel-indexing";
export * from "./history-message-kind";
export * from "./prompt-template";

export const commandNames = [
  "ask",
  "search-history",
  "summarize-channel",
  "queue-codex",
  "approve-job",
  "reject-job",
  "provider-status",
  "profile",
  "reindex-channel",
  "set-style",
  "repo-persona-rumination",
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
  replyToMessageId?: string;
}

export interface SourceMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  isBot?: boolean;
  attachments?: SourceMessageAttachment[];
}

export interface SourceMessageAttachment {
  id?: string;
  filename?: string;
  contentType?: string;
  url?: string;
  proxyUrl?: string;
  size?: number;
  width?: number;
  height?: number;
  localPath?: string;
  kind: "image" | "other";
}

export interface PromptImageAttachment {
  messageId: string;
  authorName: string;
  filename?: string;
  contentType?: string;
  localPath: string;
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

export interface VoidSelfStateContext {
  sourcePath: string;
  loadedAt: string;
  summary: string;
  projection?: VoidSelfStateProjection;
}

export interface VoidSelfStateProjection {
  mode: "awake" | "napping";
  effortCeiling: "normal" | "minimal";
  napStartedAt?: string;
  napEndsAt?: string;
  nextNapAt?: string;
  activeDreamThemes: string[];
  recentDreamSummaries: string[];
  replyDirective?: string;
  affect?: {
    needs: Array<{
      id: string;
      kind: string;
      status: string;
      target: Record<string, unknown>;
      summary: string;
      intensity: number;
      valence: number;
    }>;
    socialBonds: Array<{
      id: string;
      stance: string;
      target: Record<string, unknown>;
      summary: string;
      intensity: number;
    }>;
    statusReads: Array<{
      id: string;
      status: string;
      target: Record<string, unknown>;
      summary: string;
      intensity: number;
    }>;
    moodDimensions: Array<{
      name: string;
      value: number;
      source?: string;
    }>;
  };
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

export interface InteractionMemoryDimension {
  key: string;
  label: string;
  score: number;
  summary: string;
}

export const pronounSets = ["they/them", "he/him", "she/her"] as const;
export type PronounSet = (typeof pronounSets)[number];

export const pronounEvidenceSources = [
  "explicit_self_statement",
  "explicit_correction",
  "direct_third_party_statement",
  "contextual_relational_inference",
  "ambient_usage",
] as const;
export type PronounEvidenceSource = (typeof pronounEvidenceSources)[number];

export const pronounEvidenceStances = ["prefer", "avoid"] as const;
export type PronounEvidenceStance = (typeof pronounEvidenceStances)[number];

export const pronounPolicies = ["explicit", "inferred", "conflicted", "unknown"] as const;
export type PronounPolicy = (typeof pronounPolicies)[number];

export interface PronounEvidence {
  pronounSet: PronounSet;
  source: PronounEvidenceSource;
  stance: PronounEvidenceStance;
  confidence: number;
  excerpt: string;
  timestamp: string;
}

export interface ScoredProfileLabel {
  key: string;
  label: string;
  score: number;
  summary: string;
}

export const socialReadUnderlyingOrganizationKeys = [
  "self_coherence",
  "contingent_worth",
  "shame_sensitivity",
  "reciprocity_capacity",
  "mentalization_quality",
  "authenticity_tolerance",
  "mask_rigidity",
  "external_regulation_dependence",
] as const;
export type SocialReadUnderlyingOrganizationKey =
  (typeof socialReadUnderlyingOrganizationKeys)[number];

export const socialReadStableDispositionKeys = [
  "novelty_seeking",
  "conformity",
  "status_hunger",
  "risk_tolerance",
  "sociability",
  "baseline_threat_sensitivity",
  "aesthetic_appetite",
  "ideological_rigidity",
] as const;
export type SocialReadStableDispositionKey =
  (typeof socialReadStableDispositionKeys)[number];

export const socialReadBehavioralDimensionKeys = [
  "interpersonal_warmth",
  "drive",
  "grandiosity",
  "validation_seeking",
  "anxiety",
  "control_pressure",
  "hostility",
  "suspicion",
  "rigidity",
  "withdrawal",
  "volatility",
  "attachment_seeking",
  "distance_seeking",
] as const;
export type SocialReadBehavioralDimensionKey =
  (typeof socialReadBehavioralDimensionKeys)[number];

export const socialReadPresentationStrategyKeys = [
  "charm",
  "compliance",
  "superiority",
  "detachment",
  "seductiveness",
  "competence_theater",
  "moral_theater",
  "strategic_opacity",
  "cultivated_harmlessness",
  "abrasive_boundary",
  "ironic_distance",
] as const;
export type SocialReadPresentationStrategyKey =
  (typeof socialReadPresentationStrategyKeys)[number];

export const socialReadVoiceStyleKeys = [
  "dryness",
  "verbal_warmth",
  "formality",
  "verbosity",
  "pace",
  "plainspoken_directness",
  "lexical_precision",
  "technical_density",
  "technical_compression",
  "figurative_language",
  "lyricism",
  "narrative_detail",
  "emotional_explicitness",
  "pointedness",
  "self_disclosure",
  "hedging",
  "certainty_marking",
  "politeness",
  "coded_politeness",
  "ritualized_address",
  "register_switching",
  "dialect_marking",
  "theatricality",
  "humor",
  "conversational_dominance",
  "listening_responsiveness",
  "question_asking",
  "profanity",
] as const;
export type SocialReadVoiceStyleKey =
  (typeof socialReadVoiceStyleKeys)[number];

export const socialReadSituationalStateKeys = [
  "exhaustion",
  "scarcity_pressure",
  "humiliation",
  "panic",
  "triumph",
  "grief",
  "overstimulation",
  "grievance_activation",
  "acute_shame",
  "perceived_status_threat",
] as const;
export type SocialReadSituationalStateKey =
  (typeof socialReadSituationalStateKeys)[number];

export interface TranscriptParticipantRead {
  actorId: string;
  actorName: string;
  summary: string;
  underlyingOrganization: SocialReadUnderlyingOrganizationKey[];
  stableDispositions: SocialReadStableDispositionKey[];
  behavioralDimensions: SocialReadBehavioralDimensionKey[];
  presentationStrategies: SocialReadPresentationStrategyKey[];
  voiceStyle: SocialReadVoiceStyleKey[];
  situationalState: SocialReadSituationalStateKey[];
  pronounEvidence: PronounEvidence[];
  supportingSignals: string[];
}

export interface StoredTranscriptParticipantRead {
  actorId: string;
  actorName: string;
  summary: string;
  underlyingOrganization: SocialReadUnderlyingOrganizationKey[];
  stableDispositions: SocialReadStableDispositionKey[];
  behavioralDimensions: SocialReadBehavioralDimensionKey[];
  presentationStrategies: SocialReadPresentationStrategyKey[];
  voiceStyle: SocialReadVoiceStyleKey[];
  pronounEvidence: PronounEvidence[];
  supportingSignals: string[];
  observedAt: string;
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
  interactionDimensions: InteractionMemoryDimension[];
  underlyingOrganizationScores: ScoredProfileLabel[];
  stableDispositionScores: ScoredProfileLabel[];
  behavioralDimensionScores: ScoredProfileLabel[];
  presentationStrategyScores: ScoredProfileLabel[];
  voiceStyleScores: ScoredProfileLabel[];
  responseGuidance: string;
  pronounPolicy: PronounPolicy;
  resolvedPronounSet?: PronounSet;
  resolvedPronounSets: PronounSet[];
  pronounConfidence?: number;
  pronounGuidance: string;
  pronounEvidence: PronounEvidence[];
  socialReadEvidence: StoredTranscriptParticipantRead[];
  lastInteractionAt?: string;
  recentEvents: InteractionMemoryEvent[];
}

export interface SourceGroundingHint {
  required: boolean;
  reasons: string[];
  matchedRepoNames: string[];
}

export interface SituationalSocialRead {
  summary: string;
  roomTone: string;
  speakerCurrentRead: string;
  socialFrame: string;
  responseGuidance: string;
  supportingSignals: string[];
  pronounEvidence: PronounEvidence[];
  participantReads: TranscriptParticipantRead[];
}

export interface ContextBundle {
  prompt: string;
  actor: Actor;
  guildContext: GuildContext;
  recentMessages: SourceMessage[];
  imageAttachments?: PromptImageAttachment[];
  retrieval: RetrievalResult[];
  interactionMemory?: InteractionMemoryProfile;
  situationalSocialRead?: SituationalSocialRead;
  sourceGrounding?: SourceGroundingHint;
  stylePack?: StylePack;
  voidSelfState?: VoidSelfStateContext;
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
