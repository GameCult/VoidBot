import { buildEpiphanyIdentityRegistry, personaToRepoDiscordIdentity } from "./epiphany-identities";
import {
  loadRepoDiscordIdentityRegistry,
  type RepoDiscordIdentity,
  type RepoDiscordIdentityRegistry,
} from "./repo-discord-identities";
import type { EpiphanyIdentity, ResolvedPersonaIdentity } from "./epiphany-identities";

export interface PersonaIdentityRegistry {
  epiphanies: EpiphanyIdentity[];
  personas: ResolvedPersonaIdentity[];
  repoIdentities: RepoDiscordIdentity[];
  legacyRepoRegistry: RepoDiscordIdentityRegistry;
}

export async function loadPersonaIdentityRegistry(path: string): Promise<PersonaIdentityRegistry> {
  const legacyRepoRegistry = await loadRepoDiscordIdentityRegistry(path);
  const epiphanyRegistry = buildEpiphanyIdentityRegistry(legacyRepoRegistry);
  return {
    epiphanies: epiphanyRegistry.epiphanies,
    personas: epiphanyRegistry.personas,
    repoIdentities: epiphanyRegistry.personas.map(personaToRepoDiscordIdentity),
    legacyRepoRegistry,
  };
}

export function personaRegistryAsRepoDiscordRegistry(
  registry: PersonaIdentityRegistry,
): RepoDiscordIdentityRegistry {
  return {
    identities: registry.repoIdentities,
    epiphanies: registry.epiphanies,
  };
}
