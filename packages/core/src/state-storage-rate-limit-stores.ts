import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type Pool } from "pg";

import {
  type ConsumeVoidUsageRateLimitInput,
  type VoidUsageRateLimitDecision,
  type VoidUsageRateLimitStore,
} from "./void-usage-rate-limiter";

interface VoidUsageRateLimitStateRow {
  actor_id: string;
  daily_bucket: string;
  daily_count: number;
  last_request_at: string | null;
}

interface VoidUsageRateLimitFileStore {
  version: 1;
  actors: Record<
    string,
    {
      dailyBucket: string;
      dailyCount: number;
      lastRequestAt?: string;
    }
  >;
}

export class PostgresVoidUsageRateLimitStore implements VoidUsageRateLimitStore {
  public constructor(private readonly pool: Pool) {}

  public async consume(
    input: ConsumeVoidUsageRateLimitInput,
  ): Promise<VoidUsageRateLimitDecision> {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const now = new Date(timestamp);
    const bucket = timestamp.slice(0, 10);
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      await client.query(
        `insert into void_usage_rate_limit_state (
          actor_id,
          daily_bucket,
          daily_count,
          state_json
        ) values ($1, $2, 0, '{}'::jsonb)
        on conflict (actor_id) do nothing`,
        [input.actorId, bucket],
      );
      const stateResult = await client.query<VoidUsageRateLimitStateRow>(
        `select actor_id, daily_bucket::text, daily_count, last_request_at::text
         from void_usage_rate_limit_state
         where actor_id = $1
         for update`,
        [input.actorId],
      );
      const state = stateResult.rows[0];

      if (!state) {
        throw new Error(`Missing rate limit state for actor ${input.actorId}.`);
      }

      const dailyCount = state.daily_bucket === bucket ? state.daily_count : 0;

      if (input.dailyLimit !== undefined && dailyCount >= input.dailyLimit) {
        await client.query("commit");
        return {
          allowed: false,
          reason: "daily_limit",
          dailyCount,
          resetsAt: nextUtcDay(timestamp),
          policy: {
            modifier: "default",
            matchedSubjects: [],
          },
        };
      }

      if (input.cooldownSeconds !== undefined && state.last_request_at) {
        const lastRequestAt = new Date(state.last_request_at);
        const elapsedSeconds = Math.floor((now.getTime() - lastRequestAt.getTime()) / 1000);
        const retryAfterSeconds = input.cooldownSeconds - elapsedSeconds;

        if (retryAfterSeconds > 0) {
          await client.query("commit");
          return {
            allowed: false,
            reason: "cooldown",
            dailyCount,
            retryAfterSeconds,
            resetsAt: now.toISOString(),
            policy: {
              modifier: "default",
              matchedSubjects: [],
            },
          };
        }
      }

      const nextDailyCount = dailyCount + 1;
      await client.query(
        `update void_usage_rate_limit_state
         set daily_bucket = $2,
             daily_count = $3,
             last_request_at = $4,
             updated_at = now(),
             state_json = $5::jsonb
         where actor_id = $1`,
        [
          input.actorId,
          bucket,
          nextDailyCount,
          timestamp,
          JSON.stringify({
            lastCommand: input.command,
            lastProvider: input.provider,
            guildId: input.guildId ?? null,
            channelId: input.channelId,
          }),
        ],
      );
      await client.query("commit");

      return {
        allowed: true,
        dailyCount: nextDailyCount,
        resetsAt:
          input.dailyLimit === undefined ? undefined : nextUtcDay(timestamp),
        policy: {
          modifier: "default",
          matchedSubjects: [],
        },
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class FileBackedVoidUsageRateLimitStore implements VoidUsageRateLimitStore {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async consume(
    input: ConsumeVoidUsageRateLimitInput,
  ): Promise<VoidUsageRateLimitDecision> {
    return this.serialize(async () => {
      const timestamp = input.timestamp ?? new Date().toISOString();
      const now = new Date(timestamp);
      const bucket = timestamp.slice(0, 10);
      const store = await this.readUnlocked();
      const existing = store.actors[input.actorId] ?? {
        dailyBucket: bucket,
        dailyCount: 0,
      };
      const dailyCount = existing.dailyBucket === bucket ? existing.dailyCount : 0;

      if (input.dailyLimit !== undefined && dailyCount >= input.dailyLimit) {
        return {
          allowed: false,
          reason: "daily_limit",
          dailyCount,
          resetsAt: nextUtcDay(timestamp),
          policy: {
            modifier: "default",
            matchedSubjects: [],
          },
        };
      }

      if (input.cooldownSeconds !== undefined && existing.lastRequestAt) {
        const lastRequestAt = new Date(existing.lastRequestAt);
        const elapsedSeconds = Math.floor((now.getTime() - lastRequestAt.getTime()) / 1000);
        const retryAfterSeconds = input.cooldownSeconds - elapsedSeconds;

        if (retryAfterSeconds > 0) {
          return {
            allowed: false,
            reason: "cooldown",
            dailyCount,
            retryAfterSeconds,
            resetsAt: now.toISOString(),
            policy: {
              modifier: "default",
              matchedSubjects: [],
            },
          };
        }
      }

      const nextDailyCount = dailyCount + 1;
      store.actors[input.actorId] = {
        dailyBucket: bucket,
        dailyCount: nextDailyCount,
        lastRequestAt: timestamp,
      };
      await this.writeUnlocked(store);

      return {
        allowed: true,
        dailyCount: nextDailyCount,
        resetsAt:
          input.dailyLimit === undefined ? undefined : nextUtcDay(timestamp),
        policy: {
          modifier: "default",
          matchedSubjects: [],
        },
      };
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writeChain.then(operation, operation);
    this.writeChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async readUnlocked(): Promise<VoidUsageRateLimitFileStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as VoidUsageRateLimitFileStore;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        return {
          version: 1,
          actors: {},
        };
      }

      throw error;
    }
  }

  private async writeUnlocked(store: VoidUsageRateLimitFileStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}

function nextUtcDay(timestamp: string): string {
  const date = new Date(timestamp);
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.toISOString();
}
