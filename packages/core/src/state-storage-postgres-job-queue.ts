import { randomUUID } from "node:crypto";

import { type Pool, type PoolClient } from "pg";

import { type JobRecord } from "@voidbot/shared";

import {
  type CreateJobInput,
  type CreateJobResult,
  type JobQueue,
} from "./job-queue";

export class PostgresJobQueue implements JobQueue {
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

export async function upsertJob(
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

export function dedupeLegacyJobs(jobs: JobRecord[]): JobRecord[] {
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

async function insertJob(pool: Pool, job: JobRecord): Promise<void> {
  await upsertJob(pool, job, false);
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
