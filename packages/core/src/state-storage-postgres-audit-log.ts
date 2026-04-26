import { randomUUID } from "node:crypto";

import { type Pool, type PoolClient } from "pg";

import { type AuditEvent } from "@voidbot/shared";

import { type AuditEventInput, type AuditLog } from "./audit-log";

export class PostgresAuditLog implements AuditLog {
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

    await upsertAuditEvent(this.pool, event);
    return event;
  }
}

export async function upsertAuditEvent(
  client: Pool | PoolClient,
  event: AuditEvent,
): Promise<void> {
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
      event.jobId ?? null,
      event.actorId ?? null,
      event.type,
      event.provider ?? null,
      event.timestamp,
      JSON.stringify(event),
    ],
  );
}
