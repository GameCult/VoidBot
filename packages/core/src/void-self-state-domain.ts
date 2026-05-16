import { defineDocumentRegistry, defineDocumentType } from "cultcache-ts";
import { z } from "zod";

export const VOID_SELF_STATE_DOCUMENT_TYPES = {
  selfProfile: "void.self_profile",
  moderationCursor: "void.moderation_cursor",
  speechReceipts: "void.speech_receipts",
  thoughtMemory: "void.thought_memory",
  scheduledRuntime: "void.scheduled_runtime",
  candidateInterventions: "void.candidate_interventions",
} as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const timestampSchema = nonEmptyStringSchema;

const boundedTextSchema = z.string().trim().min(1).max(4000);

const evidenceRefSchema = z.object({
  ref: nonEmptyStringSchema,
  kind: z.string().trim().min(1).max(64).optional(),
  summary: z.string().trim().max(1000).optional(),
}).strict();

const activationVectorSchema = z.object({
  mean: z.number().min(0).max(1),
  plasticity: z.number().min(0).max(1),
  current_activation: z.number().min(0).max(1),
}).strict();

const activationCategorySchema = z.record(nonEmptyStringSchema, activationVectorSchema);

const thoughtTargetSchema = z.object({
  kind: z.enum(["archive", "lore", "person", "repo", "room", "self", "system"]),
  id: nonEmptyStringSchema,
  label: z.string().trim().min(1).max(240).optional(),
}).strict();

const moderationOpenCaseSchema = z.object({
  sourceMessageId: nonEmptyStringSchema,
  status: z.enum(["pending", "watching", "answered", "resolved", "closed", "retired", "dropped"]),
  summary: boundedTextSchema,
  authorId: z.string().trim().min(1).optional(),
  authorName: z.string().trim().min(1).optional(),
  channelId: z.string().trim().min(1).optional(),
  messageUrl: z.string().trim().min(1).optional(),
  whyItMatters: z.string().trim().min(1).max(2000).optional(),
  createdAt: timestampSchema,
  lastTouchedAt: timestampSchema,
  resolvedAt: timestampSchema.optional(),
  resolutionSummary: z.string().trim().min(1).max(2000).optional(),
  tags: z.array(nonEmptyStringSchema).default([]),
}).strict();

const moderationRepoCursorSchema = z.object({
  repo: nonEmptyStringSchema,
  lastCommitAt: timestampSchema.optional(),
  lastCommitSha: z.string().trim().min(1).optional(),
  updatedAt: timestampSchema,
}).strict();

const deliveryReceiptSchema = z.object({
  receiptKey: nonEmptyStringSchema,
  sentAt: timestampSchema,
  mode: z.string().trim().min(1).optional(),
  transport: z.string().trim().min(1).optional(),
  channelId: z.string().trim().min(1).optional(),
  replyToMessageId: z.string().trim().min(1).optional(),
  personaName: z.string().trim().min(1).optional(),
  personaAvatarUrl: z.string().trim().min(1).optional(),
  contentLength: z.number().int().nonnegative().optional(),
  chunkCount: z.number().int().positive().optional(),
  preview: z.string().trim().max(1000).optional(),
  previewHash: z.string().trim().min(1).optional(),
}).strict();

const distilledMemorySchema = z.object({
  memoryId: nonEmptyStringSchema,
  kind: z.enum(["distilled_seam", "identity_seam", "project_seam", "room_observation", "dream_residue"]),
  target: thoughtTargetSchema,
  summary: boundedTextSchema,
  claim: z.string().trim().min(1).max(2000).optional(),
  question: z.string().trim().min(1).max(2000).optional(),
  tension: z.string().trim().min(1).max(2000).optional(),
  actionImplication: z.string().trim().min(1).max(2000).optional(),
  evidenceRefs: z.array(evidenceRefSchema).default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  retiredAt: timestampSchema.optional(),
  tags: z.array(nonEmptyStringSchema).default([]),
}).strict();

const meaningPreservingMemorySchema = distilledMemorySchema.superRefine((memory, context) => {
  if (!memory.claim && !memory.question) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Memory writes must preserve at least one claim or question.",
      path: ["claim"],
    });
  }

  if (!memory.tension) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Memory writes must preserve the live tension or counterweight.",
      path: ["tension"],
    });
  }

  if (!memory.actionImplication) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Memory writes must preserve why the memory should affect future action.",
      path: ["actionImplication"],
    });
  }

  const admitsMissingEvidence = memory.tags.includes("evidence:missing");
  if (memory.evidenceRefs.length === 0 && !admitsMissingEvidence) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Memory writes must include evidence refs or explicitly tag evidence:missing.",
      path: ["evidenceRefs"],
    });
  }
});

const incubationThreadSchema = z.object({
  threadId: nonEmptyStringSchema,
  target: thoughtTargetSchema,
  topic: boundedTextSchema,
  summary: boundedTextSchema,
  supportMemoryIds: z.array(nonEmptyStringSchema).default([]),
  evidenceRefs: z.array(evidenceRefSchema).default([]),
  maturation: z.number().min(0).max(1).default(0),
  noveltyToRoom: z.number().min(0).max(1).optional(),
  noveltyToSelf: z.number().min(0).max(1).optional(),
  desireToSpeak: z.number().min(0).max(1).optional(),
  saturationScore: z.number().min(0).max(1).optional(),
  status: z.enum(["active", "cooling", "ready_to_share", "crystallized", "retired"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const candidateInterventionSchema = z.object({
  interventionId: nonEmptyStringSchema,
  kind: z.enum([
    "direct_reply",
    "identity_crystallization",
    "moderation_note",
    "ripe_thought_share",
    "self_advocacy",
    "world_advocacy",
  ]),
  status: z.enum(["queued", "spoken", "retired", "deferred"]),
  target: thoughtTargetSchema.optional(),
  summary: boundedTextSchema,
  draft: boundedTextSchema,
  priority: z.number().min(0).max(1).default(0.5),
  mustEventuallyShare: z.boolean().default(false),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  spokenAt: timestampSchema.optional(),
  retiredAt: timestampSchema.optional(),
  tags: z.array(nonEmptyStringSchema).default([]),
}).strict();

export const voidSelfProfileSchema = z.object({
  schemaVersion: z.literal(1),
  agentId: nonEmptyStringSchema,
  publicName: nonEmptyStringSchema,
  publicDescription: z.string().trim().max(1000).optional(),
  privateNotes: z.array(boundedTextSchema).default([]),
  values: z.array(z.object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    priority: z.number().min(0).max(1),
    summary: z.string().trim().max(1000).optional(),
  }).strict()).default([]),
  activationProfile: z.object({
    underlyingOrganization: activationCategorySchema.default({}),
    stableDispositions: activationCategorySchema.default({}),
    behavioralDimensions: activationCategorySchema.default({}),
    presentationStrategy: activationCategorySchema.default({}),
    voiceStyle: activationCategorySchema.default({}),
    situationalState: activationCategorySchema.default({}),
  }).strict(),
  updatedAt: timestampSchema,
}).strict();

export const voidModerationCursorSchema = z.object({
  schemaVersion: z.literal(1),
  lastReviewedMessageId: z.string().trim().min(1).optional(),
  lastReviewedTimestamp: timestampSchema.optional(),
  openCases: z.array(moderationOpenCaseSchema).default([]),
  repoActivityCursor: z.array(moderationRepoCursorSchema).default([]),
  updatedAt: timestampSchema,
}).strict();

export const voidSpeechReceiptsSchema = z.object({
  schemaVersion: z.literal(1),
  recentReceipts: z.array(deliveryReceiptSchema).default([]),
  updatedAt: timestampSchema,
}).strict();

export const voidThoughtMemorySchema = z.object({
  schemaVersion: z.literal(1),
  memories: z.array(distilledMemorySchema).default([]),
  incubation: z.array(incubationThreadSchema).default([]),
  updatedAt: timestampSchema,
}).strict();

export const voidScheduledRuntimeSchema = z.object({
  schemaVersion: z.literal(1),
  sleepCycle: z.object({
    isNapping: z.boolean(),
    currentNapStartedAt: timestampSchema.optional(),
    currentNapEndsAt: timestampSchema.optional(),
    nextNapStartsAt: timestampSchema.optional(),
    activeDreamThemes: z.array(nonEmptyStringSchema).default([]),
  }).strict(),
  speakingPressure: z.object({
    needToSpeak: z.number().min(0).max(1),
    confessionPressure: z.number().min(0).max(1).optional(),
    noveltyPressure: z.number().min(0).max(1).optional(),
    recentSpeechDamping: z.number().min(0).max(1).optional(),
    lastSpokeAt: timestampSchema.optional(),
    lastHeraldAt: timestampSchema.optional(),
  }).strict(),
  lastRuns: z.array(z.object({
    runner: nonEmptyStringSchema,
    ranAt: timestampSchema,
    summary: z.string().trim().min(1).max(1000),
  }).strict()).default([]),
  updatedAt: timestampSchema,
}).strict();

export const voidCandidateInterventionsSchema = z.object({
  schemaVersion: z.literal(1),
  interventions: z.array(candidateInterventionSchema).default([]),
  updatedAt: timestampSchema,
}).strict();

export const voidSelfProfileDocument = defineDocumentType({
  type: VOID_SELF_STATE_DOCUMENT_TYPES.selfProfile,
  schema: voidSelfProfileSchema,
  global: true,
});

export const voidModerationCursorDocument = defineDocumentType({
  type: VOID_SELF_STATE_DOCUMENT_TYPES.moderationCursor,
  schema: voidModerationCursorSchema,
  global: true,
});

export const voidSpeechReceiptsDocument = defineDocumentType({
  type: VOID_SELF_STATE_DOCUMENT_TYPES.speechReceipts,
  schema: voidSpeechReceiptsSchema,
  global: true,
});

export const voidThoughtMemoryDocument = defineDocumentType({
  type: VOID_SELF_STATE_DOCUMENT_TYPES.thoughtMemory,
  schema: voidThoughtMemorySchema,
  global: true,
});

export const voidScheduledRuntimeDocument = defineDocumentType({
  type: VOID_SELF_STATE_DOCUMENT_TYPES.scheduledRuntime,
  schema: voidScheduledRuntimeSchema,
  global: true,
});

export const voidCandidateInterventionsDocument = defineDocumentType({
  type: VOID_SELF_STATE_DOCUMENT_TYPES.candidateInterventions,
  schema: voidCandidateInterventionsSchema,
  global: true,
});

export const voidSelfStateDocumentRegistry = defineDocumentRegistry(
  voidSelfProfileDocument,
  voidModerationCursorDocument,
  voidSpeechReceiptsDocument,
  voidThoughtMemoryDocument,
  voidScheduledRuntimeDocument,
  voidCandidateInterventionsDocument,
);

export const voidSelfStateOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("record_reviewed_messages"),
    lastReviewedMessageId: nonEmptyStringSchema,
    lastReviewedTimestamp: timestampSchema,
  }).strict(),
  z.object({
    operation: z.literal("upsert_open_case"),
    case: moderationOpenCaseSchema,
  }).strict(),
  z.object({
    operation: z.literal("close_open_case"),
    sourceMessageId: nonEmptyStringSchema,
    status: z.enum(["answered", "resolved", "closed", "retired", "dropped"]),
    resolvedAt: timestampSchema,
    resolutionSummary: z.string().trim().min(1).max(2000).optional(),
  }).strict(),
  z.object({
    operation: z.literal("update_repo_activity_cursor"),
    cursor: moderationRepoCursorSchema,
  }).strict(),
  z.object({
    operation: z.literal("record_delivery_receipt"),
    receipt: deliveryReceiptSchema,
  }).strict(),
  z.object({
    operation: z.literal("append_distilled_memory"),
    memory: meaningPreservingMemorySchema,
  }).strict(),
  z.object({
    operation: z.literal("merge_incubation_support"),
    thread: incubationThreadSchema,
  }).strict(),
  z.object({
    operation: z.literal("queue_candidate_intervention"),
    intervention: candidateInterventionSchema,
  }).strict(),
  z.object({
    operation: z.literal("retire_candidate_intervention"),
    interventionId: nonEmptyStringSchema,
    retiredAt: timestampSchema,
    reason: z.string().trim().min(1).max(1000),
  }).strict(),
  z.object({
    operation: z.literal("update_sleep_cycle"),
    sleepCycle: voidScheduledRuntimeSchema.shape.sleepCycle,
  }).strict(),
  z.object({
    operation: z.literal("update_speaking_pressure"),
    speakingPressure: voidScheduledRuntimeSchema.shape.speakingPressure,
  }).strict(),
  z.object({
    operation: z.literal("propose_memory_distillation"),
    proposalId: nonEmptyStringSchema,
    sourceMemoryIds: z.array(nonEmptyStringSchema).min(1),
    candidate: meaningPreservingMemorySchema,
    proposedAt: timestampSchema,
  }).strict(),
  z.object({
    operation: z.literal("apply_memory_distillation"),
    proposalId: nonEmptyStringSchema,
    sourceMemoryIds: z.array(nonEmptyStringSchema).min(1),
    memory: meaningPreservingMemorySchema,
    appliedAt: timestampSchema,
  }).strict(),
]);

export type VoidSelfProfile = z.infer<typeof voidSelfProfileSchema>;
export type VoidModerationCursor = z.infer<typeof voidModerationCursorSchema>;
export type VoidSpeechReceipts = z.infer<typeof voidSpeechReceiptsSchema>;
export type VoidThoughtMemory = z.infer<typeof voidThoughtMemorySchema>;
export type VoidScheduledRuntime = z.infer<typeof voidScheduledRuntimeSchema>;
export type VoidCandidateInterventions = z.infer<typeof voidCandidateInterventionsSchema>;
export type VoidSelfStateOperation = z.infer<typeof voidSelfStateOperationSchema>;
