import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import {
  type Actor,
  type CommandName,
  type ContextBundle,
  type GuildContext,
  type JobRecord,
  type JobState,
  type ProviderName,
} from "@voidbot/shared";

interface JobStore {
  jobs: JobRecord[];
}

export interface JobQueue {
  createJob(input: CreateJobInput): Promise<CreateJobResult>;
  getJob(jobId: string): Promise<JobRecord | undefined>;
  listByStates(states: JobState[]): Promise<JobRecord[]>;
  listRunnableJobs(): Promise<JobRecord[]>;
  claimRunnableJobs(limit?: number): Promise<JobRecord[]>;
  approveRun(jobId: string, actorId: string): Promise<JobRecord>;
  rejectJob(jobId: string, actorId: string, reason?: string): Promise<JobRecord>;
  markRunning(jobId: string): Promise<JobRecord>;
  markAwaitingPostApproval(
    jobId: string,
    artifactPaths: Record<string, string>,
    summary: string,
  ): Promise<JobRecord>;
  markFailed(jobId: string, error: string): Promise<JobRecord>;
  completeJob(jobId: string, actorId: string, finalResponse: string): Promise<JobRecord>;
  completeJobDirect(jobId: string, finalResponse: string): Promise<JobRecord>;
}

export interface CreateJobResult {
  job: JobRecord;
  created: boolean;
}

export interface CreateJobInput {
  command: CommandName;
  provider: ProviderName;
  runApprovalRequired?: boolean;
  postApprovalRequired?: boolean;
  requester: Actor;
  guildContext: GuildContext;
  prompt: string;
  contextBundle: ContextBundle;
  outputChannelId: string;
  requestMessageId?: string;
  initialState?: JobState;
}

export class FileBackedJobQueue implements JobQueue {
  public constructor(private readonly jobsFile: string) {}

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

    return this.mutate((jobs) => {
      const existing =
        input.requestMessageId === undefined
          ? undefined
          : jobs.find(
              (candidate) =>
                candidate.requestMessageId === input.requestMessageId &&
                candidate.command === input.command &&
                candidate.provider === input.provider &&
                candidate.outputChannelId === input.outputChannelId,
            );

      if (existing) {
        return {
          job: cloneJob(existing),
          created: false,
        };
      }

      jobs.push(job);
      return {
        job: cloneJob(job),
        created: true,
      };
    });
  }

  public async getJob(jobId: string): Promise<JobRecord | undefined> {
    const store = await this.readStore();
    return store.jobs.find((job) => job.id === jobId);
  }

  public async listByStates(states: JobState[]): Promise<JobRecord[]> {
    const store = await this.readStore();
    return store.jobs.filter((job) => states.includes(job.state));
  }

  public async listRunnableJobs(): Promise<JobRecord[]> {
    return this.listByStates(["approved"]);
  }

  public async claimRunnableJobs(limit?: number): Promise<JobRecord[]> {
    return this.mutate((jobs) => {
      const now = new Date().toISOString();
      const claimed: JobRecord[] = [];

      for (const job of jobs) {
        if (job.state !== "approved") {
          continue;
        }

        job.state = "running";
        job.updatedAt = now;
        claimed.push(cloneJob(job));

        if (limit !== undefined && claimed.length >= limit) {
          break;
        }
      }

      return claimed;
    });
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

  public async exportJobs(): Promise<JobRecord[]> {
    const store = await this.readStore();
    return store.jobs.map((job) => cloneJob(job));
  }

  private async updateJob(
    jobId: string,
    updater: (job: JobRecord) => void,
  ): Promise<JobRecord> {
    return this.mutate((jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);

      if (!job) {
        throw new Error(`Job ${jobId} was not found.`);
      }

      updater(job);
      return job;
    });
  }

  private async mutate<T>(updater: (jobs: JobRecord[]) => T): Promise<T> {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const result = updater(store.jobs);
      await this.writeStore(store);
      return result;
    });
  }

  private async readStore(): Promise<JobStore> {
    await mkdir(dirname(this.jobsFile), { recursive: true });

    try {
      const raw = await readFile(this.jobsFile, "utf8");
      return JSON.parse(raw) as JobStore;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        return { jobs: [] };
      }

      throw error;
    }
  }

  private async writeStore(store: JobStore): Promise<void> {
    await mkdir(dirname(this.jobsFile), { recursive: true });
    await writeFile(this.jobsFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockFile = `${this.jobsFile}.lock`;
    const deadline = Date.now() + 5000;

    while (true) {
      try {
        const handle = await open(lockFile, "wx");

        try {
          await handle.writeFile(
            JSON.stringify({
              pid: process.pid,
              acquiredAt: new Date().toISOString(),
            }),
            "utf8",
          );
          return await operation();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(lockFile, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code !== "EEXIST") {
          throw error;
        }

        await this.clearStaleLock(lockFile);

        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the job queue lock at ${lockFile}.`);
        }

        await sleep(50);
      }
    }
  }

  private async clearStaleLock(lockFile: string): Promise<void> {
    try {
      const details = await stat(lockFile);
      const ageMs = Date.now() - details.mtimeMs;

      if (ageMs > 30000) {
        await rm(lockFile, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function cloneJob(job: JobRecord): JobRecord {
  return JSON.parse(JSON.stringify(job)) as JobRecord;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
