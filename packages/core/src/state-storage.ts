import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Pool, type PoolClient } from "pg";

import {
  type AuditEvent,
  type InteractionMemoryEvent,
  type InteractionMemoryProfile,
  type JobRecord,
} from "@voidbot/shared";

import { type AuditEventInput, type AuditLog, FileAuditLog } from "./audit-log";
import {
  buildInteractionMemoryEvent,
  type RecordInteractionInput,
  shouldPersistInteractionEvent,
  summarizeInteractionProfile,
} from "./interaction-memory-logic";
import {
  type InteractionMemoryBank,
  FileInteractionMemoryBank,
} from "./interaction-memory";
import {
  type CreateJobInput,
  type CreateJobResult,
  type JobQueue,
  FileBackedJobQueue,
} from "./job-queue";

const LEGACY_FILE_STATE_IMPORT = "legacy_file_state_import_v1";

export interface StateStorageConfig {
  backend: "file" | "postgres";
  databaseDsn: string;
  jobsFile: string;
  auditLogFile: string;
  interactionMemoryFile: string;
}

export interface StateStorage {
  backend: "file" | "postgres";
  jobQueue: JobQueue;
  auditLog: AuditLog;
  interactionMemory: InteractionMemoryBank;
  close(): Promise<void>;
}

export async function createStateStorage(
  config: StateStorageConfig,
): Promise<StateStorage> {
  if (config.backend === "file") {
    return {
      backend: "file",
      jobQueue: new FileBackedJobQueue(config.jobsFile),
      auditLog: new FileAuditLog(config.auditLogFile),
      interactionMemory: new FileInteractionMemoryBank(config.interactionMemoryFile),
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
      close: async () => {
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

class PostgresJobQueue implements JobQueue {
  public constructor(private readonly pool: Pool) {}

  public async createJob(input: CreateJobInput): Promise<CreateJobResult> {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      command: input.command,
      state: input.initialState ?? "awaiting_approval",
      provider: input.provider,
      runApprovalRequired: input.runApprovalRequired ?? true,
      postApprovalRequired: input.postApprovalRequired ?? true,
      requester: input.requester,
      guildContext: input.guildContext,
      prompt: input.prompt,
      contextBundle: input.contextBundle,
      createdAt: now,
      updatedAt: now,
      outputChannelId: input.outputChannelId,
      requestMessageId: input.requestMessageId,
      approvals: [],
    };

    try {
      await insertJob(this.pool, job);
      return {
        job: cloneJson(job),
        created: true,
      };
    } catch (error) {
      if (
        (error as { code?: string }).code === "23505" &&
        input.requestMessageId !== undefined
      ) {
        const existing = await this.getExistingDedupedJob(input);

        if (existing) {
          return {
            job: existing,
            created: false,
          };
        }
      }

      throw error;
    }
  }

  public async getJob(jobId: string): Promise<JobRecord | undefined> {
    const result = await this.pool.query<{ job_json: unknown }>(
      "select job_json from jobs where id = $1",
      [jobId],
    );
    return deserializeJobRow(result.rows[0]);
  }

  public async listByStates(states: JobRecord["state"][]): Promise<JobRecord[]> {
    const result = await this.pool.query<{ job_json: unknown }>(
      "select job_json from jobs where state = any($1::text[]) order by created_at asc",
      [states],
    );
    return result.rows
      .map(deserializeJobRow)
      .filter((job): job is JobRecord => job !== undefined);
  }

  public async listRunnableJobs(): Promise<JobRecord[]> {
    return this.listByStates(["approved"]);
  }

  public async claimRunnableJobs(limit?: number): Promise<JobRecord[]> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const claimLimit = limit ?? 25;
      const rows = await client.query<{ job_json: unknown }>(
        `select job_json
         from jobs
         where state = 'approved'
         order by created_at asc
         for update skip locked
         limit $1`,
        [claimLimit],
      );
      const claimed: JobRecord[] = [];

      for (const row of rows.rows) {
        const job = deserializeJobRow(row);

        if (!job) {
          continue;
        }

        job.state = "running";
        job.updatedAt = new Date().toISOString();
        await persistJob(client, job);
        claimed.push(cloneJson(job));
      }

      await client.query("commit");
      return claimed;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async approveRun(jobId: string, actorId: string): Promise<JobRecord> {
    return this.updateJob(jobId, (job) => {
      if (job.state !== "awaiting_approval") {
        throw new Error(`Job ${jobId} is not awaiting run approval.`);
      }

      job.state = "approved";
      job.updatedAt = new Date().toISOString();
      job.approvals.push({
        stage: "run",
        status: "approved",
        actorId,
        createdAt: job.updatedAt,
      });
    });
  }

  public async rejectJob(jobId: string, actorId: string, reason?: string): Promise<JobRecord> {
    return this.updateJob(jobId, (job) => {
      const stage = job.state === "awaiting_post_approval" ? "post" : "run";
      job.state = "cancelled";
      job.updatedAt = new Date().toISOString();
      job.approvals.push({
        stage,
        status: "rejected",
        actorId,
        reason,
        createdAt: job.updatedAt,
      });
    });
  }

  public async markRunning(jobId: string): Promise<JobRecord> {
    return this.updateJob(jobId, (job) => {
      if (job.state !== "approved") {
        throw new Error(`Job ${jobId} is not ready to run.`);
      }

      job.state = "running";
      job.updatedAt = new Date().toISOString();
    });
  }

  public async markAwaitingPostApproval(
    jobId: string,
    artifactPaths: Record<string, string>,
    summary: string,
  ): Promise<JobRecord> {
    return this.updateJob(jobId, (job) => {
      if (job.state !== "running") {
        throw new Error(`Job ${jobId} is not currently running.`);
      }

      if (!job.postApprovalRequired) {
        throw new Error(`Job ${jobId} does not require post approval.`);
      }

      job.state = "awaiting_post_approval";
      job.manualArtifacts = artifactPaths;
      job.summary = summary;
      job.updatedAt = new Date().toISOString();
    });
  }

  public async markFailed(jobId: string, error: string): Promise<JobRecord> {
    return this.updateJob(jobId, (job) => {
      job.state = "failed";
      job.error = error;
      job.updatedAt = new Date().toISOString();
    });
  }

  public async completeJob(
    jobId: string,
    actorId: string,
    finalResponse: string,
  ): Promise<JobRecord> {
    return this.updateJob(jobId, (job) => {
      if (job.state !== "awaiting_post_approval") {
        throw new Error(`Job ${jobId} is not awaiting post approval.`);
      }

      job.state = "completed";
      job.finalResponse = finalResponse;
      job.updatedAt = new Date().toISOString();
      job.approvals.push({
        stage: "post",
        status: "approved",
        actorId,
        createdAt: job.updatedAt,
      });
    });
  }

  public async completeJobDirect(jobId: string, finalResponse: string): Promise<JobRecord> {
    return this.updateJob(jobId, (job) => {
      if (job.state !== "running") {
        throw new Error(`Job ${jobId} is not currently running.`);
      }

      job.state = "completed";
      job.finalResponse = finalResponse;
      job.updatedAt = new Date().toISOString();
    });
  }

  private async getExistingDedupedJob(input: CreateJobInput): Promise<JobRecord | undefined> {
    const result = await this.pool.query<{ job_json: unknown }>(
      `select job_json
       from jobs
       where request_message_id = $1
         and command_name = $2
         and provider_name = $3
         and output_channel_id = $4
       limit 1`,
      [input.requestMessageId, input.command, input.provider, input.outputChannelId],
    );
    return deserializeJobRow(result.rows[0]);
  }

  private async updateJob(
    jobId: string,
    updater: (job: JobRecord) => void,
  ): Promise<JobRecord> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      const job = await loadJobForUpdate(client, jobId);

      updater(job);
      await persistJob(client, job);
      await client.query("commit");
      return cloneJson(job);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresAuditLog implements AuditLog {
  public constructor(private readonly pool: Pool) {}

  public async record(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      actorId: input.actorId,
      jobId: input.jobId,
      provider: input.provider,
      details: input.details,
    };

    await this.pool.query(
      `insert into audit_events (
        id,
        job_id,
        actor_discord_id,
        event_type,
        provider_name,
        event_timestamp,
        event_json
      ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      on conflict (id) do update
      set job_id = excluded.job_id,
          actor_discord_id = excluded.actor_discord_id,
          event_type = excluded.event_type,
          provider_name = excluded.provider_name,
          event_timestamp = excluded.event_timestamp,
          event_json = excluded.event_json`,
      [
        event.id,
        event.jobId ?? null,
        event.actorId ?? null,
        event.type,
        event.provider ?? null,
        event.timestamp,
        JSON.stringify(event),
      ],
    );

    return event;
  }
}

class PostgresInteractionMemoryBank implements InteractionMemoryBank {
  public constructor(private readonly pool: Pool) {}

  public async getProfile(
    actorId: string,
  ): Promise<InteractionMemoryProfile | undefined> {
    const events = await this.listActorEvents(actorId);

    if (events.length === 0) {
      return undefined;
    }

    const profile = summarizeInteractionProfile(
      actorId,
      events[events.length - 1].actorName,
      events,
    );

    return profile.totalInteractions > 0 ? profile : undefined;
  }

  public async recordInteraction(
    input: RecordInteractionInput,
  ): Promise<InteractionMemoryProfile> {
    const existingEvents = await this.listActorEvents(input.actorId);
    const priorEvents = existingEvents.filter((event) => event.id !== input.eventId);
    const event = buildInteractionMemoryEvent(input, priorEvents);

    if (!shouldPersistInteractionEvent(event)) {
      if (input.eventId) {
        await this.pool.query("delete from interaction_memory_events where id = $1", [input.eventId]);
      }

      return summarizeInteractionProfile(input.actorId, input.actorName, priorEvents);
    }

    await this.pool.query(
      `insert into interaction_memory_events (
        id,
        actor_id,
        actor_name,
        source_kind,
        guild_id,
        channel_id,
        channel_name,
        command_name,
        prompt,
        excerpt,
        summary,
        sentiment,
        score,
        tags,
        event_timestamp,
        event_json
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15, $16::jsonb)
      on conflict (id) do update
      set actor_id = excluded.actor_id,
          actor_name = excluded.actor_name,
          source_kind = excluded.source_kind,
          guild_id = excluded.guild_id,
          channel_id = excluded.channel_id,
          channel_name = excluded.channel_name,
          command_name = excluded.command_name,
          prompt = excluded.prompt,
          excerpt = excluded.excerpt,
          summary = excluded.summary,
          sentiment = excluded.sentiment,
          score = excluded.score,
          tags = excluded.tags,
          event_timestamp = excluded.event_timestamp,
          event_json = excluded.event_json`,
      [
        event.id,
        event.actorId,
        event.actorName,
        event.sourceKind,
        event.guildId ?? null,
        event.channelId,
        event.channelName ?? null,
        event.command ?? null,
        event.prompt,
        event.excerpt,
        event.summary,
        event.sentiment,
        event.score,
        event.tags,
        event.timestamp,
        JSON.stringify(event),
      ],
    );

    return summarizeInteractionProfile(input.actorId, input.actorName, [...priorEvents, event]);
  }

  private async listActorEvents(actorId: string): Promise<InteractionMemoryEvent[]> {
    const result = await this.pool.query<{ event_json: unknown }>(
      `select event_json
       from interaction_memory_events
       where actor_id = $1
       order by event_timestamp asc, id asc`,
      [actorId],
    );

    return result.rows
      .map((row) => deserializeJson<InteractionMemoryEvent>(row.event_json))
      .filter((event): event is InteractionMemoryEvent => event !== undefined);
  }
}

async function bootstrapPostgres(pool: Pool): Promise<void> {
  const sqlPath = resolve(process.cwd(), "packages", "core", "sql", "bootstrap.sql");
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
}

async function migrateLegacyFileStateIfNeeded(
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
      await client.query(
        `insert into audit_events (
          id,
          job_id,
          actor_discord_id,
          event_type,
          provider_name,
          event_timestamp,
          event_json
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        on conflict (id) do update
        set job_id = excluded.job_id,
            actor_discord_id = excluded.actor_discord_id,
            event_type = excluded.event_type,
            provider_name = excluded.provider_name,
            event_timestamp = excluded.event_timestamp,
            event_json = excluded.event_json`,
        [
          event.id,
          event.jobId && importedJobIds.has(event.jobId) ? event.jobId : null,
          event.actorId ?? null,
          event.type,
          event.provider ?? null,
          event.timestamp,
          JSON.stringify(event),
        ],
      );
    }

    for (const event of memoryEvents) {
      await client.query(
        `insert into interaction_memory_events (
          id,
          actor_id,
          actor_name,
          source_kind,
          guild_id,
          channel_id,
          channel_name,
          command_name,
          prompt,
          excerpt,
          summary,
          sentiment,
          score,
          tags,
          event_timestamp,
          event_json
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15, $16::jsonb)
        on conflict (id) do update
        set actor_id = excluded.actor_id,
            actor_name = excluded.actor_name,
            source_kind = excluded.source_kind,
            guild_id = excluded.guild_id,
            channel_id = excluded.channel_id,
            channel_name = excluded.channel_name,
            command_name = excluded.command_name,
            prompt = excluded.prompt,
            excerpt = excluded.excerpt,
            summary = excluded.summary,
            sentiment = excluded.sentiment,
            score = excluded.score,
            tags = excluded.tags,
            event_timestamp = excluded.event_timestamp,
            event_json = excluded.event_json`,
        [
          event.id,
          event.actorId,
          event.actorName,
          event.sourceKind,
          event.guildId ?? null,
          event.channelId,
          event.channelName ?? null,
          event.command ?? null,
          event.prompt,
          event.excerpt,
          event.summary,
          event.sentiment,
          event.score,
          event.tags,
          event.timestamp,
          JSON.stringify(event),
        ],
      );
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

async function insertJob(pool: Pool, job: JobRecord): Promise<void> {
  await upsertJob(pool, job, false);
}

async function upsertJob(
  client: Pool | PoolClient,
  job: JobRecord,
  useUpsert = true,
): Promise<void> {
  const conflictClause = useUpsert
    ? `on conflict (id) do update
       set request_message_id = excluded.request_message_id,
           command_name = excluded.command_name,
           state = excluded.state,
           provider_name = excluded.provider_name,
           requester_discord_id = excluded.requester_discord_id,
           guild_id = excluded.guild_id,
           output_channel_id = excluded.output_channel_id,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           job_json = excluded.job_json`
    : "";

  await client.query(
    `insert into jobs (
      id,
      request_message_id,
      command_name,
      state,
      provider_name,
      requester_discord_id,
      guild_id,
      output_channel_id,
      created_at,
      updated_at,
      job_json
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
    ${conflictClause}`,
    [
      job.id,
      job.requestMessageId ?? null,
      job.command,
      job.state,
      job.provider,
      job.requester.id,
      job.guildContext.guildId ?? null,
      job.outputChannelId,
      job.createdAt,
      job.updatedAt,
      JSON.stringify(job),
    ],
  );
}

async function loadJobForUpdate(client: PoolClient, jobId: string): Promise<JobRecord> {
  const result = await client.query<{ job_json: unknown }>(
    "select job_json from jobs where id = $1 for update",
    [jobId],
  );
  const job = deserializeJobRow(result.rows[0]);

  if (!job) {
    throw new Error(`Job ${jobId} was not found.`);
  }

  return job;
}

async function persistJob(client: PoolClient, job: JobRecord): Promise<void> {
  await client.query(
    `update jobs
     set request_message_id = $2,
         command_name = $3,
         state = $4,
         provider_name = $5,
         requester_discord_id = $6,
         guild_id = $7,
         output_channel_id = $8,
         created_at = $9,
         updated_at = $10,
         job_json = $11::jsonb
     where id = $1`,
    [
      job.id,
      job.requestMessageId ?? null,
      job.command,
      job.state,
      job.provider,
      job.requester.id,
      job.guildContext.guildId ?? null,
      job.outputChannelId,
      job.createdAt,
      job.updatedAt,
      JSON.stringify(job),
    ],
  );
}

function deserializeJobRow(row: { job_json: unknown } | undefined): JobRecord | undefined {
  if (!row) {
    return undefined;
  }

  return deserializeJson<JobRecord>(row.job_json);
}

function deserializeJson<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dedupeLegacyJobs(jobs: JobRecord[]): JobRecord[] {
  const deduped = new Map<string, JobRecord>();

  for (const job of jobs) {
    const key =
      job.requestMessageId === undefined
        ? `job:${job.id}`
        : `request:${job.requestMessageId}:${job.command}:${job.provider}:${job.outputChannelId}`;
    const existing = deduped.get(key);

    if (!existing || existing.updatedAt < job.updatedAt) {
      deduped.set(key, job);
    }
  }

  return [...deduped.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}
