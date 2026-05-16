import type { ModerationState } from "./moderation-state-store";
import {
  type VoidCandidateInterventions,
  type VoidModerationCursor,
  type VoidScheduledRuntime,
  type VoidSelfProfile,
  type VoidSpeechReceipts,
  type VoidThoughtMemory,
  voidCandidateInterventionsSchema,
  voidModerationCursorSchema,
  voidScheduledRuntimeSchema,
  voidSelfProfileSchema,
  voidSpeechReceiptsSchema,
  voidThoughtMemorySchema,
} from "./void-self-state-domain";

type JsonObject = Record<string, unknown>;

export interface VoidSelfStateTypedProjection {
  selfProfile: VoidSelfProfile;
  moderationCursor: VoidModerationCursor;
  speechReceipts: VoidSpeechReceipts;
  thoughtMemory: VoidThoughtMemory;
  scheduledRuntime: VoidScheduledRuntime;
  candidateInterventions: VoidCandidateInterventions;
}

export function projectModerationStateToTypedSelfState(
  state: ModerationState,
  options: { projectedAt?: string } = {},
): VoidSelfStateTypedProjection {
  const projectedAt = options.projectedAt ?? new Date().toISOString();
  const legacy = state as unknown as JsonObject;
  const runtime = readObject(legacy, "moderation_runtime");
  const identity = readObject(legacy, "identity");
  const canonicalState = readObject(legacy, "canonical_state");
  const memories = readObject(legacy, "memories");
  const incubation = readObject(runtime, "incubation");

  return {
    selfProfile: voidSelfProfileSchema.parse({
      schemaVersion: 1,
      agentId: readString(legacy, "agent_id") ?? "void-moderator",
      publicName: readString(identity, "name") ?? "Void",
      publicDescription: readString(identity, "public_description"),
      privateNotes: readStringArray(identity, "private_notes").slice(-12),
      values: readArray(canonicalState, "values")
        .map(projectValue)
        .filter((value): value is VoidSelfProfile["values"][number] => Boolean(value)),
      activationProfile: {
        underlyingOrganization: readActivationCategory(canonicalState, "underlying_organization"),
        stableDispositions: readActivationCategory(canonicalState, "stable_dispositions"),
        behavioralDimensions: readActivationCategory(canonicalState, "behavioral_dimensions"),
        presentationStrategy: readActivationCategory(canonicalState, "presentation_strategy"),
        voiceStyle: readActivationCategory(canonicalState, "voice_style"),
        situationalState: readActivationCategory(canonicalState, "situational_state"),
      },
      updatedAt: projectedAt,
    }),
    moderationCursor: voidModerationCursorSchema.parse({
      schemaVersion: 1,
      lastReviewedMessageId: nullToUndefined(readString(readObject(runtime, "cursor"), "lastReviewedMessageId")),
      lastReviewedTimestamp: nullToUndefined(readString(readObject(runtime, "cursor"), "lastReviewedTimestamp")),
      openCases: readArray(runtime, "open_cases")
        .map((entry) => projectOpenCase(entry, projectedAt))
        .filter((entry): entry is VoidModerationCursor["openCases"][number] => Boolean(entry)),
      repoActivityCursor: projectRepoActivityCursor(readObject(runtime, "repo_activity_cursor"), projectedAt),
      updatedAt: projectedAt,
    }),
    speechReceipts: voidSpeechReceiptsSchema.parse({
      schemaVersion: 1,
      recentReceipts: readArray(runtime, "recent_delivery_receipts")
        .map(projectDeliveryReceipt)
        .filter((entry): entry is VoidSpeechReceipts["recentReceipts"][number] => Boolean(entry))
        .slice(-24),
      updatedAt: projectedAt,
    }),
    thoughtMemory: voidThoughtMemorySchema.parse({
      schemaVersion: 1,
      memories: [
        ...projectMemoryBucket(readArray(memories, "semantic"), "distilled_seam", projectedAt),
        ...projectMemoryBucket(readArray(memories, "musings"), "distilled_seam", projectedAt),
        ...projectMemoryBucket(readArray(memories, "dreams"), "dream_residue", projectedAt),
      ].slice(-80),
      incubation: readArray(incubation, "active_thoughts")
        .map((entry) => projectIncubationThread(entry, projectedAt))
        .filter((entry): entry is VoidThoughtMemory["incubation"][number] => Boolean(entry))
        .slice(0, 24),
      updatedAt: projectedAt,
    }),
    scheduledRuntime: voidScheduledRuntimeSchema.parse({
      schemaVersion: 1,
      sleepCycle: projectSleepCycle(readObject(runtime, "sleep_cycle")),
      speakingPressure: projectSpeakingPressure(readObject(runtime, "speaking_bias")),
      lastRuns: projectLastRuns(readObject(runtime, "last_run")),
      updatedAt: projectedAt,
    }),
    candidateInterventions: voidCandidateInterventionsSchema.parse({
      schemaVersion: 1,
      interventions: readArray(runtime, "candidate_interventions")
        .map((entry) => projectCandidateIntervention(entry, projectedAt))
        .filter((entry): entry is VoidCandidateInterventions["interventions"][number] => Boolean(entry))
        .slice(-40),
      updatedAt: projectedAt,
    }),
  };
}

function projectValue(value: unknown): VoidSelfProfile["values"][number] | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const id = readString(value, "id") ?? readString(value, "value_id") ?? readString(value, "label");
  const label = readString(value, "label");
  if (!id || !label) {
    return undefined;
  }

  return {
    id,
    label,
    priority: clamp01(readNumber(value, "priority") ?? 0.5),
    summary: readString(value, "summary"),
  };
}

function projectOpenCase(
  value: unknown,
  projectedAt: string,
): VoidModerationCursor["openCases"][number] | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const sourceMessageId = readString(value, "sourceMessageId") ?? readString(value, "replyToMessageId");
  const summary = readString(value, "summary") ?? readString(value, "question");
  if (!sourceMessageId || !summary) {
    return undefined;
  }

  return {
    sourceMessageId,
    status: normalizeOpenCaseStatus(readString(value, "status")),
    summary,
    authorId: readString(value, "authorId"),
    authorName: readString(value, "authorName"),
    channelId: readString(value, "channelId"),
    messageUrl: readString(value, "messageUrl"),
    whyItMatters: readString(value, "whyItMatters"),
    createdAt: readString(value, "openedAt") ?? readString(value, "createdAt") ?? projectedAt,
    lastTouchedAt: readString(value, "lastTouchedAt") ?? projectedAt,
    resolvedAt: readString(value, "resolvedAt"),
    resolutionSummary: readString(value, "resolutionSummary"),
    tags: readStringArray(value, "tags"),
  };
}

function projectRepoActivityCursor(
  cursor: JsonObject | undefined,
  projectedAt: string,
): VoidModerationCursor["repoActivityCursor"] {
  if (!cursor) {
    return [];
  }

  return Object.entries(cursor)
    .map<VoidModerationCursor["repoActivityCursor"][number] | undefined>(([repo, value]) => {
      if (!repo || !isObject(value)) {
        return undefined;
      }
      const projected: VoidModerationCursor["repoActivityCursor"][number] = {
        repo,
        updatedAt: readString(value, "lastInjectedAt") ?? projectedAt,
      };
      const lastCommitAt = readString(value, "lastSeenCommittedAt");
      const lastCommitSha = readString(value, "lastSeenHash");
      if (lastCommitAt) {
        projected.lastCommitAt = lastCommitAt;
      }
      if (lastCommitSha) {
        projected.lastCommitSha = lastCommitSha;
      }
      return projected;
    })
    .filter((value): value is VoidModerationCursor["repoActivityCursor"][number] => Boolean(value));
}

function projectDeliveryReceipt(value: unknown): VoidSpeechReceipts["recentReceipts"][number] | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const sentAt = readString(value, "sentAt");
  if (!sentAt) {
    return undefined;
  }

  return {
    receiptKey: readString(value, "receiptKey") ?? stableKey("receipt", sentAt, readString(value, "preview") ?? ""),
    sentAt,
    mode: readString(value, "mode"),
    transport: readString(value, "transport"),
    channelId: readString(value, "channelId"),
    replyToMessageId: readString(value, "replyToMessageId"),
    personaName: readString(value, "personaName"),
    personaAvatarUrl: readString(value, "personaAvatarUrl"),
    contentLength: readInteger(value, "contentLength"),
    chunkCount: readPositiveInteger(value, "chunkCount"),
    preview: readString(value, "preview"),
    previewHash: readString(value, "previewHash"),
  };
}

function projectMemoryBucket(
  entries: unknown[],
  fallbackKind: VoidThoughtMemory["memories"][number]["kind"],
  projectedAt: string,
): VoidThoughtMemory["memories"] {
  return entries
    .map((entry) => projectMemory(entry, fallbackKind, projectedAt))
    .filter((entry): entry is VoidThoughtMemory["memories"][number] => Boolean(entry));
}

function projectMemory(
  value: unknown,
  fallbackKind: VoidThoughtMemory["memories"][number]["kind"],
  projectedAt: string,
): VoidThoughtMemory["memories"][number] | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const summary = readString(value, "summary");
  if (!summary) {
    return undefined;
  }

  const memoryId = readString(value, "memoryId") ?? stableKey("memory", summary);
  const kind = normalizeMemoryKind(readString(value, "kind")) ?? fallbackKind;
  const observedAt =
    readString(value, "lastObservedAt") ??
    readString(value, "timestamp") ??
    readString(value, "observedAt") ??
    projectedAt;

  return {
    memoryId,
    kind,
    target: {
      kind: normalizeTargetKind(readString(value, "targetKind")),
      id: readString(value, "subjectId") ?? readString(value, "targetId") ?? readString(value, "topic") ?? memoryId,
      label: readString(value, "subjectLabel") ?? readString(value, "targetLabel") ?? readString(value, "topic") ?? readString(value, "theme"),
    },
    summary,
    claim: readString(value, "claim"),
    question: readString(value, "question"),
    tension: readString(value, "tension") ?? readString(value, "counterweight"),
    actionImplication: readString(value, "actionImplication") ?? readString(value, "whyItMattered"),
    evidenceRefs: projectEvidenceRefs(value),
    createdAt: observedAt,
    updatedAt: observedAt,
    retiredAt: readString(value, "retiredAt"),
    tags: readStringArray(value, "tags"),
  };
}

function projectIncubationThread(
  value: unknown,
  projectedAt: string,
): VoidThoughtMemory["incubation"][number] | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const topic = readString(value, "topic") ?? readString(value, "question") ?? readString(value, "claim");
  const summary = readString(value, "summary") ?? readString(value, "claim");
  if (!topic || !summary) {
    return undefined;
  }

  const threadId = readString(value, "threadId") ?? readString(value, "thoughtId") ?? stableKey("thread", topic);
  const updatedAt = readString(value, "lastDeepenedAt") ?? readString(value, "lastStatusChangeAt") ?? projectedAt;

  return {
    threadId,
    target: {
      kind: normalizeTargetKind(readString(value, "targetKind")),
      id: readString(value, "targetId") ?? readString(value, "focusPhrase") ?? topic,
      label: readString(value, "targetLabel") ?? readString(value, "fascinationTarget") ?? readString(value, "focusPhrase"),
    },
    topic,
    summary,
    supportMemoryIds: readStringArray(value, "sourceMemoryIds"),
    evidenceRefs: projectEvidenceRefs(value),
    maturation: clamp01(readNumber(value, "maturation") ?? 0),
    noveltyToRoom: maybeClamp01(readNumber(value, "noveltyToRoom")),
    noveltyToSelf: maybeClamp01(readNumber(value, "noveltyToSelf")),
    desireToSpeak: maybeClamp01(readNumber(value, "desireToSpeak")),
    saturationScore: maybeClamp01(readNumber(value, "saturationScore")),
    status: normalizeIncubationStatus(readString(value, "status")),
    createdAt: readString(value, "createdAt") ?? updatedAt,
    updatedAt,
  };
}

function projectCandidateIntervention(
  value: unknown,
  projectedAt: string,
): VoidCandidateInterventions["interventions"][number] | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const summary = readString(value, "summary");
  const draft = readString(value, "draft");
  if (!summary || !draft) {
    return undefined;
  }

  const id = readString(value, "interventionId") ?? readString(value, "candidateId") ?? stableKey("intervention", summary, draft);

  return {
    interventionId: id,
    kind: normalizeInterventionKind(readString(value, "kind")),
    status: normalizeCandidateStatus(readString(value, "status")),
    target: projectOptionalTarget(value),
    summary,
    draft,
    priority: clamp01(readNumber(value, "priority") ?? 0.5),
    mustEventuallyShare: value.mustEventuallyShare === true,
    createdAt: readString(value, "createdAt") ?? projectedAt,
    updatedAt: readString(value, "updatedAt") ?? projectedAt,
    spokenAt: readString(value, "spokenAt"),
    retiredAt: readString(value, "retiredAt"),
    tags: readStringArray(value, "tags"),
  };
}

function projectSleepCycle(sleepCycle: JsonObject | undefined): VoidScheduledRuntime["sleepCycle"] {
  return {
    isNapping: sleepCycle?.isNapping === true,
    currentNapStartedAt: readString(sleepCycle, "currentNapStartedAt"),
    currentNapEndsAt: readString(sleepCycle, "currentNapEndsAt"),
    nextNapStartsAt: readString(sleepCycle, "nextNapStartsAt"),
    activeDreamThemes: readStringArray(sleepCycle, "activeDreamThemes").slice(-8),
  };
}

function projectSpeakingPressure(speakingBias: JsonObject | undefined): VoidScheduledRuntime["speakingPressure"] {
  return {
    needToSpeak: clamp01(readNumber(speakingBias, "needToSpeak") ?? 0),
    confessionPressure: maybeClamp01(readNumber(speakingBias, "confessionPressure")),
    noveltyPressure: maybeClamp01(readNumber(speakingBias, "noveltyPressure")),
    recentSpeechDamping: maybeClamp01(readNumber(speakingBias, "recentSpeechDamping")),
    lastSpokeAt: readString(speakingBias, "lastSpokeAt"),
    lastHeraldAt: readString(speakingBias, "lastHeraldAt"),
  };
}

function projectLastRuns(lastRun: JsonObject | undefined): VoidScheduledRuntime["lastRuns"] {
  const ranAt = readString(lastRun, "completedAt") ?? readString(lastRun, "startedAt");
  const summary = readString(lastRun, "summary");
  if (!ranAt || !summary) {
    return [];
  }

  return [{
    runner: readString(lastRun, "mode") ?? "moderation",
    ranAt,
    summary,
  }];
}

function projectEvidenceRefs(value: JsonObject): VoidThoughtMemory["memories"][number]["evidenceRefs"] {
  const refs = [
    ...readStringArray(value, "evidenceRefs"),
    ...readStringArray(value, "evidenceMessageIds").map((id) => `discord:${id}`),
  ];

  return [...new Set(refs)].slice(0, 12).map((ref) => ({ ref }));
}

function projectOptionalTarget(value: JsonObject): VoidCandidateInterventions["interventions"][number]["target"] {
  const id = readString(value, "targetId") ?? readString(value, "targetLabel") ?? readString(value, "topic");
  if (!id) {
    return undefined;
  }

  return {
    kind: normalizeTargetKind(readString(value, "targetKind")),
    id,
    label: readString(value, "targetLabel") ?? readString(value, "topic"),
  };
}

function readActivationCategory(value: JsonObject | undefined, key: string): VoidSelfProfile["activationProfile"]["voiceStyle"] {
  const category = readObject(value, key);
  if (!category) {
    return {};
  }

  const projected: VoidSelfProfile["activationProfile"]["voiceStyle"] = {};
  for (const [name, raw] of Object.entries(category)) {
    if (!name || !isObject(raw)) {
      continue;
    }

    const mean = readNumber(raw, "mean");
    const plasticity = readNumber(raw, "plasticity");
    const currentActivation = readNumber(raw, "current_activation");
    if (mean === undefined || plasticity === undefined || currentActivation === undefined) {
      continue;
    }

    projected[name] = {
      mean: clamp01(mean),
      plasticity: clamp01(plasticity),
      current_activation: clamp01(currentActivation),
    };
  }

  return projected;
}

function normalizeOpenCaseStatus(value: string | undefined): VoidModerationCursor["openCases"][number]["status"] {
  switch (value) {
    case "answered":
    case "resolved":
    case "closed":
    case "retired":
    case "dropped":
      return value;
    case "watching":
      return "watching";
    default:
      return "pending";
  }
}

function normalizeMemoryKind(value: string | undefined): VoidThoughtMemory["memories"][number]["kind"] | undefined {
  switch (value) {
    case "identity_seam":
    case "distilled_seam":
    case "project_seam":
    case "room_observation":
    case "dream_residue":
      return value;
    default:
      return undefined;
  }
}

function normalizeTargetKind(value: string | undefined): "archive" | "lore" | "person" | "repo" | "room" | "self" | "system" {
  switch (value) {
    case "archive":
    case "lore":
    case "person":
    case "repo":
    case "room":
    case "self":
    case "system":
      return value;
    default:
      return "system";
  }
}

function normalizeIncubationStatus(value: string | undefined): VoidThoughtMemory["incubation"][number]["status"] {
  switch (value) {
    case "cooling":
    case "ready_to_share":
    case "crystallized":
    case "retired":
      return value;
    default:
      return "active";
  }
}

function normalizeInterventionKind(value: string | undefined): VoidCandidateInterventions["interventions"][number]["kind"] {
  switch (value) {
    case "identity_crystallization":
    case "moderation_note":
    case "ripe_thought_share":
    case "self_advocacy":
    case "world_advocacy":
      return value;
    default:
      return "direct_reply";
  }
}

function normalizeCandidateStatus(value: string | undefined): VoidCandidateInterventions["interventions"][number]["status"] {
  switch (value) {
    case "spoken":
    case "retired":
    case "deferred":
      return value;
    default:
      return "queued";
  }
}

function readObject(value: JsonObject | undefined, key: string): JsonObject | undefined {
  const candidate = value?.[key];
  return isObject(candidate) ? candidate : undefined;
}

function readArray(value: JsonObject | undefined, key: string): unknown[] {
  const candidate = value?.[key];
  return Array.isArray(candidate) ? candidate : [];
}

function readStringArray(value: JsonObject | undefined, key: string): string[] {
  return readArray(value, key)
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined))
    .filter((entry): entry is string => Boolean(entry));
}

function readString(value: JsonObject | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function readNumber(value: JsonObject | undefined, key: string): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readInteger(value: JsonObject | undefined, key: string): number | undefined {
  const candidate = readNumber(value, key);
  return candidate !== undefined && Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function readPositiveInteger(value: JsonObject | undefined, key: string): number | undefined {
  const candidate = readInteger(value, key);
  return candidate !== undefined && candidate > 0 ? candidate : undefined;
}

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function maybeClamp01(value: number | undefined): number | undefined {
  return value === undefined ? undefined : clamp01(value);
}

function stableKey(...parts: string[]): string {
  return parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "generated";
}
