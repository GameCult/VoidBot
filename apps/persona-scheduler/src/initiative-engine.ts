import { createHash } from "node:crypto";

export interface InitiativeParticipant {
  identityId: string;
  participantKind: "repo_face" | "native_persona" | "system_agent";
  turnKind: "repo_face_rumination" | "void_moderation";
  repoName: string;
  displayName: string;
  initiativeSpeed: number;
  reactionBias: number;
  interruptThreshold: number;
  groups: string[];
  heat: number;
  dynamicHeat: number;
  responsePressure: number;
  responsePressureEvidence: Array<{
    messageId: string;
    observedAt: string;
    similarity: number;
    contribution: number;
  }>;
  semanticInterruptReceipts: string[];
  effectiveSpeed: number;
  baseRecoveryMinutes: number;
  status: "active" | "blocked" | "withdrawn" | "offscreen";
  currentLoad: number;
  nextTurnAt: number;
  lastTurnAt?: number;
  activeTurnStartedAt?: number;
  activeJobId?: string;
  lastQueuedAt?: string;
  queuedCount: number;
  constraints: string[];
}

export interface ParticipantSpec {
  id: string;
  participantKind: InitiativeParticipant["participantKind"];
  turnKind: InitiativeParticipant["turnKind"];
  repoName: string;
  displayName: string;
  allowedChannelIds: string[];
  channelSpeedMultiplier: number;
}

export interface PendingMention {
  identityId: string;
  id?: string;
  channelId?: string;
  messageId?: string;
  authorId?: string;
  authorName?: string;
  queuedAt?: string;
  visiblePrompt?: string;
}

export interface InitiativeState<TParticipant extends InitiativeParticipant = InitiativeParticipant> {
  initiativeClock: number;
  lastTickAt?: string;
  participants: TParticipant[];
  pendingMentions: PendingMention[];
  history: Array<Record<string, unknown>>;
}

export interface RestSnapshot {
  isNapping: boolean;
}

export interface UnpromptedTurnPolicy {
  nextUnpromptedTurnAllowedAt?: string;
}

export interface SemanticPressureProjection {
  identityId: string;
  pressure: number;
  interrupt: boolean;
  evidence: InitiativeParticipant["responsePressureEvidence"];
}

export interface ReconcileParticipantsInput<TSpec extends ParticipantSpec = ParticipantSpec> {
  existing: InitiativeParticipant[];
  specs: TSpec[];
  defaultChannelId?: string;
  speedOverrides: Record<string, number>;
  heatOverrides: Record<string, number>;
  initiativeClock: number;
  baseRecoveryMinutes: number;
  globalHeat: number;
}

export function reconcileParticipants(input: ReconcileParticipantsInput): InitiativeParticipant[] {
  const existingById = new Map(input.existing.map((entry) => [entry.identityId, entry]));
  const count = Math.max(input.specs.length, 1);

  return input.specs.map((spec, index) => {
    const current = existingById.get(spec.id);
    const hasChannel = spec.participantKind === "system_agent" || Boolean(spec.allowedChannelIds[0] || input.defaultChannelId);
    const speed = initiativeSpeedFor(spec, input.speedOverrides) * spec.channelSpeedMultiplier;
    const groups = initiativeGroupsFor(spec);
    const heat = heatFor(spec, groups, input.globalHeat, input.heatOverrides);
    const dynamicHeat = Number.isFinite(current?.dynamicHeat) ? current!.dynamicHeat : 1;
    const effectiveSpeed = clamp(speed * heat * dynamicHeat, 0.1, 12);
    const nextTurnAt = Number.isFinite(current?.nextTurnAt)
      ? current!.nextTurnAt
      : input.initiativeClock + ((input.baseRecoveryMinutes / count) * index);

    if (current) {
      return {
        ...current,
        participantKind: spec.participantKind,
        turnKind: spec.turnKind,
        repoName: spec.repoName,
        displayName: spec.displayName,
        initiativeSpeed: speed,
        groups,
        heat,
        dynamicHeat,
        responsePressure: Number.isFinite(current.responsePressure) ? current.responsePressure : 0,
        responsePressureEvidence: Array.isArray(current.responsePressureEvidence) ? current.responsePressureEvidence : [],
        semanticInterruptReceipts: Array.isArray(current.semanticInterruptReceipts) ? current.semanticInterruptReceipts : [],
        effectiveSpeed,
        baseRecoveryMinutes: input.baseRecoveryMinutes,
        nextTurnAt,
        constraints: mergeStrings(
          mergeStrings(current.constraints, "Agent runtime uses CTB-style turns."),
          "Wall-clock elapsed time advances initiative; heat changes recovery speed but does not fast-forward time.",
        ),
        status: hasChannel
          ? current.status === "withdrawn" || current.status === "blocked" ? current.status : "active"
          : "blocked",
      };
    }

    return {
      identityId: spec.id,
      participantKind: spec.participantKind,
      turnKind: spec.turnKind,
      repoName: spec.repoName,
      displayName: spec.displayName,
      initiativeSpeed: speed,
      reactionBias: reactionBiasFor(spec),
      interruptThreshold: interruptThresholdFor(spec),
      currentLoad: 0,
      status: hasChannel ? "active" : "blocked",
      groups,
      heat,
      dynamicHeat: 1,
      responsePressure: 0,
      responsePressureEvidence: [],
      semanticInterruptReceipts: [],
      effectiveSpeed,
      baseRecoveryMinutes: input.baseRecoveryMinutes,
      nextTurnAt,
      queuedCount: 0,
      constraints: [
        "Agent runtime uses CTB-style turns.",
        "Wall-clock elapsed time advances initiative; heat changes recovery speed but does not fast-forward time.",
        "Worker final summaries are not auto-posted as the base bot.",
      ],
    };
  });
}

export function reconcileInitiativeParticipants<TSpec extends ParticipantSpec>(input: {
  state: InitiativeState;
  specs: TSpec[];
  defaultChannelId?: string;
  speedOverrides: Record<string, number>;
  heatOverrides: Record<string, number>;
  baseRecoveryMinutes: number;
  globalHeat: number;
  activeTurns: Map<string, string>;
  completedThisTick: Set<string>;
}): void {
  input.state.participants = reconcileParticipants({
    existing: input.state.participants,
    specs: input.specs,
    defaultChannelId: input.defaultChannelId,
    speedOverrides: input.speedOverrides,
    heatOverrides: input.heatOverrides,
    initiativeClock: input.state.initiativeClock,
    baseRecoveryMinutes: input.baseRecoveryMinutes,
    globalHeat: input.globalHeat,
  }).map((participant) => applyActiveTurnFreeze(
    participant,
    input.activeTurns.get(participant.identityId),
    input.state,
    input.completedThisTick,
  ));
}

export function applyActiveTurnFreeze<TParticipant extends InitiativeParticipant>(
  participant: TParticipant,
  activeJobId: string | undefined,
  state: InitiativeState<TParticipant>,
  completedThisTick: Set<string>,
): TParticipant {
  if (activeJobId) {
    return {
      ...participant,
      currentLoad: 1,
      activeJobId,
      activeTurnStartedAt: participant.activeTurnStartedAt ?? participant.lastTurnAt ?? state.initiativeClock,
    };
  }

  if (participant.currentLoad >= 1 || participant.activeTurnStartedAt !== undefined || participant.activeJobId) {
    const completedTurnStartedAt = participant.activeTurnStartedAt ?? participant.lastTurnAt ?? state.initiativeClock;
    const unfrozen = {
      ...participant,
      currentLoad: 0,
      activeTurnStartedAt: undefined,
      activeJobId: undefined,
    };
    const recoveryMinutes = recoveryFor(unfrozen);
    unfrozen.nextTurnAt = Math.max(state.initiativeClock, completedTurnStartedAt) + recoveryMinutes;
    completedThisTick.add(participant.identityId);
    state.history.push({
      type: "turn_completed",
      identityId: participant.identityId,
      completedAtClock: state.initiativeClock,
      startedAtClock: completedTurnStartedAt,
      nextTurnAt: unfrozen.nextTurnAt,
      recoveryMinutes,
      heat: participant.heat,
      effectiveSpeed: participant.effectiveSpeed,
    });
    return unfrozen;
  }

  return { ...participant, currentLoad: 0 };
}

export function recordDryRunSelection(
  participant: InitiativeParticipant,
  state: InitiativeState,
  queuedAt: string,
  pendingMentionCount: number,
): void {
  const recoveryMinutes = recoveryFor(participant);
  participant.lastQueuedAt = queuedAt;
  participant.lastTurnAt = state.initiativeClock;
  participant.queuedCount += 1;
  participant.nextTurnAt = Math.max(state.initiativeClock, participant.nextTurnAt) + recoveryMinutes;
  state.history.push({
    type: "dry_run_selected",
    identityId: participant.identityId,
    queuedAt,
    initiativeClock: state.initiativeClock,
    nextTurnAt: participant.nextTurnAt,
    recoveryMinutes,
    heat: participant.heat,
    dynamicHeat: participant.dynamicHeat,
    responsePressure: participant.responsePressure,
    effectiveSpeed: participant.effectiveSpeed,
    pendingMentionCount,
  });
}

export function recordTurnStarted(input: {
  participant: InitiativeParticipant;
  state: InitiativeState;
  queuedAt: string;
  activeJobId?: string;
  requestMessageId?: string;
  pendingMentionCount: number;
}): void {
  const { participant, state } = input;
  participant.lastQueuedAt = input.queuedAt;
  participant.activeTurnStartedAt = state.initiativeClock;
  participant.activeJobId = input.activeJobId;
  participant.lastTurnAt = state.initiativeClock;
  participant.queuedCount += 1;
  participant.currentLoad = 1;
  state.history.push({
    type: "queued",
    identityId: participant.identityId,
    participantKind: participant.participantKind,
    turnKind: participant.turnKind,
    activeJobId: input.activeJobId,
    requestMessageId: input.requestMessageId,
    queuedAt: input.queuedAt,
    initiativeClock: state.initiativeClock,
    frozen: true,
    heat: participant.heat,
    dynamicHeat: participant.dynamicHeat,
    responsePressure: participant.responsePressure,
    effectiveSpeed: participant.effectiveSpeed,
    pendingMentionCount: input.pendingMentionCount,
  });
}

export function recordTurnFailedToStart(input: {
  participant: InitiativeParticipant;
  state: InitiativeState;
  queuedAt: string;
  activeJobId?: string;
  requestMessageId?: string;
  reason: string;
}): void {
  input.participant.currentLoad = 0;
  input.state.history.push({
    type: "turn_failed_to_start",
    identityId: input.participant.identityId,
    participantKind: input.participant.participantKind,
    turnKind: input.participant.turnKind,
    activeJobId: input.activeJobId,
    requestMessageId: input.requestMessageId,
    queuedAt: input.queuedAt,
    initiativeClock: input.state.initiativeClock,
    reason: input.reason,
    heat: input.participant.heat,
    dynamicHeat: input.participant.dynamicHeat,
    responsePressure: input.participant.responsePressure,
    effectiveSpeed: input.participant.effectiveSpeed,
  });
}

export function advanceInitiativeClockFromWallClock(state: InitiativeState, now: Date): void {
  const lastTickMs = Date.parse(state.lastTickAt ?? "");
  if (!Number.isFinite(lastTickMs)) return;
  const elapsedMinutes = (now.getTime() - lastTickMs) / 60_000;
  if (elapsedMinutes <= 0) return;
  state.initiativeClock = round3(state.initiativeClock + Math.min(elapsedMinutes, 60));
}

export function rescheduleStaleOverdueParticipants(state: InitiativeState): void {
  const active = state.participants.filter((participant) => participant.status === "active");
  const count = Math.max(active.length, 1);
  let rescheduledCount = 0;
  active.forEach((participant, index) => {
    const staleThreshold = Math.max(participant.baseRecoveryMinutes, 15);
    if (participant.nextTurnAt >= state.initiativeClock - staleThreshold) return;
    participant.nextTurnAt = round3(state.initiativeClock + (participant.baseRecoveryMinutes / count) * index);
    rescheduledCount += 1;
  });
  if (rescheduledCount > 0) {
    state.history.push({ type: "wall_clock_resync", rescheduledCount, initiativeClock: state.initiativeClock });
  }
}

export function applyPendingMentionPriority(state: InitiativeState): void {
  const counts = countPendingMentionsByIdentity(state.pendingMentions);
  for (const participant of state.participants) {
    if (participant.status === "active" && participant.currentLoad < 1 && (counts.get(participant.identityId) ?? 0) > 0) {
      participant.nextTurnAt = Math.min(participant.nextTurnAt, state.initiativeClock);
    }
  }
}

export function applySchedulerControls(input: {
  state: InitiativeState;
  baseRecoveryMinutes: number;
  globalHeat: number;
}): void {
  Object.assign(input.state, {
    baseRecoveryMinutes: input.baseRecoveryMinutes,
    globalHeat: input.globalHeat,
  });
}

export function recordSchedulerSkip(input: {
  state: InitiativeState;
  skippedAt: Date;
  reason: string;
  details?: Record<string, unknown>;
}): void {
  input.state.lastTickAt = input.skippedAt.toISOString();
  input.state.history.push({
    type: "skipped",
    reason: input.reason,
    skippedAt: input.state.lastTickAt,
    ...input.details,
  });
  trimSchedulerHistory(input.state);
}

export function recordStaleActiveTurnRecoveries(input: {
  state: InitiativeState;
  recoveredAt: Date;
  recoveries: Array<{
    identityId: string;
    jobId: string;
    requestMessageId?: string;
    state: string;
    updatedAt: string;
    ageMinutes: number;
  }>;
}): void {
  for (const stale of input.recoveries) {
    input.state.history.push({
      type: "stale_active_turn_recovered",
      identityId: stale.identityId,
      activeJobId: stale.jobId,
      requestMessageId: stale.requestMessageId,
      jobState: stale.state,
      jobUpdatedAt: stale.updatedAt,
      ageMinutes: stale.ageMinutes,
      recoveredAt: input.recoveredAt.toISOString(),
    });
  }
}

export function consumePendingMentions(input: {
  state: InitiativeState;
  participant: InitiativeParticipant;
  mentions: PendingMention[];
  consumedAt: string;
  activeJobId?: string;
  requestMessageId?: string;
}): void {
  if (input.mentions.length === 0) return;
  const consumedIds = new Set(input.mentions.map((entry) => entry.id).filter((id): id is string => Boolean(id)));
  input.state.pendingMentions = input.state.pendingMentions.filter((entry) => !entry.id || !consumedIds.has(entry.id));
  input.state.history.push({
    type: "pending_mentions_consumed",
    identityId: input.participant.identityId,
    participantKind: input.participant.participantKind,
    turnKind: input.participant.turnKind,
    activeJobId: input.activeJobId,
    requestMessageId: input.requestMessageId,
    consumedAt: input.consumedAt,
    mentionCount: input.mentions.length,
    mentions: input.mentions.slice(-6).map((mention) => ({
      id: mention.id,
      channelId: mention.channelId,
      messageId: mention.messageId,
      authorId: mention.authorId,
      authorName: mention.authorName,
      queuedAt: mention.queuedAt,
      visiblePrompt: collapseWhitespace(mention.visiblePrompt ?? "", 240),
    })),
  });
}

export function finalizeSchedulerTick(state: InitiativeState, completedAt: Date): void {
  state.lastTickAt = completedAt.toISOString();
  trimSchedulerHistory(state);
}

export function applySemanticPressureProjection(input: {
  state: InitiativeState;
  projections: SemanticPressureProjection[];
  projectedAt: Date;
  unavailableReason?: string;
}): void {
  for (const participant of input.state.participants) {
    const projection = input.projections.find((entry) => entry.identityId === participant.identityId);
    participant.responsePressure = projection?.pressure ?? 0;
    participant.responsePressureEvidence = projection?.evidence ?? [];
    participant.dynamicHeat = clamp(1 + participant.responsePressure * 1.5, 1, 2.5);
    participant.effectiveSpeed = clamp(
      participant.initiativeSpeed * participant.heat * participant.dynamicHeat,
      0.1,
      12,
    );
    const unseenInterruptEvidence = projection?.interrupt
      ? projection.evidence.find((entry) => !participant.semanticInterruptReceipts.includes(entry.messageId))
      : undefined;
    if (!unseenInterruptEvidence || participant.currentLoad >= 1) continue;
    participant.nextTurnAt = Math.min(participant.nextTurnAt, input.state.initiativeClock);
    participant.semanticInterruptReceipts = mergeStrings(
      participant.semanticInterruptReceipts,
      unseenInterruptEvidence.messageId,
    ).slice(-40);
    input.state.history.push({
      type: "semantic_response_interrupt",
      identityId: participant.identityId,
      messageId: unseenInterruptEvidence.messageId,
      pressure: participant.responsePressure,
      similarity: unseenInterruptEvidence.similarity,
      contribution: unseenInterruptEvidence.contribution,
      observedAt: unseenInterruptEvidence.observedAt,
      projectedAt: input.projectedAt.toISOString(),
    });
  }
  if (input.unavailableReason) {
    input.state.history.push({
      type: "semantic_response_pressure_unavailable",
      observedAt: input.projectedAt.toISOString(),
      reason: input.unavailableReason,
    });
  }
}

export function countPendingMentionsByIdentity(pendingMentions: PendingMention[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mention of pendingMentions) {
    counts.set(mention.identityId, (counts.get(mention.identityId) ?? 0) + 1);
  }
  return counts;
}

export function selectReadyParticipants<TParticipant extends InitiativeParticipant>(
  state: InitiativeState<TParticipant>,
  maxJobs: number,
  completedThisTick: Set<string>,
  restStates: Map<string, RestSnapshot>,
  unpromptedTurnPolicy: UnpromptedTurnPolicy,
  nowMs = Date.now(),
): TParticipant[] {
  const mentionCounts = countPendingMentionsByIdentity(state.pendingMentions);
  const ready = state.participants
    .filter((participant) => participant.status === "active" && participant.currentLoad < 1)
    .filter((participant) => !completedThisTick.has(participant.identityId))
    .filter((participant) => participant.participantKind !== "repo_face" || (mentionCounts.get(participant.identityId) ?? 0) > 0 || restStates.get(participant.identityId)?.isNapping !== true)
    .filter((participant) => participant.nextTurnAt <= state.initiativeClock)
    .sort((left, right) => {
      const mentionDelta = (mentionCounts.get(right.identityId) ?? 0) - (mentionCounts.get(left.identityId) ?? 0);
      return mentionDelta || left.nextTurnAt - right.nextTurnAt || right.reactionBias - left.reactionBias || right.effectiveSpeed - left.effectiveSpeed || left.identityId.localeCompare(right.identityId);
    });

  const mentioned = ready.filter((participant) => (mentionCounts.get(participant.identityId) ?? 0) > 0);
  const unprompted = ready.filter((participant) =>
    (mentionCounts.get(participant.identityId) ?? 0) === 0
    && hasMeaningfulUnpromptedPressure(participant));
  const allowsUnprompted = !unpromptedTurnPolicy.nextUnpromptedTurnAllowedAt
    || Date.parse(unpromptedTurnPolicy.nextUnpromptedTurnAllowedAt) <= nowMs;
  const admittedUnprompted = allowsUnprompted && mentioned.length < maxJobs ? unprompted.slice(0, 1) : [];
  return [...mentioned, ...admittedUnprompted].slice(0, maxJobs);
}

function hasMeaningfulUnpromptedPressure(participant: InitiativeParticipant): boolean {
  return participant.responsePressure >= participant.interruptThreshold;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function trimSchedulerHistory(state: InitiativeState, limit = 80): void {
  state.history = state.history.slice(-limit);
}

function collapseWhitespace(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function initiativeSpeedFor(spec: ParticipantSpec, overrides: Record<string, number>): number {
  const override = overrides[spec.id.toLowerCase()];
  if (override !== undefined) return clamp(override, 0.35, 6);
  if (spec.id === "void") return 1;
  return clamp(0.85 + stableUnit(spec.id, "speed") * 0.45, 0.75, 1.3);
}

function recoveryFor(participant: InitiativeParticipant): number {
  const loadPenalty = 1 + participant.currentLoad * 0.75;
  return (participant.baseRecoveryMinutes * loadPenalty) / Math.max(participant.effectiveSpeed, 0.1);
}

function initiativeGroupsFor(spec: ParticipantSpec): string[] {
  return Array.from(new Set([
    "all",
    `kind:${spec.participantKind}`,
    `turn:${spec.turnKind}`,
    `identity:${normalizeKey(spec.id)}`,
    `repo:${normalizeKey(spec.repoName)}`,
    `display:${normalizeKey(spec.displayName)}`,
    ...spec.allowedChannelIds.map((channelId) => `channel:${channelId}`),
  ]));
}

function heatFor(spec: ParticipantSpec, groups: string[], globalHeat: number, overrides: Record<string, number>): number {
  const keys = ["all", ...groups, normalizeKey(spec.id), normalizeKey(spec.repoName), normalizeKey(spec.displayName)];
  return clamp(keys.reduce((heat, key) => heat * (overrides[key] ?? 1), globalHeat), 0.05, 20);
}

function reactionBiasFor(spec: ParticipantSpec): number {
  return spec.id === "void" ? 0.55 : clamp(0.2 + stableUnit(spec.id, "reaction") * 0.55, 0.2, 0.75);
}

function interruptThresholdFor(spec: ParticipantSpec): number {
  return spec.id === "void" ? 0.5 : clamp(0.45 + stableUnit(spec.id, "threshold") * 0.35, 0.45, 0.8);
}

function stableUnit(id: string, salt: string): number {
  const hex = createHash("sha1").update(`${id}:${salt}`).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

function mergeStrings(values: string[], value: string): string[] {
  return Array.from(new Set([...values, value]));
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}
