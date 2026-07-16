
import { createStateStorage } from "@voidbot/core";

const HEARTBEAT_COMMAND = "repo-face-rumination";
const MIN_STALE_ACTIVE_JOB_MS = 45 * 60_000;

export interface StaleActiveTurn {
  identityId: string;
  jobId: string;
  requestMessageId?: string;
  state: string;
  updatedAt?: string;
  ageMinutes: number;
}

export interface ActiveTurnScan {
  active: Map<string, string>;
  staleRecovered: StaleActiveTurn[];
}

export interface ActiveTurnSourceConfig {
  databaseDsn: string;
  stateStorageBackend: "file" | "postgres";
  jobsFile: string;
  auditLogFile: string;
  interactionMemoryFile: string;
  rateLimitStateFile: string;
  storageRoot: string;
  codexExecTimeoutMs: number;
}

export async function scanActivePersonaTurns(
  config: ActiveTurnSourceConfig,
  nowMs = Date.now(),
): Promise<ActiveTurnScan> {
  const storage = await createStateStorage({
    backend: config.stateStorageBackend,
    databaseDsn: config.databaseDsn,
    jobsFile: config.jobsFile,
    auditLogFile: config.auditLogFile,
    interactionMemoryFile: config.interactionMemoryFile,
    rateLimitStateFile: config.rateLimitStateFile,
  });
  try {
    const jobs = await storage.jobQueue.listByStates(["approved", "running"]);
    const active = new Map<string, string>();
    const staleRecovered: StaleActiveTurn[] = [];
    const staleAfterMs = staleActiveTurnThresholdMs(config.codexExecTimeoutMs);
    for (const job of jobs) {
      if (job.command !== HEARTBEAT_COMMAND) continue;
      const identityId = parsePersonaTurnIdentity(job.requestMessageId);
      if (!identityId) continue;
      const updatedMs = Date.parse(job.updatedAt);
      const ageMs = Number.isFinite(updatedMs) ? nowMs - updatedMs : Number.POSITIVE_INFINITY;
      if (ageMs > staleAfterMs) {
        const ageMinutes = Number.isFinite(ageMs) ? Math.round((ageMs / 60_000) * 10) / 10 : -1;
        await storage.jobQueue.markFailed(
          job.id,
          `Persona scheduler recovered stale active turn after ${ageMinutes} minutes without progress.`,
        );
        staleRecovered.push({
          identityId,
          jobId: job.id,
          requestMessageId: job.requestMessageId,
          state: job.state,
          updatedAt: job.updatedAt,
          ageMinutes,
        });
        continue;
      }
      active.set(identityId, job.id);
    }
    return { active, staleRecovered };
  } finally {
    await storage.close();
  }
}

export function parsePersonaTurnIdentity(requestMessageId: string | undefined): string | undefined {
  const match =
    requestMessageId?.match(/^agent-turn:([^:]+):/) ??
    requestMessageId?.match(/^agent-heartbeat:([^:]+):/) ??
    requestMessageId?.match(/^repo-face-heartbeat:([^:]+):/) ??
    requestMessageId?.match(/:repo-face:([^:]+):\d+$/);
  return match?.[1];
}

export function staleActiveTurnThresholdMs(codexExecTimeoutMs: number): number {
  return Math.max(MIN_STALE_ACTIVE_JOB_MS, codexExecTimeoutMs * 3);
}
