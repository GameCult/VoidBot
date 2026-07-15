export interface InitiativeParticipant {
  identityId: string;
  participantKind: "repo_face" | "native_persona" | "system_agent";
  status: "active" | "blocked" | "withdrawn" | "offscreen";
  currentLoad: number;
  nextTurnAt: number;
  baseRecoveryMinutes: number;
  reactionBias: number;
  effectiveSpeed: number;
}

export interface PendingMention {
  identityId: string;
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

export interface IdleCoolingPolicy {
  enabled: boolean;
  active: boolean;
  nextUnpromptedTurnAllowedAt?: string;
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
  idleCooling: IdleCoolingPolicy,
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

  if (!idleCooling.enabled || !idleCooling.active) return ready.slice(0, maxJobs);
  const mentioned = ready.filter((participant) => (mentionCounts.get(participant.identityId) ?? 0) > 0);
  const unprompted = ready.filter((participant) => (mentionCounts.get(participant.identityId) ?? 0) === 0);
  const allowsUnprompted = !idleCooling.nextUnpromptedTurnAllowedAt || Date.parse(idleCooling.nextUnpromptedTurnAllowedAt) <= nowMs;
  const cooled = allowsUnprompted && mentioned.length < maxJobs ? unprompted.slice(0, 1) : [];
  return [...mentioned, ...cooled].slice(0, maxJobs);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
