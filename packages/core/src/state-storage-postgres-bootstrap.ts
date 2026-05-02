import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { type Pool } from "pg";

import { FileAuditLog } from "./audit-log";
import { FileInteractionMemoryBank } from "./interaction-memory";
import { FileBackedJobQueue } from "./job-queue";
import {
  upsertAuditEvent,
} from "./state-storage-postgres-audit-log";
import {
  dedupeLegacyJobs,
  upsertJob,
} from "./state-storage-postgres-job-queue";
import {
  upsertInteractionIdentityState,
  upsertInteractionMemoryEvent,
} from "./state-storage-postgres-interaction-memory";
import { type StateStorageConfig } from "./state-storage-types";

const LEGACY_FILE_STATE_IMPORT = "legacy_file_state_import_v1";

export async function bootstrapPostgres(pool: Pool): Promise<void> {
  const sqlPath = resolve(process.cwd(), "packages", "core", "sql", "bootstrap.sql");
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
}

export async function migrateLegacyFileStateIfNeeded(
  config: StateStorageConfig,
  pool: Pool,
): Promise<void> {
  const existing = await pool.query<{ name: string }>(
    "select name from state_migrations where name = $1",
    [LEGACY_FILE_STATE_IMPORT],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    return;
  }

  const fileJobQueue = new FileBackedJobQueue(config.jobsFile);
  const fileAuditLog = new FileAuditLog(config.auditLogFile);
  const fileMemoryBank = new FileInteractionMemoryBank(config.interactionMemoryFile);
  const jobs = dedupeLegacyJobs(await fileJobQueue.exportJobs());
  const importedJobIds = new Set(jobs.map((job) => job.id));
  const auditEvents = await fileAuditLog.listEvents();
  const profiles = await fileMemoryBank.listProfiles();
  const memoryEvents = profiles.flatMap((profile) => profile.recentEvents);
  const client = await pool.connect();

  try {
    await client.query("begin");

    for (const job of jobs) {
      await upsertJob(client, job);
    }

    for (const event of auditEvents) {
      await upsertAuditEvent(client, {
        ...event,
        jobId: event.jobId && importedJobIds.has(event.jobId) ? event.jobId : undefined,
      });
    }

    for (const event of memoryEvents) {
      await upsertInteractionMemoryEvent(client, event);
    }

    for (const profile of profiles) {
      if (profile.pronounEvidence.length === 0) {
        continue;
      }

      await upsertInteractionIdentityState(client, profile.actorId, {
        pronounPolicy: profile.pronounPolicy,
        resolvedPronounSet: profile.resolvedPronounSet,
        pronounConfidence: profile.pronounConfidence,
        pronounGuidance: profile.pronounGuidance,
        pronounEvidence: profile.pronounEvidence,
      });
    }

    await client.query(
      "insert into state_migrations (name) values ($1) on conflict (name) do nothing",
      [LEGACY_FILE_STATE_IMPORT],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
