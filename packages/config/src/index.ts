import { resolve } from "node:path";

import { z } from "zod";

import {
  type ChannelIndexingPolicy,
  type OwnerCodexMode,
  type ProviderName,
  isOwnerCodexMode,
  isProviderName,
  normalizeDiscordChannelName,
} from "@voidbot/shared";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().min(1).optional(),
);

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off", ""].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

type OllamaThinkMode = boolean | "low" | "medium" | "high";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DISCORD_BOT_TOKEN: optionalNonEmptyString,
  DISCORD_APPLICATION_ID: optionalNonEmptyString,
  DISCORD_GUILD_ID: optionalNonEmptyString,
  DISCORD_OWNER_ID: z.string().min(1, "DISCORD_OWNER_ID is required"),
  DISCORD_BOT_TRIGGER_ROLE_IDS: z.string().default(""),
  STATE_STORAGE_BACKEND: z.enum(["file", "postgres"]).default("postgres"),
  DATABASE_DSN: z.string().min(1).default("postgres://voidbot:voidbot@localhost:5432/voidbot"),
  VECTOR_STORE_KIND: z.enum(["local_json", "qdrant"]).default("local_json"),
  VECTOR_STORE_PATH: z.string().min(1).default(".voidbot/history-vector-store.json"),
  SOURCE_VECTOR_STORE_ROOT: z.string().min(1).default(".voidbot/source-vectors"),
  QDRANT_URL: z.string().url().default("http://127.0.0.1:6333"),
  QDRANT_API_KEY: optionalNonEmptyString,
  QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  QDRANT_HISTORY_COLLECTION: z.string().min(1).default("voidbot_discord_history_chunks"),
  QDRANT_SOURCE_COLLECTION: z.string().min(1).default("voidbot_repository_source_chunks"),
  RAG_ARCHIVE_PATH: z.string().min(1).default(".voidbot/rag/messages.json"),
  RAG_SOURCE_ARCHIVE_PATH: z.string().min(1).default(".voidbot/rag/source-documents.json"),
  RAG_IMPORT_STATE_PATH: z.string().min(1).default(".voidbot/rag/import-state.json"),
  RAG_EMBEDDING_BACKEND: z.enum(["hash", "ollama"]).default("ollama"),
  RAG_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(256),
  RAG_OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  RAG_OLLAMA_MODEL: z.string().min(1).default("qwen3-embedding:0.6b"),
  RAG_OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  RAG_QUERY_INSTRUCTION: z
    .string()
    .default(
      "Given a Discord history question, retrieve relevant messages and discussion snippets that answer it.",
    ),
  RAG_SOURCE_QUERY_INSTRUCTION: z
    .string()
    .default(
      "Given a source-tree, codebase, or lore question, retrieve relevant files, code snippets, and lore passages that answer it.",
    ),
  DISCORD_LOG_ROOT: optionalNonEmptyString,
  SOURCE_REPO_ROOT: optionalNonEmptyString,
  SOURCE_REPO_PATTERNS: z.string().default("*"),
  SOURCE_REPO_INCLUDE_PREFIXES: z.string().default("AetheriaLore:Aetheria/"),
  LOCAL_LLM_OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  LOCAL_LLM_OLLAMA_MODEL: z.string().min(1).default("qwen3.5:9b"),
  LOCAL_LLM_SOCIAL_READ_OLLAMA_MODEL: optionalNonEmptyString,
  LOCAL_LLM_OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  LOCAL_LLM_OLLAMA_KEEP_ALIVE: z.string().min(1).default("10m"),
  LOCAL_LLM_OLLAMA_THINK: z.string().default("false"),
  LOCAL_LLM_OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(8192),
  LOCAL_LLM_ALLOW_PUBLIC: booleanFromEnv.default(false),
  STORAGE_ROOT: z.string().min(1).default(".voidbot"),
  ENABLED_PROVIDERS: z.string().min(1).default("owner_codex"),
  OWNER_CODEX_MODE: z.string().min(1).default("local_exec_owner_only"),
  CODEX_EXECUTABLE: z.string().min(1).default("codex"),
  CODEX_EXEC_ARGS: z.string().default(""),
  CODEX_MODEL: z.string().min(1).default("gpt-5.4"),
  CODEX_MODEL_REASONING_EFFORT: z.enum(["low", "medium", "high", "xhigh"]).default("low"),
  CODEX_EXEC_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  STYLE_PACK_PATH: z.string().min(1).default("styles/void-default.md"),
  SYSTEM_MESSAGES_PATH: z.string().min(1).default("config/system-messages.json"),
  MODERATION_AGENT_STATE_PATH: z
    .string()
    .min(1)
    .default(".voidbot/private/void-self-state.cc"),
  REPO_DISCORD_IDENTITIES_PATH: z
    .string()
    .min(1)
    .default(".voidbot/private/repo-discord-identities.json"),
  REPO_FACE_BIRTH_MODE: z.enum(["plan", "run"]).default("plan"),
  REPO_FACE_BIRTH_EXECUTOR: z.enum(["codex-exec", "openai-runtime"]).default("codex-exec"),
  REPO_FACE_GITHUB_ACTIONS_ENABLED: booleanFromEnv.default(false),
  REPO_FACE_BIFROST_ENABLED: booleanFromEnv.default(false),
  BIFROST_ROOT: z.string().min(1).default("E:/Projects/Bifrost"),
  BIFROST_DISCORD_CHANNEL_ID: optionalNonEmptyString,
  REPO_FACE_HEARTBEATS_ENABLED: booleanFromEnv.default(false),
  REPO_FACE_HEARTBEAT_STATE_PATH: z.string().min(1).default(".voidbot/status/repo-face-heartbeats.json"),
  REPO_FACE_HEARTBEAT_TASK_NAME: z.string().min(1).default("VoidBot Repo Face Heartbeats"),
  REPO_FACE_HEARTBEAT_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(5),
  REPO_FACE_HEARTBEAT_MAX_JOBS_PER_TICK: z.coerce.number().int().min(1).max(8).default(2),
  REPO_FACE_HEARTBEAT_DEFAULT_CHANNEL_ID: optionalNonEmptyString,
  REPO_FACE_HEARTBEAT_BASE_RECOVERY_MINUTES: z.coerce.number().positive().default(10),
  REPO_FACE_HEARTBEAT_GLOBAL_HEAT: z.coerce.number().positive().default(1),
  REPO_FACE_HEARTBEAT_SPEED_OVERRIDES: z.string().default(""),
  REPO_FACE_HEARTBEAT_HEAT_OVERRIDES: z.string().default(""),
  REPO_FACE_HEARTBEAT_CODEX_MODEL: z.string().min(1).default("gpt-5.3-codex-spark"),
  REPO_FACE_HEARTBEAT_CODEX_MODELS: z.string().default("gpt-5.3-codex-spark,gpt-5.4-mini"),
  REPO_FACE_HEARTBEAT_CODEX_REASONING_EFFORT: z
    .enum(["low", "medium", "high", "xhigh"])
    .optional(),
  REPO_FACE_STATE_PROJECTOR_ENABLED: booleanFromEnv.default(true),
  EPIPHANY_AGENT_ROOT: z.string().min(1).default("E:/Projects/EpiphanyAgent"),
  INDEX_ALL_CHANNELS: booleanFromEnv.default(false),
  INDEXED_CHANNEL_IDS: z.string().default(""),
  EXCLUDED_CHANNEL_IDS: z.string().default(""),
  EXCLUDED_CHANNEL_NAMES: z.string().default(""),
  VOID_USAGE_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(30),
  VOID_USAGE_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(100),
  VOID_USAGE_UNLIMITED_USER_IDS: z.string().default(""),
  VOID_USAGE_UNLIMITED_ROLE_IDS: z.string().default(""),
  VOID_USAGE_BOOST_USER_IDS: z.string().default(""),
  VOID_USAGE_BOOST_ROLE_IDS: z.string().default(""),
  VOID_USAGE_BOOST_MULTIPLIER: z.coerce.number().int().positive().default(10),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  botToken?: string;
  applicationId?: string;
  developmentGuildId?: string;
  ownerDiscordId: string;
  botTriggerRoleIds: string[];
  stateStorageBackend: "file" | "postgres";
  databaseDsn: string;
  enabledProviders: ProviderName[];
  ownerCodexMode: OwnerCodexMode;
  codexExecutable: string;
  codexExecArgs: string[];
  codexModel: string;
  codexModelReasoningEffort: "low" | "medium" | "high" | "xhigh";
  codexExecTimeoutMs: number;
  stylePackPath: string;
  systemMessagesPath: string;
  moderationAgentStatePath: string;
  repoDiscordIdentitiesPath: string;
  repoFaceBirthMode: "plan" | "run";
  repoFaceBirthExecutor: "codex-exec" | "openai-runtime";
  repoFaceGithubActionsEnabled: boolean;
  repoFaceBifrostEnabled: boolean;
  bifrostRoot: string;
  bifrostDiscordChannelId?: string;
  repoFaceHeartbeats: {
    enabled: boolean;
    statePath: string;
    taskName: string;
    intervalMinutes: number;
    maxJobsPerTick: number;
    defaultChannelId?: string;
    baseRecoveryMinutes: number;
    globalHeat: number;
    speedOverrides: Record<string, number>;
    heatOverrides: Record<string, number>;
    codexModel?: string;
    codexModels: string[];
    codexModelReasoningEffort?: "low" | "medium" | "high" | "xhigh";
    stateProjectorEnabled: boolean;
  };
  epiphanyAgentRoot: string;
  indexAllChannels: boolean;
  indexedChannelIds: string[];
  excludedChannelIds: string[];
  excludedChannelNames: string[];
  channelIndexing: ChannelIndexingPolicy;
  workerPollIntervalMs: number;
  storageRoot: string;
  jobsFile: string;
  auditLogFile: string;
  interactionMemoryFile: string;
  artifactsDir: string;
  rateLimitStateFile: string;
  ragArchivePath: string;
  ragSourceArchivePath: string;
  ragImportStatePath: string;
  ragEmbeddingBackend: "hash" | "ollama";
  ragEmbeddingDimensions: number;
  ragOllamaBaseUrl: string;
  ragOllamaModel: string;
  ragOllamaTimeoutMs: number;
  ragQueryInstruction: string;
  ragSourceQueryInstruction: string;
  discordLogRoot?: string;
  sourceRepoRoot?: string;
  sourceRepoPatterns: string[];
  sourceRepoIncludePrefixes: Record<string, string[]>;
  localLlm: {
    ollamaBaseUrl: string;
    ollamaModel: string;
    socialReadOllamaModel: string;
    ollamaTimeoutMs: number;
    ollamaKeepAlive: string;
    ollamaThink: OllamaThinkMode;
    ollamaNumCtx: number;
    allowPublic: boolean;
  };
  vectorStore: {
    kind: "local_json" | "qdrant";
    path: string;
  };
  sourceVectorStoreRoot: string;
  qdrant: {
    url: string;
    apiKey?: string;
    timeoutMs: number;
    historyCollection: string;
    sourceCollection: string;
  };
  rateLimits: {
    defaultCooldownSeconds: number;
    defaultDailyLimit: number;
    unlimitedUserIds: string[];
    unlimitedRoleIds: string[];
    boostedUserIds: string[];
    boostedRoleIds: string[];
    boostedMultiplier: number;
  };
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseChannelNameList(value: string): string[] {
  return parseList(value)
    .map(normalizeDiscordChannelName)
    .filter((entry) => entry.length > 0);
}

function parseProviders(value: string): ProviderName[] {
  const providers = parseList(value);
  const invalid = providers.filter((provider) => !isProviderName(provider));

  if (invalid.length > 0) {
    throw new Error(`Unsupported providers in ENABLED_PROVIDERS: ${invalid.join(", ")}`);
  }

  return providers as ProviderName[];
}

function parseRepoPrefixRules(value: string): Record<string, string[]> {
  const rules: Record<string, string[]> = {};

  for (const entry of value.split(";")) {
    const trimmed = entry.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const repoName = trimmed.slice(0, separatorIndex).trim();
    const prefixes = trimmed
      .slice(separatorIndex + 1)
      .split("|")
      .map((prefix) => prefix.trim().replace(/\\/g, "/").replace(/^\.\/+/, ""))
      .filter((prefix) => prefix.length > 0)
      .map((prefix) => (prefix.endsWith("/") ? prefix : `${prefix}/`));

    if (repoName.length === 0 || prefixes.length === 0) {
      continue;
    }

    rules[repoName] = prefixes;
  }

  return rules;
}

function parseNumericMap(value: string): Record<string, number> {
  const result: Record<string, number> = {};

  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`Invalid numeric map entry "${trimmed}". Expected key=value.`);
    }

    const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const valueText = trimmed.slice(separatorIndex + 1).trim();
    const numericValue = Number.parseFloat(valueText);

    if (key.length === 0 || !Number.isFinite(numericValue)) {
      throw new Error(`Invalid numeric map entry "${trimmed}". Expected key=value with a finite number.`);
    }

    result[key] = numericValue;
  }

  return result;
}

function parseOwnerCodexMode(value: string): OwnerCodexMode {
  if (!isOwnerCodexMode(value)) {
    throw new Error(
      `Unsupported OWNER_CODEX_MODE "${value}". Expected one of: manual_package, local_exec_owner_only.`,
    );
  }

  return value;
}

function parseOllamaThinkMode(value: string): OllamaThinkMode {
  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }

  throw new Error(
    `Unsupported LOCAL_LLM_OLLAMA_THINK "${value}". Expected true, false, low, medium, or high.`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const storageRoot = resolve(parsed.STORAGE_ROOT);
  const indexedChannelIds = parseList(parsed.INDEXED_CHANNEL_IDS);
  const excludedChannelIds = parseList(parsed.EXCLUDED_CHANNEL_IDS);
  const excludedChannelNames = parseChannelNameList(parsed.EXCLUDED_CHANNEL_NAMES);

  return {
    nodeEnv: parsed.NODE_ENV,
    botToken: parsed.DISCORD_BOT_TOKEN,
    applicationId: parsed.DISCORD_APPLICATION_ID,
    developmentGuildId: parsed.DISCORD_GUILD_ID,
    ownerDiscordId: parsed.DISCORD_OWNER_ID,
    botTriggerRoleIds: parseList(parsed.DISCORD_BOT_TRIGGER_ROLE_IDS),
    stateStorageBackend: parsed.STATE_STORAGE_BACKEND,
    databaseDsn: parsed.DATABASE_DSN,
    enabledProviders: parseProviders(parsed.ENABLED_PROVIDERS),
    ownerCodexMode: parseOwnerCodexMode(parsed.OWNER_CODEX_MODE),
    codexExecutable: parsed.CODEX_EXECUTABLE,
    codexExecArgs: parseList(parsed.CODEX_EXEC_ARGS),
    codexModel: parsed.CODEX_MODEL,
    codexModelReasoningEffort: parsed.CODEX_MODEL_REASONING_EFFORT,
    codexExecTimeoutMs: parsed.CODEX_EXEC_TIMEOUT_MS,
    stylePackPath: resolve(parsed.STYLE_PACK_PATH),
    systemMessagesPath: resolve(parsed.SYSTEM_MESSAGES_PATH),
    moderationAgentStatePath: resolve(parsed.MODERATION_AGENT_STATE_PATH),
    repoDiscordIdentitiesPath: resolve(parsed.REPO_DISCORD_IDENTITIES_PATH),
    repoFaceBirthMode: parsed.REPO_FACE_BIRTH_MODE,
    repoFaceBirthExecutor: parsed.REPO_FACE_BIRTH_EXECUTOR,
    repoFaceGithubActionsEnabled: parsed.REPO_FACE_GITHUB_ACTIONS_ENABLED,
    repoFaceBifrostEnabled: parsed.REPO_FACE_BIFROST_ENABLED,
    bifrostRoot: resolve(parsed.BIFROST_ROOT),
    bifrostDiscordChannelId: parsed.BIFROST_DISCORD_CHANNEL_ID,
    repoFaceHeartbeats: {
      enabled: parsed.REPO_FACE_HEARTBEATS_ENABLED,
      statePath: resolve(parsed.REPO_FACE_HEARTBEAT_STATE_PATH),
      taskName: parsed.REPO_FACE_HEARTBEAT_TASK_NAME,
      intervalMinutes: parsed.REPO_FACE_HEARTBEAT_INTERVAL_MINUTES,
      maxJobsPerTick: parsed.REPO_FACE_HEARTBEAT_MAX_JOBS_PER_TICK,
      defaultChannelId: parsed.REPO_FACE_HEARTBEAT_DEFAULT_CHANNEL_ID,
      baseRecoveryMinutes: parsed.REPO_FACE_HEARTBEAT_BASE_RECOVERY_MINUTES,
      globalHeat: parsed.REPO_FACE_HEARTBEAT_GLOBAL_HEAT,
      speedOverrides: parseNumericMap(parsed.REPO_FACE_HEARTBEAT_SPEED_OVERRIDES),
      heatOverrides: parseNumericMap(parsed.REPO_FACE_HEARTBEAT_HEAT_OVERRIDES),
      codexModel: parsed.REPO_FACE_HEARTBEAT_CODEX_MODEL,
      codexModels: parseList(parsed.REPO_FACE_HEARTBEAT_CODEX_MODELS).length > 0
        ? parseList(parsed.REPO_FACE_HEARTBEAT_CODEX_MODELS)
        : [parsed.REPO_FACE_HEARTBEAT_CODEX_MODEL],
      codexModelReasoningEffort: parsed.REPO_FACE_HEARTBEAT_CODEX_REASONING_EFFORT,
      stateProjectorEnabled: parsed.REPO_FACE_STATE_PROJECTOR_ENABLED,
    },
    epiphanyAgentRoot: resolve(parsed.EPIPHANY_AGENT_ROOT),
    indexAllChannels: parsed.INDEX_ALL_CHANNELS,
    indexedChannelIds,
    excludedChannelIds,
    excludedChannelNames,
    channelIndexing: {
      indexAllChannels: parsed.INDEX_ALL_CHANNELS,
      indexedChannelIds,
      excludedChannelIds,
      excludedChannelNames,
    },
    workerPollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    storageRoot,
    jobsFile: resolve(storageRoot, "jobs", "jobs.json"),
    auditLogFile: resolve(storageRoot, "audit", "events.jsonl"),
    interactionMemoryFile: resolve(storageRoot, "memory", "interactions.json"),
    rateLimitStateFile: resolve(storageRoot, "limits", "usage.json"),
    artifactsDir: resolve(storageRoot, "artifacts"),
    ragArchivePath: resolve(parsed.RAG_ARCHIVE_PATH),
    ragSourceArchivePath: resolve(parsed.RAG_SOURCE_ARCHIVE_PATH),
    ragImportStatePath: resolve(parsed.RAG_IMPORT_STATE_PATH),
    ragEmbeddingBackend: parsed.RAG_EMBEDDING_BACKEND,
    ragEmbeddingDimensions: parsed.RAG_EMBEDDING_DIMENSIONS,
    ragOllamaBaseUrl: parsed.RAG_OLLAMA_BASE_URL,
    ragOllamaModel: parsed.RAG_OLLAMA_MODEL,
    ragOllamaTimeoutMs: parsed.RAG_OLLAMA_TIMEOUT_MS,
    ragQueryInstruction: parsed.RAG_QUERY_INSTRUCTION,
    ragSourceQueryInstruction: parsed.RAG_SOURCE_QUERY_INSTRUCTION,
    discordLogRoot: parsed.DISCORD_LOG_ROOT ? resolve(parsed.DISCORD_LOG_ROOT) : undefined,
    sourceRepoRoot: parsed.SOURCE_REPO_ROOT ? resolve(parsed.SOURCE_REPO_ROOT) : undefined,
    sourceRepoPatterns: parseList(parsed.SOURCE_REPO_PATTERNS),
    sourceRepoIncludePrefixes: parseRepoPrefixRules(parsed.SOURCE_REPO_INCLUDE_PREFIXES),
    localLlm: {
      ollamaBaseUrl: parsed.LOCAL_LLM_OLLAMA_BASE_URL,
      ollamaModel: parsed.LOCAL_LLM_OLLAMA_MODEL,
      socialReadOllamaModel:
        parsed.LOCAL_LLM_SOCIAL_READ_OLLAMA_MODEL ?? parsed.LOCAL_LLM_OLLAMA_MODEL,
      ollamaTimeoutMs: parsed.LOCAL_LLM_OLLAMA_TIMEOUT_MS,
      ollamaKeepAlive: parsed.LOCAL_LLM_OLLAMA_KEEP_ALIVE,
      ollamaThink: parseOllamaThinkMode(parsed.LOCAL_LLM_OLLAMA_THINK),
      ollamaNumCtx: parsed.LOCAL_LLM_OLLAMA_NUM_CTX,
      allowPublic: parsed.LOCAL_LLM_ALLOW_PUBLIC,
    },
    vectorStore: {
      kind: parsed.VECTOR_STORE_KIND,
      path: resolve(parsed.VECTOR_STORE_PATH),
    },
    sourceVectorStoreRoot: resolve(parsed.SOURCE_VECTOR_STORE_ROOT),
    qdrant: {
      url: parsed.QDRANT_URL,
      apiKey: parsed.QDRANT_API_KEY,
      timeoutMs: parsed.QDRANT_TIMEOUT_MS,
      historyCollection: parsed.QDRANT_HISTORY_COLLECTION,
      sourceCollection: parsed.QDRANT_SOURCE_COLLECTION,
    },
    rateLimits: {
      defaultCooldownSeconds: parsed.VOID_USAGE_COOLDOWN_SECONDS,
      defaultDailyLimit: parsed.VOID_USAGE_DAILY_LIMIT,
      unlimitedUserIds: parseList(parsed.VOID_USAGE_UNLIMITED_USER_IDS),
      unlimitedRoleIds: parseList(parsed.VOID_USAGE_UNLIMITED_ROLE_IDS),
      boostedUserIds: parseList(parsed.VOID_USAGE_BOOST_USER_IDS),
      boostedRoleIds: parseList(parsed.VOID_USAGE_BOOST_ROLE_IDS),
      boostedMultiplier: parsed.VOID_USAGE_BOOST_MULTIPLIER,
    },
  };
}
