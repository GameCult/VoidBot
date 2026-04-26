import { type Pool, type PoolClient } from "pg";

import {
  type InteractionMemoryEvent,
  type InteractionMemoryProfile,
} from "@voidbot/shared";

import {
  buildInteractionMemoryEvent,
  type RecordInteractionInput,
  shouldPersistInteractionEvent,
  summarizeInteractionProfile,
} from "./interaction-memory-logic";
import { type InteractionMemoryBank } from "./interaction-memory";

export class PostgresInteractionMemoryBank implements InteractionMemoryBank {
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

    await upsertInteractionMemoryEvent(this.pool, event);

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

export async function upsertInteractionMemoryEvent(
  client: Pool | PoolClient,
  event: InteractionMemoryEvent,
): Promise<void> {
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

function deserializeJson<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}
