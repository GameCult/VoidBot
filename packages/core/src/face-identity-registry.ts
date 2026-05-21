import { buildEpiphanyIdentityRegistry, faceToRepoDiscordIdentity } from "./epiphany-identities";
import {
  loadRepoDiscordIdentityRegistry,
  type RepoDiscordIdentity,
  type RepoDiscordIdentityRegistry,
} from "./repo-discord-identities";
import type { EpiphanyIdentity, ResolvedFaceIdentity } from "./epiphany-identities";

export interface FaceIdentityRegistry {
  epiphanies: EpiphanyIdentity[];
  faces: ResolvedFaceIdentity[];
  repoIdentities: RepoDiscordIdentity[];
  legacyRepoRegistry: RepoDiscordIdentityRegistry;
}

export async function loadFaceIdentityRegistry(path: string): Promise<FaceIdentityRegistry> {
  const legacyRepoRegistry = await loadRepoDiscordIdentityRegistry(path);
  const epiphanyRegistry = buildEpiphanyIdentityRegistry(legacyRepoRegistry);
  return {
    epiphanies: epiphanyRegistry.epiphanies,
    faces: epiphanyRegistry.faces,
    repoIdentities: epiphanyRegistry.faces.map(faceToRepoDiscordIdentity),
    legacyRepoRegistry,
  };
}

export function faceRegistryAsRepoDiscordRegistry(
  registry: FaceIdentityRegistry,
): RepoDiscordIdentityRegistry {
  return {
    identities: registry.repoIdentities,
    epiphanies: registry.epiphanies,
  };
}
