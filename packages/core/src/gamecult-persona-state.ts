import {
  type RepoDiscordIdentity,
} from "./repo-discord-identities";
import {
  type VoidAgencyPressure,
  type VoidCandidateInterventions,
  type VoidFaceAffect,
  type VoidSelfProfile,
  type VoidThoughtMemory,
} from "./void-self-state-domain";
import {
  type VoidSelfStateTypedProjection,
} from "./void-self-state-projection";

export const GAMECULT_PERSONA_STATE_SCHEMA_VERSION = "gamecult.persona_state.v0" as const;

export type GameCultPersonaTargetKind =
  | "person"
  | "repo"
  | "scene"
  | "system"
  | "room"
  | "artifact"
  | "concept"
  | "relationship"
  | "self"
  | "community"
  | "thread"
  | "document"
  | "runtime"
  | "custom";

export interface GameCultPersonaTarget {
  kind: GameCultPersonaTargetKind;
  id: string;
  label?: string;
  customKind?: string;
}

export interface GameCultAnchoredThought {
  id: string;
  status: "draft" | "active" | "cooling" | "crystallized" | "resolved" | "retired";
  target: GameCultPersonaTarget;
  summary: string;
  claim?: string;
  question?: string;
  tension: string;
  actionImplication: string;
  intensity?: number;
  valence?: number;
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
}

export interface GameCultCandidateAction {
  id: string;
  status: GameCultAnchoredThought["status"];
  actionType:
    | "speak"
    | "draft"
    | "ask"
    | "propose"
    | "inspect"
    | "notify"
    | "wait"
    | "remember"
    | "handoff"
    | "render"
    | "external_action"
    | "custom";
  customActionType?: string;
  readiness: "draft" | "ready" | "blocked" | "waiting" | "expired";
  riskLevel: "none" | "low" | "medium" | "high" | "severe" | "unknown";
  target: GameCultPersonaTarget;
  deliveryTarget?: GameCultPersonaTarget;
  summary: string;
  rationale?: string;
  urgency?: number;
  confidence?: number;
  constraints?: string[];
  evidence?: GameCultAnchoredThought[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  extensions?: Record<string, unknown>;
}

export interface GameCultPersonaState {
  schemaVersion: typeof GAMECULT_PERSONA_STATE_SCHEMA_VERSION;
  provenance: {
    sourceSystem: string;
    sourceDocumentId: string;
    sourceUpdatedAt: string;
    exportedAt: string;
    authority: "canonical" | "projection" | "import";
  };
  personaId: string;
  publicName: string;
  publicDescription?: string;
  presentation: {
    avatarUri?: string;
    pronouns?: string;
    voiceSummary: string;
    defaultRenderer?: "text" | "chat" | "avatar" | "voice" | "scene" | "repo_face" | "custom";
    customRenderer?: string;
    homeContext?: GameCultPersonaTarget;
    jurisdiction?: string;
    publicHandles?: Array<{ system: string; handle: string; uri?: string }>;
  };
  privateNotes?: string[];
  values?: Array<{ id: string; label: string; priority: number; summary?: string }>;
  activationProfile: ReturnType<typeof mapActivationProfile>;
  thoughtMemory: {
    shortTerm: GameCultAnchoredThought[];
    memories: GameCultAnchoredThought[];
    incubation: GameCultAnchoredThought[];
  };
  agencyPressure: {
    pressures: GameCultAnchoredThought[];
  };
  candidateActions: {
    actions: GameCultCandidateAction[];
  };
  voidbotProjection?: {
    candidateInterventions: GameCultCandidateAction[];
  };
  affect: {
    needs: GameCultAnchoredThought[];
    socialBonds: Array<{
      id: string;
      status: GameCultAnchoredThought["status"];
      subject: GameCultPersonaTarget;
      object: GameCultPersonaTarget;
      relationshipKind:
        | "ally"
        | "friend"
        | "collaborator"
        | "mentor"
        | "ward"
        | "rival"
        | "audience"
        | "community_member"
        | "self_relation"
        | "unknown"
        | "custom";
      customRelationshipKind?: string;
      summary: string;
      trust: number;
      tension: number;
      intensity?: number;
      updatedAt: string;
      extensions?: Record<string, unknown>;
    }>;
    statusReads: Array<{
      id: string;
      status: GameCultAnchoredThought["status"];
      target: GameCultPersonaTarget;
      statusKind: "attention" | "authority" | "risk" | "trust" | "need" | "conflict" | "mood" | "opportunity" | "uncertainty" | "custom";
      customStatusKind?: string;
      summary: string;
      confidence: number;
      intensity?: number;
      valence?: number;
      updatedAt: string;
      extensions?: Record<string, unknown>;
    }>;
    moodDimensions: Array<{ name: string; value: number; source?: string; updatedAt: string }>;
    socialBiases: Array<{ name: string; value: number; summary: string; behavioralPull: string; updatedAt: string }>;
    doctrineStances: Array<{
      id: string;
      status: GameCultAnchoredThought["status"];
      target: GameCultPersonaTarget;
      stanceKind: "aligned" | "tension" | "rejected" | "uncertain" | "contextual" | "custom";
      customStanceKind?: string;
      principle: string;
      summary: string;
      actionImplication: string;
      intensity?: number;
      updatedAt: string;
      extensions?: Record<string, unknown>;
    }>;
  };
  updatedAt: string;
}

export interface BuildGameCultPersonaStateOptions {
  sourceDocumentId: string;
  exportedAt?: string;
  sourceSystem?: string;
  identity?: RepoDiscordIdentity | {
    id?: string;
    displayName?: string;
    repoName?: string;
    avatarUrl?: string;
    description?: string;
  };
}

export function buildGameCultPersonaStateFromVoidSelfState(
  typedState: VoidSelfStateTypedProjection,
  options: BuildGameCultPersonaStateOptions,
): GameCultPersonaState {
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const sourceUpdatedAt = latestTimestamp([
    typedState.selfProfile.updatedAt,
    typedState.thoughtMemory.updatedAt,
    typedState.agencyPressure.updatedAt,
    typedState.candidateInterventions.updatedAt,
    typedState.faceAffect.updatedAt,
  ]);
  const personaId = options.identity?.id ?? typedState.selfProfile.agentId;
  const publicName = options.identity?.displayName ?? typedState.selfProfile.publicName;
  const publicDescription = options.identity?.description ?? typedState.selfProfile.publicDescription;
  const selfTarget: GameCultPersonaTarget = {
    kind: "self",
    id: personaId,
    label: publicName,
  };
  const repoName = options.identity?.repoName;
  const candidateActions = typedState.candidateInterventions.interventions.map((intervention) =>
    mapCandidateIntervention(intervention, selfTarget),
  );

  return {
    schemaVersion: GAMECULT_PERSONA_STATE_SCHEMA_VERSION,
    provenance: {
      sourceSystem: options.sourceSystem ?? "voidbot",
      sourceDocumentId: options.sourceDocumentId,
      sourceUpdatedAt,
      exportedAt,
      authority: "projection",
    },
    personaId,
    publicName,
    ...(publicDescription ? { publicDescription } : {}),
    presentation: {
      ...(options.identity?.avatarUrl ? { avatarUri: options.identity.avatarUrl } : {}),
      voiceSummary: publicDescription ?? `${publicName} speaks as a GameCult Persona.`,
      defaultRenderer: repoName ? "repo_face" : "chat",
      ...(repoName
        ? {
            homeContext: {
              kind: "repo",
              id: repoName,
              label: repoName,
            } satisfies GameCultPersonaTarget,
            jurisdiction: repoName,
          }
        : {}),
    },
    privateNotes: typedState.selfProfile.privateNotes,
    values: typedState.selfProfile.values.map((value) => ({
      id: value.id,
      label: value.label,
      priority: value.priority,
      ...(value.summary ? { summary: value.summary } : {}),
    })),
    activationProfile: mapActivationProfile(typedState.selfProfile.activationProfile),
    thoughtMemory: {
      shortTerm: typedState.thoughtMemory.shortTerm.map(mapMemory),
      memories: typedState.thoughtMemory.memories.map(mapMemory),
      incubation: typedState.thoughtMemory.incubation.map(mapIncubationThread),
    },
    agencyPressure: {
      pressures: typedState.agencyPressure.pressures.map(mapAgencyPressure),
    },
    candidateActions: {
      actions: candidateActions,
    },
    voidbotProjection: {
      candidateInterventions: candidateActions,
    },
    affect: {
      needs: typedState.faceAffect.needs.map(mapAffectNeed),
      socialBonds: typedState.faceAffect.socialBonds.map((bond) => mapSocialBond(bond, selfTarget)),
      statusReads: typedState.faceAffect.statusReads.map(mapStatusRead),
      moodDimensions: typedState.faceAffect.moodDimensions.map((dimension) => ({ ...dimension })),
      socialBiases: typedState.faceAffect.socialBiases.map((bias) => ({ ...bias })),
      doctrineStances: typedState.faceAffect.doctrineStances.map(mapDoctrineStance),
    },
    updatedAt: sourceUpdatedAt,
  };
}

function mapActivationProfile(profile: VoidSelfProfile["activationProfile"]) {
  return {
    underlyingOrganization: mapTraitMap(profile.underlyingOrganization),
    stableDispositions: mapTraitMap(profile.stableDispositions),
    behavioralDimensions: mapTraitMap(profile.behavioralDimensions),
    presentationStrategy: mapTraitMap(profile.presentationStrategy),
    voiceStyle: mapTraitMap(profile.voiceStyle),
    situationalState: mapTraitMap(profile.situationalState),
  };
}

function mapTraitMap(
  traitMap: VoidSelfProfile["activationProfile"]["underlyingOrganization"],
): Record<string, { mean: number; plasticity: number; currentActivation: number }> {
  return Object.fromEntries(
    Object.entries(traitMap).map(([key, value]) => [
      key,
      {
        mean: value.mean,
        plasticity: value.plasticity,
        currentActivation: value.current_activation,
      },
    ]),
  );
}

function mapMemory(
  memory: VoidThoughtMemory["memories"][number],
): GameCultAnchoredThought {
  return {
    id: memory.memoryId,
    status: memory.retiredAt ? "retired" : "active",
    target: mapTarget(memory.target),
    summary: memory.summary,
    ...(memory.claim ? { claim: memory.claim } : {}),
    ...(memory.question ? { question: memory.question } : {}),
    tension: memory.tension ?? "This memory should stay inspectable before it steers action.",
    actionImplication: memory.actionImplication ?? "Keep this memory available as context, not command.",
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    ...(memory.retiredAt ? { retiredAt: memory.retiredAt } : {}),
    tags: memory.tags,
    extensions: {
      voidbot: {
        kind: memory.kind,
        anchorRefs: memory.anchorRefs,
        evidenceRefs: memory.evidenceRefs,
      },
    },
  };
}

function mapIncubationThread(
  thread: VoidThoughtMemory["incubation"][number],
): GameCultAnchoredThought {
  return {
    id: thread.threadId,
    status: mapIncubationStatus(thread.status),
    target: mapTarget(thread.target),
    summary: thread.summary,
    question: thread.topic,
    tension: "This thought is still incubating and should not pretend to be settled doctrine.",
    actionImplication: thread.status === "ready_to_share"
      ? "Consider sharing after checking room relevance and consent."
      : "Let the thought keep gathering evidence before public action.",
    intensity: thread.maturation,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    extensions: {
      voidbot: {
        supportMemoryIds: thread.supportMemoryIds,
        anchorRefs: thread.anchorRefs,
        evidenceRefs: thread.evidenceRefs,
        noveltyToRoom: thread.noveltyToRoom,
        noveltyToSelf: thread.noveltyToSelf,
        desireToSpeak: thread.desireToSpeak,
        saturationScore: thread.saturationScore,
      },
    },
  };
}

function mapAgencyPressure(
  pressure: VoidAgencyPressure["pressures"][number],
): GameCultAnchoredThought {
  return {
    id: pressure.pressureId,
    status: mapPressureStatus(pressure.status),
    target: mapTarget(pressure.target),
    summary: pressure.summary,
    ...(pressure.claim ? { claim: pressure.claim } : {}),
    ...(pressure.question ? { question: pressure.question } : {}),
    tension: pressure.tension ?? "This pressure needs context before becoming action.",
    actionImplication: pressure.actionImplication,
    intensity: pressure.intensity,
    createdAt: pressure.createdAt,
    updatedAt: pressure.updatedAt,
    ...(pressure.retiredAt ? { retiredAt: pressure.retiredAt } : {}),
    tags: pressure.tags,
    extensions: {
      voidbot: {
        kind: pressure.kind,
        anchorRefs: pressure.anchorRefs,
        evidenceRefs: pressure.evidenceRefs,
        sourceMemoryIds: pressure.sourceMemoryIds,
        resolvedAt: pressure.resolvedAt,
      },
    },
  };
}

function mapAffectNeed(
  need: VoidFaceAffect["needs"][number],
): GameCultAnchoredThought {
  return {
    id: need.needId,
    status: mapNeedStatus(need.status),
    target: mapTarget(need.target),
    summary: need.summary,
    ...(need.claim ? { claim: need.claim } : {}),
    ...(need.question ? { question: need.question } : {}),
    tension: need.tension,
    actionImplication: need.actionImplication,
    intensity: need.intensity,
    valence: need.valence,
    createdAt: need.createdAt,
    updatedAt: need.updatedAt,
    ...(need.retiredAt ? { retiredAt: need.retiredAt } : {}),
    tags: need.tags,
    extensions: {
      voidbot: {
        kind: need.kind,
        anchorRefs: need.anchorRefs,
        evidenceRefs: need.evidenceRefs,
        sourceMemoryIds: need.sourceMemoryIds,
        lastSatisfiedAt: need.lastSatisfiedAt,
      },
    },
  };
}

function mapCandidateIntervention(
  intervention: VoidCandidateInterventions["interventions"][number],
  fallbackTarget: GameCultPersonaTarget,
): GameCultCandidateAction {
  return {
    id: intervention.interventionId,
    status: mapInterventionStatus(intervention.status),
    actionType: mapInterventionActionType(intervention.kind),
    readiness: mapInterventionReadiness(intervention.status),
    riskLevel: "unknown",
    target: intervention.target ? mapTarget(intervention.target) : fallbackTarget,
    ...(intervention.deliveryTarget ? { deliveryTarget: mapDeliveryTarget(intervention.deliveryTarget) } : {}),
    summary: intervention.summary,
    rationale: intervention.draft,
    urgency: intervention.priority,
    confidence: 0.5,
    constraints: intervention.tags,
    createdAt: intervention.createdAt,
    updatedAt: intervention.updatedAt,
    ...(intervention.retiredAt ?? intervention.spokenAt ? { expiresAt: intervention.retiredAt ?? intervention.spokenAt } : {}),
    extensions: {
      voidbot: {
        kind: intervention.kind,
        mustEventuallyShare: intervention.mustEventuallyShare,
        spokenAt: intervention.spokenAt,
        retiredAt: intervention.retiredAt,
      },
    },
  };
}

function mapSocialBond(
  bond: VoidFaceAffect["socialBonds"][number],
  subject: GameCultPersonaTarget,
): GameCultPersonaState["affect"]["socialBonds"][number] {
  const relationship = mapRelationshipKind(bond.stance);

  return {
    id: bond.bondId,
    status: mapPressureStatus(bond.status),
    subject,
    object: mapTarget(bond.target),
    relationshipKind: relationship.kind,
    ...(relationship.customKind ? { customRelationshipKind: relationship.customKind } : {}),
    summary: bond.summary,
    trust: estimateTrust(bond.stance, bond.intensity),
    tension: estimateRelationshipTension(bond.stance, bond.intensity),
    intensity: bond.intensity,
    updatedAt: bond.updatedAt,
    extensions: {
      voidbot: {
        stance: bond.stance,
        claim: bond.claim,
        tension: bond.tension,
        actionImplication: bond.actionImplication,
        anchorRefs: bond.anchorRefs,
        evidenceRefs: bond.evidenceRefs,
        createdAt: bond.createdAt,
        retiredAt: bond.retiredAt,
        tags: bond.tags,
      },
    },
  };
}

function mapStatusRead(
  read: VoidFaceAffect["statusReads"][number],
): GameCultPersonaState["affect"]["statusReads"][number] {
  return {
    id: read.readId,
    status: read.retiredAt ? "retired" : "active",
    target: mapTarget(read.target),
    statusKind: mapStatusKind(read.status),
    summary: read.summary,
    confidence: 0.5,
    intensity: read.intensity,
    valence: statusValence(read.status),
    updatedAt: read.updatedAt,
    extensions: {
      voidbot: {
        status: read.status,
        claim: read.claim,
        tension: read.tension,
        actionImplication: read.actionImplication,
        anchorRefs: read.anchorRefs,
        evidenceRefs: read.evidenceRefs,
        createdAt: read.createdAt,
        retiredAt: read.retiredAt,
        tags: read.tags,
      },
    },
  };
}

function mapDoctrineStance(
  stance: VoidFaceAffect["doctrineStances"][number],
): GameCultPersonaState["affect"]["doctrineStances"][number] {
  return {
    id: stance.stanceId,
    status: mapPressureStatus(stance.status),
    target: mapTarget(stance.target),
    stanceKind: mapDoctrineStanceKind(stance),
    principle: stance.doctrine,
    summary: stance.summary,
    actionImplication: stance.actionImplication,
    intensity: stance.intensity,
    updatedAt: stance.updatedAt,
    extensions: {
      voidbot: {
        claim: stance.claim,
        question: stance.question,
        tension: stance.tension,
        valence: stance.valence,
        anchorRefs: stance.anchorRefs,
        evidenceRefs: stance.evidenceRefs,
        sourceMemoryIds: stance.sourceMemoryIds,
        createdAt: stance.createdAt,
        retiredAt: stance.retiredAt,
        tags: stance.tags,
      },
    },
  };
}

function mapTarget(target: { kind: string; id: string; label?: string }): GameCultPersonaTarget {
  switch (target.kind) {
    case "repo":
    case "person":
    case "room":
    case "self":
    case "system":
      return { kind: target.kind, id: target.id, ...(target.label ? { label: target.label } : {}) };
    case "archive":
      return { kind: "document", id: target.id, ...(target.label ? { label: target.label } : {}) };
    case "lore":
      return { kind: "concept", id: target.id, ...(target.label ? { label: target.label } : {}) };
    default:
      return {
        kind: "custom",
        customKind: target.kind,
        id: target.id,
        ...(target.label ? { label: target.label } : {}),
      };
  }
}

function mapDeliveryTarget(
  deliveryTarget: VoidCandidateInterventions["interventions"][number]["deliveryTarget"],
): GameCultPersonaTarget | undefined {
  if (!deliveryTarget) {
    return undefined;
  }
  if (deliveryTarget.mode === "owner_dm") {
    return {
      kind: "person",
      id: "owner",
      label: "Owner DM",
    };
  }
  return {
    kind: "room",
    id: deliveryTarget.channelId ?? "unknown-channel",
    label: deliveryTarget.replyToMessageId
      ? `Reply to ${deliveryTarget.replyToMessageId}`
      : deliveryTarget.channelId,
  };
}

function mapIncubationStatus(status: VoidThoughtMemory["incubation"][number]["status"]): GameCultAnchoredThought["status"] {
  switch (status) {
    case "cooling":
      return "cooling";
    case "crystallized":
      return "crystallized";
    case "retired":
      return "retired";
    case "ready_to_share":
    case "active":
    default:
      return "active";
  }
}

function mapPressureStatus(status: "active" | "cooling" | "ready_to_act" | "resolved" | "retired" | "crystallized"): GameCultAnchoredThought["status"] {
  switch (status) {
    case "ready_to_act":
      return "active";
    default:
      return status;
  }
}

function mapNeedStatus(status: VoidFaceAffect["needs"][number]["status"]): GameCultAnchoredThought["status"] {
  switch (status) {
    case "satisfied":
      return "resolved";
    case "neglected":
      return "active";
    default:
      return status;
  }
}

function mapInterventionStatus(status: VoidCandidateInterventions["interventions"][number]["status"]): GameCultAnchoredThought["status"] {
  switch (status) {
    case "spoken":
      return "resolved";
    case "deferred":
      return "cooling";
    case "queued":
      return "active";
    case "retired":
    default:
      return "retired";
  }
}

function mapInterventionReadiness(status: VoidCandidateInterventions["interventions"][number]["status"]): GameCultCandidateAction["readiness"] {
  switch (status) {
    case "queued":
      return "ready";
    case "deferred":
      return "waiting";
    case "spoken":
    case "retired":
    default:
      return "expired";
  }
}

function mapInterventionActionType(
  kind: VoidCandidateInterventions["interventions"][number]["kind"],
): GameCultCandidateAction["actionType"] {
  switch (kind) {
    case "identity_crystallization":
      return "remember";
    default:
      return "speak";
  }
}

function mapRelationshipKind(
  stance: VoidFaceAffect["socialBonds"][number]["stance"],
): { kind: GameCultPersonaState["affect"]["socialBonds"][number]["relationshipKind"]; customKind?: string } {
  switch (stance) {
    case "fondness":
    case "attachment":
      return { kind: "friend" };
    case "trust":
    case "respect":
      return { kind: "collaborator" };
    case "protectiveness":
      return { kind: "ally" };
    case "rivalry":
      return { kind: "rival" };
    default:
      return { kind: "custom", customKind: stance };
  }
}

function mapStatusKind(status: VoidFaceAffect["statusReads"][number]["status"]): GameCultPersonaState["affect"]["statusReads"][number]["statusKind"] {
  switch (status) {
    case "favored":
    case "neglected":
    case "pampered":
    case "ignored":
    case "consulted":
    case "admired":
      return "attention";
    case "bypassed":
    case "blocked":
      return "authority";
    case "threatened":
      return "risk";
    case "challenged":
      return "conflict";
    default:
      return "custom";
  }
}

function mapDoctrineStanceKind(stance: VoidFaceAffect["doctrineStances"][number]): GameCultPersonaState["affect"]["doctrineStances"][number]["stanceKind"] {
  if (stance.valence > 0.35) {
    return "aligned";
  }
  if (stance.valence < -0.35) {
    return "rejected";
  }
  if (stance.question) {
    return "uncertain";
  }
  return "contextual";
}

function estimateTrust(stance: VoidFaceAffect["socialBonds"][number]["stance"], intensity: number): number {
  switch (stance) {
    case "trust":
    case "respect":
    case "fondness":
    case "attachment":
    case "protectiveness":
      return clamp01(0.5 + intensity / 2);
    case "suspicion":
    case "irritation":
    case "rivalry":
    case "envy":
      return clamp01(0.5 - intensity / 2);
    default:
      return 0.5;
  }
}

function estimateRelationshipTension(stance: VoidFaceAffect["socialBonds"][number]["stance"], intensity: number): number {
  switch (stance) {
    case "suspicion":
    case "irritation":
    case "rivalry":
    case "envy":
      return intensity;
    default:
      return clamp01(1 - intensity);
  }
}

function statusValence(status: VoidFaceAffect["statusReads"][number]["status"]): number {
  switch (status) {
    case "favored":
    case "pampered":
    case "consulted":
    case "admired":
      return 0.5;
    case "neglected":
    case "bypassed":
    case "blocked":
    case "ignored":
    case "threatened":
      return -0.5;
    default:
      return 0;
  }
}

function latestTimestamp(timestamps: string[]): string {
  return timestamps
    .slice()
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date().toISOString();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
