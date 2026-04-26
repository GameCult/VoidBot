import type { AuditLog } from "./audit-log";
import type { InteractionMemoryBank } from "./interaction-memory";
import type { JobQueue } from "./job-queue";
import type { VoidUsageRateLimitStore } from "./void-usage-rate-limiter";

export interface StateStorageConfig {
  backend: "file" | "postgres";
  databaseDsn: string;
  jobsFile: string;
  auditLogFile: string;
  interactionMemoryFile: string;
  rateLimitStateFile: string;
}

export interface StateStorage {
  backend: "file" | "postgres";
  jobQueue: JobQueue;
  auditLog: AuditLog;
  interactionMemory: InteractionMemoryBank;
  voidUsageRateLimits: VoidUsageRateLimitStore;
  close(): Promise<void>;
}
