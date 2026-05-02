import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type InteractionMemoryProfile,
  type PronounEvidence,
} from "@voidbot/shared";

import {
  buildInteractionMemoryEvent,
  emptyInteractionProfile,
  mergePronounEvidenceIntoIdentityState,
  MAX_RECENT_INTERACTION_EVENTS,
  normalizeInteractionIdentityState,
  normalizeInteractionEvent,
  type RecordInteractionInput,
  shouldPersistInteractionEvent,
  summarizeInteractionProfile,
} from "./interaction-memory-logic";

interface InteractionMemoryStore {
  version: 1;
  profiles: InteractionMemoryProfile[];
}

export interface InteractionMemoryBank {
  getProfile(actorId: string): Promise<InteractionMemoryProfile | undefined>;
  recordInteraction(input: RecordInteractionInput): Promise<InteractionMemoryProfile>;
  recordPronounEvidence(
    actorId: string,
    actorName: string,
    evidence: PronounEvidence[],
  ): Promise<InteractionMemoryProfile | undefined>;
}

export type { RecordInteractionInput } from "./interaction-memory-logic";

export class FileInteractionMemoryBank implements InteractionMemoryBank {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async getProfile(
    actorId: string,
  ): Promise<InteractionMemoryProfile | undefined> {
    await this.writeChain;
    const store = await this.readUnlocked();
    const profile = store.profiles.find((candidate) => candidate.actorId === actorId);
    return profile && profile.totalInteractions > 0 ? structuredClone(profile) : undefined;
  }

  public async recordInteraction(
    input: RecordInteractionInput,
  ): Promise<InteractionMemoryProfile> {
    return this.serialize(async () => {
      const store = await this.readUnlocked();
      const existingProfileIndex = store.profiles.findIndex(
        (candidate) => candidate.actorId === input.actorId,
      );
      const existingProfile =
        existingProfileIndex === -1
          ? emptyInteractionProfile(input.actorId, input.actorName)
          : store.profiles[existingProfileIndex];
      const priorEvents = existingProfile.recentEvents.filter(
        (event) => event.id !== input.eventId,
      );
      const nextEvent = buildInteractionMemoryEvent(input, priorEvents);
      const nextProfile = shouldPersistInteractionEvent(nextEvent)
        ? summarizeInteractionProfile(
            input.actorId,
            input.actorName,
            [...priorEvents, nextEvent],
            existingProfile,
          )
        : summarizeInteractionProfile(
            input.actorId,
            input.actorName,
            priorEvents,
            existingProfile,
          );

      if (nextProfile.totalInteractions === 0) {
        if (existingProfileIndex !== -1) {
          store.profiles.splice(existingProfileIndex, 1);
        }
      } else if (existingProfileIndex === -1) {
        store.profiles.push(nextProfile);
      } else {
        store.profiles[existingProfileIndex] = nextProfile;
      }

      await this.writeUnlocked(store);
      return structuredClone(nextProfile);
    });
  }

  public async recordPronounEvidence(
    actorId: string,
    actorName: string,
    evidence: PronounEvidence[],
  ): Promise<InteractionMemoryProfile | undefined> {
    if (evidence.length === 0) {
      return this.getProfile(actorId);
    }

    return this.serialize(async () => {
      const store = await this.readUnlocked();
      const existingProfileIndex = store.profiles.findIndex(
        (candidate) => candidate.actorId === actorId,
      );

      if (existingProfileIndex === -1) {
        return undefined;
      }

      const existingProfile = store.profiles[existingProfileIndex]!;
      const mergedIdentityState = mergePronounEvidenceIntoIdentityState(
        existingProfile,
        evidence,
      );
      const nextProfile = summarizeInteractionProfile(
        actorId,
        actorName,
        existingProfile.recentEvents,
        mergedIdentityState,
      );
      store.profiles[existingProfileIndex] = nextProfile;
      await this.writeUnlocked(store);
      return structuredClone(nextProfile);
    });
  }

  public async listProfiles(): Promise<InteractionMemoryProfile[]> {
    await this.writeChain;
    const store = await this.readUnlocked();
    return store.profiles.map((profile) => structuredClone(profile));
  }

  private async serialize<R>(operation: () => Promise<R>): Promise<R> {
    const pending = this.writeChain.then(operation, operation);
    this.writeChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async readUnlocked(): Promise<InteractionMemoryStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeStore(
        JSON.parse(stripLeadingBom(raw)) as InteractionMemoryStore,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        return {
          version: 1,
          profiles: [],
        };
      }

      throw error;
    }
  }

  private async writeUnlocked(store: InteractionMemoryStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(store)}\n`, "utf8");
  }
}

function normalizeStore(store: InteractionMemoryStore): InteractionMemoryStore {
  return {
    version: 1,
    profiles: (store.profiles ?? []).map((profile) =>
      summarizeInteractionProfile(
        profile.actorId,
        profile.actorName,
        (profile.recentEvents ?? [])
          .map((event) => normalizeInteractionEvent(event))
          .slice(-MAX_RECENT_INTERACTION_EVENTS),
        normalizeInteractionIdentityState(profile),
      ))
      .filter((profile) => profile.totalInteractions > 0),
  };
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
