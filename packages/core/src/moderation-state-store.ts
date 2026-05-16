import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentType,
} from "cultcache-ts";
import { z } from "zod";

const MODERATION_STATE_DOCUMENT_TYPE = "voidbot.moderation_state";
const MODERATION_STATE_DOCUMENT_KEY = "voidbot.moderation_state/default";

const semanticVectorSchema = z
  .object({
    version: z.number().int().positive(),
    backend: z.string().min(1),
    model: z.string().min(1),
    compactDimensions: z.number().int().positive(),
    sourceHash: z.string().min(1).nullable().optional(),
    embeddedAt: z.string().nullable().optional(),
    values: z.array(z.number()),
  })
  .passthrough();

const memoryLikeSchema = z
  .object({
    memoryId: z.string().min(1).optional(),
    timestamp: z.string().nullable().optional(),
    summary: z.string().optional(),
    semanticVector: semanticVectorSchema.optional(),
  })
  .passthrough();

export const moderationStateSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    agent_id: z.string().min(1),
    identity: z.object({}).passthrough(),
    canonical_state: z.object({}).passthrough(),
    goals: z.array(z.object({}).passthrough()),
    memories: z
      .object({
        episodic: z.array(memoryLikeSchema),
        semantic: z.array(memoryLikeSchema),
        musings: z.array(memoryLikeSchema),
        dreams: z.array(memoryLikeSchema),
      })
      .passthrough(),
    perceived_state_overlays: z.array(z.unknown()),
    moderation_runtime: z
      .object({
        cursor: z
          .object({
            lastReviewedMessageId: z.string().nullable().optional(),
            lastReviewedTimestamp: z.string().nullable().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const moderationStateDocument = defineDocumentType({
  type: MODERATION_STATE_DOCUMENT_TYPE,
  schema: moderationStateSchema,
});

export type ModerationState = z.infer<typeof moderationStateSchema>;

export interface ModerationStatePaths {
  canonicalPath: string;
  workingPath: string;
  legacyJsonPath?: string;
  templatePath?: string;
}

export interface ModerationStateInitResult {
  state: ModerationState;
  canonicalPath: string;
  workingPath: string;
  createdCanonical: boolean;
  migratedFromLegacyJson: boolean;
}

export function getModerationStateWorkingPath(canonicalPath: string): string {
  if (canonicalPath.toLowerCase().endsWith(".msgpack")) {
    return canonicalPath.slice(0, -".msgpack".length) + ".json";
  }

  return `${canonicalPath}.working.json`;
}

export function getModerationStateLegacyJsonPath(canonicalPath: string): string {
  if (canonicalPath.toLowerCase().endsWith(".msgpack")) {
    return canonicalPath.slice(0, -".msgpack".length) + ".json";
  }

  return `${canonicalPath}.json`;
}

export async function ensureModerationStateStore(
  paths: ModerationStatePaths,
): Promise<ModerationStateInitResult> {
  const canonicalPath = resolve(paths.canonicalPath);
  const workingPath = resolve(paths.workingPath);
  const legacyJsonPath = paths.legacyJsonPath ? resolve(paths.legacyJsonPath) : undefined;
  const templatePath = paths.templatePath ? resolve(paths.templatePath) : undefined;

  let createdCanonical = false;
  let migratedFromLegacyJson = false;
  let state: ModerationState | undefined;

  try {
    state = await loadModerationState(canonicalPath);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  if (!state && legacyJsonPath) {
    try {
      state = await loadModerationStateJson(legacyJsonPath);
      migratedFromLegacyJson = true;
      createdCanonical = true;
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
  }

  if (!state) {
    if (!templatePath) {
      throw new Error(`No moderation state exists at ${canonicalPath} and no template path was supplied.`);
    }

    state = await loadModerationStateJson(templatePath);
    createdCanonical = true;
  }

  if (createdCanonical || migratedFromLegacyJson) {
    await saveModerationState(canonicalPath, state);
  }

  await materializeModerationStateWorkingView({
    state,
    workingPath,
  });

  return {
    state,
    canonicalPath,
    workingPath,
    createdCanonical,
    migratedFromLegacyJson,
  };
}

export async function loadModerationState(canonicalPath: string): Promise<ModerationState> {
  const cache = createModerationStateCache(canonicalPath);
  await cache.pullAllBackingStores();
  const state = cache.get(moderationStateDocument, MODERATION_STATE_DOCUMENT_KEY);

  if (!state) {
    throw createEnoentError(`No moderation state exists at ${canonicalPath}.`);
  }

  return cloneJson(state);
}

export async function loadModerationStateJson(path: string): Promise<ModerationState> {
  const raw = await readFile(path, "utf8");
  return moderationStateSchema.parse(JSON.parse(stripBom(raw)));
}

export async function saveModerationState(
  canonicalPath: string,
  state: ModerationState,
): Promise<void> {
  const cache = createModerationStateCache(canonicalPath);
  await cache.put(moderationStateDocument, MODERATION_STATE_DOCUMENT_KEY, state);
}

export async function materializeModerationStateWorkingView(options: {
  state: ModerationState;
  workingPath: string;
}): Promise<void> {
  const projected = projectModerationStateForWorkingView(options.state);
  await mkdir(dirname(options.workingPath), { recursive: true });
  await writeFile(options.workingPath, `${JSON.stringify(projected, null, 2)}\n`, "utf8");
}

export function projectModerationStateForWorkingView(state: ModerationState): ModerationState {
  return stripSemanticVectors(cloneJson(state));
}

export async function commitModerationStateWorkingView(
  paths: ModerationStatePaths,
): Promise<ModerationState> {
  const canonicalPath = resolve(paths.canonicalPath);
  const workingPath = resolve(paths.workingPath);
  const previous = await loadModerationState(canonicalPath);
  const working = await loadModerationStateJson(workingPath);
  const merged = reattachSemanticVectors(previous, working);
  await saveModerationState(canonicalPath, merged);
  await materializeModerationStateWorkingView({ state: merged, workingPath });
  return merged;
}

export async function readModerationStateCursor(canonicalPath: string): Promise<{
  lastReviewedMessageId?: string | null;
  lastReviewedTimestamp?: string | null;
}> {
  const state = await loadModerationState(canonicalPath);
  return {
    lastReviewedMessageId: state.moderation_runtime.cursor?.lastReviewedMessageId ?? null,
    lastReviewedTimestamp: state.moderation_runtime.cursor?.lastReviewedTimestamp ?? null,
  };
}

export async function setModerationStateCursor(
  paths: ModerationStatePaths,
  cursor: {
    lastReviewedMessageId?: string | null;
    lastReviewedTimestamp?: string | null;
  },
): Promise<ModerationState> {
  const canonicalPath = resolve(paths.canonicalPath);
  const workingPath = resolve(paths.workingPath);
  const state = await loadModerationState(canonicalPath);
  state.moderation_runtime.cursor = {
    lastReviewedMessageId: cursor.lastReviewedMessageId ?? null,
    lastReviewedTimestamp: cursor.lastReviewedTimestamp ?? null,
  };
  await saveModerationState(canonicalPath, state);
  await materializeModerationStateWorkingView({ state, workingPath });
  return state;
}

export interface ModerationDeliveryReceipt {
  sentAt: string;
  mode?: string | null;
  transport?: string | null;
  channelId?: string | null;
  replyToMessageId?: string | null;
  personaName?: string | null;
  personaAvatarUrl?: string | null;
  contentLength?: number | null;
  chunkCount?: number | null;
  preview?: string | null;
}

export async function recordModerationDeliveryReceipt(
  paths: ModerationStatePaths,
  receipt: ModerationDeliveryReceipt,
): Promise<ModerationState> {
  const canonicalPath = resolve(paths.canonicalPath);
  const workingPath = resolve(paths.workingPath);
  const state = await loadModerationState(canonicalPath);
  const runtime = cloneJson(state.moderation_runtime);
  const runtimeRecord = runtime as Record<string, unknown>;
  const receipts = readArray(runtimeRecord, "recent_delivery_receipts")
    .filter(isObject)
    .filter((entry): entry is Record<string, unknown> => !!readString(entry, "sentAt"));

  const normalizedReceipt = normalizeDeliveryReceipt(receipt);
  const receiptKey = readString(normalizedReceipt, "receiptKey");
  const existing = receipts.find(
    (entry) =>
      readString(entry, "receiptKey") === receiptKey ||
      (readString(normalizedReceipt, "replyToMessageId") &&
        readString(entry, "replyToMessageId") ===
          readString(normalizedReceipt, "replyToMessageId") &&
        readString(entry, "previewHash") === readString(normalizedReceipt, "previewHash")),
  );

  if (existing) {
    Object.assign(existing, normalizedReceipt);
  } else {
    receipts.push(normalizedReceipt);
  }

  runtimeRecord.recent_delivery_receipts = receipts
    .sort(compareDeliveryReceiptsBySentAt)
    .slice(-24);
  closeAnsweredOpenCases(runtimeRecord, normalizedReceipt);
  state.moderation_runtime = runtime;
  await saveModerationState(canonicalPath, state);
  await materializeModerationStateWorkingView({ state, workingPath });
  return state;
}

function createModerationStateCache(canonicalPath: string): CultCache {
  const cache = new CultCache();
  cache.registerDocumentType(moderationStateDocument);
  cache.addBackingStore(new SingleFileMessagePackBackingStore(canonicalPath));
  return cache;
}

function normalizeDeliveryReceipt(receipt: ModerationDeliveryReceipt) {
  const sentAt = receipt.sentAt;
  const replyToMessageId = receipt.replyToMessageId ?? null;
  const preview = receipt.preview?.trim() ?? null;
  const previewHash = preview ? sha1(preview) : null;
  const receiptKey = sha1(
    JSON.stringify({
      sentAt,
      channelId: receipt.channelId ?? null,
      replyToMessageId,
      previewHash,
      mode: receipt.mode ?? null,
    }),
  );

  return {
    sentAt,
    mode: receipt.mode ?? null,
    transport: receipt.transport ?? null,
    channelId: receipt.channelId ?? null,
    replyToMessageId,
    personaName: receipt.personaName ?? null,
    personaAvatarUrl: receipt.personaAvatarUrl ?? null,
    contentLength: receipt.contentLength ?? null,
    chunkCount: receipt.chunkCount ?? null,
    preview,
    previewHash,
    receiptKey,
  };
}

function compareDeliveryReceiptsBySentAt(left: unknown, right: unknown) {
  const leftSentAt = isObject(left) ? readString(left, "sentAt") ?? "" : "";
  const rightSentAt = isObject(right) ? readString(right, "sentAt") ?? "" : "";
  return leftSentAt.localeCompare(rightSentAt);
}

function closeAnsweredOpenCases(runtime: Record<string, unknown>, receipt: Record<string, unknown>) {
  const replyToMessageId = readString(receipt, "replyToMessageId");
  if (!replyToMessageId) {
    return;
  }

  const preview = readString(receipt, "preview");
  const sentAt = readString(receipt, "sentAt");
  const openCases = readArray(runtime, "open_cases").filter(isObject);

  for (const openCase of openCases) {
    const sourceMessageId = readString(openCase, "sourceMessageId");
    const status = readString(openCase, "status");

    if (sourceMessageId !== replyToMessageId) {
      continue;
    }

    if (status && ["answered", "resolved", "closed", "retired", "dropped"].includes(status)) {
      continue;
    }

    openCase.status = "answered";
    openCase.resolvedAt = sentAt ?? null;
    openCase.lastTouchedAt = sentAt ?? null;
    openCase.resolutionSummary =
      preview && preview.length > 0
        ? `Answered in-channel: ${preview}`
        : "Answered in-channel.";
  }

  runtime.open_cases = openCases;
}

function sha1(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

function reattachSemanticVectors(previous: ModerationState, next: ModerationState): ModerationState {
  const previousVectors = collectSemanticVectors(previous);
  const merged = cloneJson(next);

  for (const entry of iterMemoryEntries(merged)) {
    const memoryId = readString(entry, "memoryId");
    if (!memoryId) {
      continue;
    }

    const priorVector = previousVectors.get(memoryId);
    if (priorVector) {
      entry.semanticVector = cloneJson(priorVector);
    }
  }

  return merged;
}

function collectSemanticVectors(state: ModerationState): Map<string, Record<string, unknown>> {
  const vectors = new Map<string, Record<string, unknown>>();

  for (const entry of iterMemoryEntries(state)) {
    const memoryId = readString(entry, "memoryId");
    if (!memoryId || !isObject(entry.semanticVector)) {
      continue;
    }
    vectors.set(memoryId, cloneJson(entry.semanticVector));
  }

  return vectors;
}

function* iterMemoryEntries(state: ModerationState): Generator<Record<string, unknown>> {
  const memories = state.memories;
  const runtime = state.moderation_runtime as Record<string, unknown>;
  const thoughtLanes = isObject(runtime.thought_lanes) ? (runtime.thought_lanes as Record<string, unknown>) : {};
  const bridge = isObject(runtime.bridge) ? (runtime.bridge as Record<string, unknown>) : {};

  yield* arrayObjects(memories.episodic);
  yield* arrayObjects(memories.semantic);
  yield* arrayObjects(memories.musings);
  yield* arrayObjects(memories.dreams);
  yield* arrayObjects(readArray(runtime, "recent_archive_excursions"));
  yield* arrayObjects(readArray(runtime, "recent_repo_activity_sweeps"));
  yield* arrayObjects(readArray(readObject(thoughtLanes, "analytic"), "active_threads"));
  yield* arrayObjects(readArray(readObject(thoughtLanes, "associative"), "active_threads"));
  yield* arrayObjects(readArray(bridge, "recent_syntheses"));
  yield* arrayObjects(readArray(runtime, "candidate_interventions"));
}

function stripSemanticVectors<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSemanticVectors(entry)) as T;
  }

  if (!isObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (key === "semanticVector") {
      continue;
    }
    next[key] = stripSemanticVectors(child);
  }

  return next as T;
}

function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function readObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return isObject(value[key]) ? (value[key] as Record<string, unknown>) : {};
}

function readArray(value: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(value[key]) ? (value[key] as unknown[]) : [];
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function createEnoentError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}
