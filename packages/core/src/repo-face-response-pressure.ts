export interface ResponsePressureEvidence {
  messageId: string;
  observedAt: string;
  similarity: number;
}

export interface ResponsePressureProjection {
  identityId: string;
  pressure: number;
  interrupt: boolean;
  evidence: Array<ResponsePressureEvidence & { contribution: number }>;
}

export interface ResponsePressureParticipant {
  identityId: string;
  interruptThreshold: number;
}

export function projectRepoFaceResponsePressure(input: {
  participants: ResponsePressureParticipant[];
  evidence: Array<ResponsePressureEvidence & { identityId: string }>;
  now: Date;
  halfLifeMinutes?: number;
  ttlMinutes?: number;
  similarityFloor?: number;
  maxAwakened?: number;
}): ResponsePressureProjection[] {
  const halfLifeMinutes = positive(input.halfLifeMinutes, 30);
  const ttlMinutes = positive(input.ttlMinutes, 180);
  const similarityFloor = bounded(input.similarityFloor ?? 0.32, 0, 0.99);
  const byIdentity = new Map<string, Array<ResponsePressureEvidence & { contribution: number }>>();

  for (const item of input.evidence) {
    const ageMinutes = Math.max(0, (input.now.getTime() - Date.parse(item.observedAt)) / 60_000);
    if (!Number.isFinite(ageMinutes) || ageMinutes > ttlMinutes || item.similarity < similarityFloor) {
      continue;
    }
    const normalized = (item.similarity - similarityFloor) / (1 - similarityFloor);
    const contribution = bounded(normalized * 2 ** (-ageMinutes / halfLifeMinutes), 0, 1);
    if (contribution <= 0) {
      continue;
    }
    const entries = byIdentity.get(item.identityId) ?? [];
    const priorIndex = entries.findIndex((entry) => entry.messageId === item.messageId);
    const projected = { ...item, contribution };
    if (priorIndex >= 0) {
      entries[priorIndex] = projected;
    } else {
      entries.push(projected);
    }
    byIdentity.set(item.identityId, entries);
  }

  const projections = input.participants.map((participant) => {
    const evidence = (byIdentity.get(participant.identityId) ?? [])
      .sort((left, right) => right.contribution - left.contribution || left.messageId.localeCompare(right.messageId));
    const pressure = bounded(noisyOr(evidence.map((entry) => entry.contribution)), 0, 1);
    return {
      identityId: participant.identityId,
      pressure,
      interrupt: pressure >= bounded(participant.interruptThreshold, 0, 1),
      evidence: evidence.slice(0, 6),
    };
  }).sort((left, right) => right.pressure - left.pressure || left.identityId.localeCompare(right.identityId));

  const awakened = new Set(
    projections.filter((projection) => projection.pressure > 0).slice(0, positiveInteger(input.maxAwakened, 3))
      .map((projection) => projection.identityId),
  );
  return projections.map((projection) => awakened.has(projection.identityId)
    ? projection
    : { ...projection, pressure: 0, interrupt: false, evidence: [] });
}

function noisyOr(values: number[]): number {
  return 1 - values.reduce((remainder, value) => remainder * (1 - bounded(value, 0, 1)), 1);
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(positive(value, fallback)));
}
