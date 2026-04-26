import { Pool } from "pg";

import { FileAuditLog } from "./audit-log";
import { FileInteractionMemoryBank } from "./interaction-memory";
import { FileBackedJobQueue } from "./job-queue";
import { PostgresAuditLog } from "./state-storage-postgres-audit-log";
import {
  bootstrapPostgres,
  migrateLegacyFileStateIfNeeded,
} from "./state-storage-postgres-bootstrap";
import { PostgresJobQueue } from "./state-storage-postgres-job-queue";
import { PostgresInteractionMemoryBank } from "./state-storage-postgres-interaction-memory";
import {
  FileBackedVoidUsageRateLimitStore,
  PostgresVoidUsageRateLimitStore,
} from "./state-storage-rate-limit-stores";
import { type StateStorage, type StateStorageConfig } from "./state-storage-types";

export type { StateStorage, StateStorageConfig } from "./state-storage-types";

export async function createStateStorage(
  config: StateStorageConfig,
): Promise<StateStorage> {
  if (config.backend === "file") {
    return {
      backend: "file",
      jobQueue: new FileBackedJobQueue(config.jobsFile),
      auditLog: new FileAuditLog(config.auditLogFile),
      interactionMemory: new FileInteractionMemoryBank(config.interactionMemoryFile),
      voidUsageRateLimits: new FileBackedVoidUsageRateLimitStore(config.rateLimitStateFile),
      close: async () => undefined,
    };
  }

  const pool = new Pool({
    connectionString: config.databaseDsn,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    application_name: "voidbot",
  });

  try {
    await bootstrapPostgres(pool);
    await migrateLegacyFileStateIfNeeded(config, pool);

    return {
      backend: "postgres",
      jobQueue: new PostgresJobQueue(pool),
      auditLog: new PostgresAuditLog(pool),
      interactionMemory: new PostgresInteractionMemoryBank(pool),
      voidUsageRateLimits: new PostgresVoidUsageRateLimitStore(pool),
      close: async () => {
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
