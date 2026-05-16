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

export interface VoidSelfStateTypedProjection {
  selfProfile: VoidSelfProfile;
  moderationCursor: VoidModerationCursor;
  speechReceipts: VoidSpeechReceipts;
  thoughtMemory: VoidThoughtMemory;
  scheduledRuntime: VoidScheduledRuntime;
  candidateInterventions: VoidCandidateInterventions;
}

export function createEmptyVoidSelfState(
  options: { createdAt?: string } = {},
): VoidSelfStateTypedProjection {
  const createdAt = options.createdAt ?? new Date().toISOString();

  return {
    selfProfile: voidSelfProfileSchema.parse({
      schemaVersion: 1,
      agentId: "void-moderator",
      publicName: "Void",
      privateNotes: [],
      values: [],
      activationProfile: {
        underlyingOrganization: {},
        stableDispositions: {},
        behavioralDimensions: {},
        presentationStrategy: {},
        voiceStyle: {},
        situationalState: {},
      },
      updatedAt: createdAt,
    }),
    moderationCursor: voidModerationCursorSchema.parse({
      schemaVersion: 1,
      openCases: [],
      repoActivityCursor: [],
      updatedAt: createdAt,
    }),
    speechReceipts: voidSpeechReceiptsSchema.parse({
      schemaVersion: 1,
      recentReceipts: [],
      updatedAt: createdAt,
    }),
    thoughtMemory: voidThoughtMemorySchema.parse({
      schemaVersion: 1,
      memories: [],
      incubation: [],
      updatedAt: createdAt,
    }),
    scheduledRuntime: voidScheduledRuntimeSchema.parse({
      schemaVersion: 1,
      sleepCycle: {
        isNapping: false,
        activeDreamThemes: [],
      },
      speakingPressure: {
        needToSpeak: 0,
      },
      lastRuns: [],
      updatedAt: createdAt,
    }),
    candidateInterventions: voidCandidateInterventionsSchema.parse({
      schemaVersion: 1,
      interventions: [],
      updatedAt: createdAt,
    }),
  };
}
