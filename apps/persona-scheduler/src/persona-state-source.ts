import { extname, resolve } from "node:path";
import { access } from "node:fs/promises";

import {
  inspectPersonaStateSurfaceKind,
  loadGamecultPersonaState,
  loadVoidSelfStateTypedDocuments,
  projectRepoFaceSleepCycleForNow,
  resolveRepoFaceStatePath,
  type RepoDiscordIdentity,
  type RepoFaceRestSnapshot,
  type GamecultPersonaState,
  type VoidSelfStateTypedProjection,
} from "@voidbot/core";

export type PersonaStateObservation =
  | { status: "ok"; stateKind: "void_self_state"; identityId: string; statePath: string; typedState: VoidSelfStateTypedProjection; rest?: RepoFaceRestSnapshot }
  | { status: "ok"; stateKind: "gamecult_persona"; identityId: string; statePath: string; personaState: GamecultPersonaState }
  | { status: "unconfigured" | "unsupported" | "missing"; identityId: string; statePath?: string; reason: string };

export async function readPersonaStateObservation(input: {
  identity: RepoDiscordIdentity;
  storageRoot: string;
  now?: Date;
}): Promise<PersonaStateObservation> {
  const statePath = resolvePersonaStatePath(input.identity, input.storageRoot);
  if (!statePath) return { status: "unconfigured", identityId: input.identity.id, reason: "No typed Persona state path is registered." };
  if (extname(statePath).toLowerCase() !== ".cc") {
    return { status: "unsupported", identityId: input.identity.id, statePath, reason: "The registered Persona state is not a CultCache .cc surface." };
  }
  try {
    await access(statePath);
    const stateKind = await inspectPersonaStateSurfaceKind(statePath);
    if (stateKind === "gamecult_persona") {
      return { status: "ok", stateKind, identityId: input.identity.id, statePath, personaState: await loadGamecultPersonaState(statePath) };
    }
    if (stateKind !== "void_self_state") {
      return { status: "unsupported", identityId: input.identity.id, statePath, reason: "The CultCache surface contains no supported Persona state document." };
    }
    const typedState = await loadVoidSelfStateTypedDocuments({
      canonicalPath: statePath,
      identity: { agentId: input.identity.id, publicName: input.identity.displayName, publicDescription: input.identity.description },
    });
    const projected = input.identity.identityKind === "native_persona"
      ? undefined
      : projectRepoFaceSleepCycleForNow(typedState.scheduledRuntime.sleepCycle, input.identity.id, input.now ?? new Date());
    return {
      status: "ok",
      stateKind,
      identityId: input.identity.id,
      statePath,
      typedState,
      rest: projected && { isNapping: projected.isNapping, napEndsAt: projected.napEndsAt, nextNapStartsAt: projected.nextNapStartsAt },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", identityId: input.identity.id, statePath, reason: "The registered Persona state surface does not exist." };
    }
    throw error;
  }
}

export async function readPersonaStateObservations(input: {
  identities: RepoDiscordIdentity[];
  storageRoot: string;
  now?: Date;
}): Promise<Map<string, PersonaStateObservation>> {
  const observations = await Promise.all(input.identities.map((identity) => readPersonaStateObservation({ identity, storageRoot: input.storageRoot, now: input.now })));
  return new Map(observations.map((observation) => [observation.identityId, observation]));
}

function resolvePersonaStatePath(identity: RepoDiscordIdentity, storageRoot: string): string | undefined {
  if (identity.identityKind === "native_persona") return identity.personaStatePath ? resolve(identity.personaStatePath) : undefined;
  return resolveRepoFaceStatePath(identity, storageRoot);
}
