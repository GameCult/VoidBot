import { type Pool, type PoolClient } from "pg";

import {
  type InteractionMemoryEvent,
  type InteractionMemoryProfile,
  type PronounEvidence,
  type StoredTranscriptParticipantRead,
} from "@voidbot/shared";

import {
  buildInteractionMemoryEvent,
  mergePronounEvidenceIntoIdentityState,
  mergeSocialReadEvidenceIntoIdentityState,
  normalizeInteractionIdentityState,
  type RecordInteractionInput,
  shouldPersistInteractionEvent,
  summarizeInteractionProfile,
} from "./interaction-memory-logic";
import { type InteractionIdentityState } from "./interaction-memory-profile";
import { type InteractionMemoryBank } from "./interaction-memory";

export class PostgresInteractionMemoryBank implements InteractionMemoryBank {
  public constructor(private readonly pool: Pool) {}

  public async getProfile(
    actorId: string,
  ): Promise<InteractionMemoryProfile | undefined> {
    const identityRecord = await this.getIdentityRecord(actorId);
    const identityState = identityRecord?.state;
    const events = await this.listActorEvents(actorId);

    if (events.length === 0) {
      if (!identityState) {
        return undefined;
      }

      return summarizeInteractionProfile(
        actorId,
        identityRecord?.actorName || actorId,
        [],
        identityState,
      );
    }

    const profile = summarizeInteractionProfile(
      actorId,
      events[events.length - 1].actorName,
      events,
      identityState,
    );

    return (
      profile.totalInteractions > 0 ||
      profile.pronounEvidence.length > 0 ||
      profile.socialReadEvidence.length > 0
    )
      ? profile
      : undefined;
  }

  public async recordInteraction(
    input: RecordInteractionInput,
  ): Promise<InteractionMemoryProfile> {
    const identityRecord = await this.getIdentityRecord(input.actorId);
    const identityState = identityRecord?.state;
    const existingEvents = await this.listActorEvents(input.actorId);
    const priorEvents = existingEvents.filter((event) => event.id !== input.eventId);
    const event = buildInteractionMemoryEvent(input, priorEvents);

    if (!shouldPersistInteractionEvent(event)) {
      if (input.eventId) {
        await this.pool.query("delete from interaction_memory_events where id = $1", [input.eventId]);
      }

      return summarizeInteractionProfile(
        input.actorId,
        input.actorName,
        priorEvents,
        identityState,
      );
    }

    await upsertInteractionMemoryEvent(this.pool, event);

    return summarizeInteractionProfile(
      input.actorId,
      input.actorName,
      [...priorEvents, event],
      identityState,
    );
  }

  public async recordPronounEvidence(
    actorId: string,
    actorName: string,
    evidence: PronounEvidence[],
  ): Promise<InteractionMemoryProfile | undefined> {
    if (evidence.length === 0) {
      return this.getProfile(actorId);
    }

    const existingEvents = await this.listActorEvents(actorId);

    const mergedIdentityState = mergePronounEvidenceIntoIdentityState(
      (await this.getIdentityRecord(actorId))?.state,
      evidence,
    );

    await upsertInteractionIdentityState(
      this.pool,
      actorId,
      actorName,
      mergedIdentityState,
    );

    return summarizeInteractionProfile(actorId, actorName, existingEvents, mergedIdentityState);
  }

  public async recordSocialReadEvidence(
    evidence: StoredTranscriptParticipantRead[],
  ): Promise<void> {
    if (evidence.length === 0) {
      return;
    }

    for (const entry of evidence) {
      const mergedIdentityState = mergeSocialReadEvidenceIntoIdentityState(
        (await this.getIdentityRecord(entry.actorId))?.state,
        [entry],
      );

      await upsertInteractionIdentityState(
        this.pool,
        entry.actorId,
        entry.actorName,
        mergedIdentityState,
      );
    }
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

  private async getIdentityRecord(
    actorId: string,
  ): Promise<{ actorName: string; state: InteractionIdentityState } | undefined> {
    const result = await this.pool.query<{ actor_name: string; profile_json: unknown }>(
      `select actor_name, profile_json
       from interaction_identity_profiles
       where actor_id = $1`,
      [actorId],
    );

    const row = result.rows[0];

    if (!row) {
      return undefined;
    }

    return {
      actorName: row.actor_name,
      state: normalizeInteractionIdentityState(
        deserializeJson<InteractionIdentityState>(row.profile_json),
      ),
    };
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

export async function upsertInteractionIdentityState(
  client: Pool | PoolClient,
  actorId: string,
  actorName: string,
  state: InteractionIdentityState,
): Promise<void> {
  await client.query(
    `insert into interaction_identity_profiles (
      actor_id,
      actor_name,
      pronoun_policy,
      resolved_pronoun_set,
      pronoun_confidence,
      profile_json,
      updated_at
    ) values ($1, $2, $3, $4, $5, $6::jsonb, now())
    on conflict (actor_id) do update
    set actor_name = excluded.actor_name,
        pronoun_policy = excluded.pronoun_policy,
        resolved_pronoun_set = excluded.resolved_pronoun_set,
        pronoun_confidence = excluded.pronoun_confidence,
        profile_json = excluded.profile_json,
        updated_at = now()`,
    [
      actorId,
      actorName,
      state.pronounPolicy,
      state.resolvedPronounSet ?? null,
      state.pronounConfidence ?? null,
      JSON.stringify(state),
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
