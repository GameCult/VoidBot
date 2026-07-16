import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { loadConfig } from "@voidbot/config";
import { faceRegistryAsRepoDiscordRegistry, loadFaceIdentityRegistry } from "@voidbot/core";
import { readBifrostGovernanceDigest } from "./bifrost-governance-source.js";
import { readGlobalAgentDoctrine } from "./global-agent-doctrine-source.js";
import { buildInspectionParticipant } from "./inspection-participant-factory.js";
import { coordinatePersonaMemoryTurn } from "./persona-memory-turn-coordinator.js";
import { readPersonaStateObservation } from "./persona-state-source.js";
import { readStoredPersonaHumanPronounGuidance } from "./persona-social-context-source.js";
import { assemblePersonaTurn } from "./persona-turn-assembler.js";
import { fetchChannelSnapshots, fetchRecentDiscordMessages } from "./turn-context-source.js";
import { buildPersonaChannelPlan } from "./turn-routing.js";
import { projectRepoActivityObservation } from "./repo-activity-projector.js";
import { readRepoActivity } from "./repo-activity-source.js";

export async function inspectPersonaTurnPrompt(input: {
  config: ReturnType<typeof loadConfig>;
  identityId: string;
  outPath?: string;
  memorySurfacePath?: string;
  conversationSurfacePath?: string;
}): Promise<{ ok: true; identityId: string; promptLength: number; outPath?: string; memorySurfacePath?: string; conversationSurfacePath?: string }> {
  const registry = faceRegistryAsRepoDiscordRegistry(await loadFaceIdentityRegistry(input.config.repoDiscordIdentitiesPath));
  const identity = registry.identities.find((entry) => entry.id.toLowerCase() === input.identityId.toLowerCase());
  if (!identity) throw new Error(`Unknown repo Face identity: ${input.identityId}`);
  const channelPlan = buildPersonaChannelPlan(identity, input.config.repoFaceHeartbeats.defaultChannelId);
  const channelId = channelPlan.primaryChannelId;
  if (!channelId) throw new Error(`No prompt assembly channel is configured for ${identity.id}.`);
  const [recentMessages, channelSnapshots, bifrostDigest] = await Promise.all([
    fetchRecentDiscordMessages({ botToken: input.config.botToken, channelId, limit: 15, ignoreBotMessages: channelId === input.config.bifrostDiscordChannelId }),
    fetchChannelSnapshots({ botToken: input.config.botToken, channelIds: channelPlan.snapshotChannelIds, primaryChannelId: channelId, limit: 6, bifrostDiscordChannelId: input.config.bifrostDiscordChannelId }),
    input.config.repoFaceBifrostEnabled ? readBifrostGovernanceDigest({ bifrostRoot: input.config.bifrostRoot, repoName: identity.repoName, agentIdentity: identity.id }) : Promise.resolve(undefined),
  ]);
  const roomContext = { recentMessages, channelSnapshots };
  const humanPronounGuidance = await readStoredPersonaHumanPronounGuidance({ config: input.config, ...roomContext });
  const stateObservation = await readPersonaStateObservation({ identity, storageRoot: input.config.storageRoot });
  const memoryContext = await coordinatePersonaMemoryTurn({
    identity, config: input.config, registryIdentities: registry.identities, ...roomContext,
    humanPronounGuidance, stateObservation,
    projectedMemoryOverride: await readOptionalSurface(input.memorySurfacePath),
  });
  const assembly = assemblePersonaTurn({
    identity, channelId, channelPlan, channelSnapshots, recentMessages,
    memorySurface: memoryContext.memorySurface,
    semanticMemoryRecallSurface: memoryContext.semanticMemoryRecallSurface,
    repoActivitySurface: projectRepoActivityObservation(readRepoActivity({ identity, storageRoot: input.config.storageRoot })),
    conversationMemorySurface: await readOptionalSurface(input.conversationSurfacePath),
    humanPronounGuidance, bifrostDigest,
    participant: buildInspectionParticipant(identity, input.config.repoFaceHeartbeats.baseRecoveryMinutes),
    pendingMentions: [], githubActionsEnabled: input.config.repoFaceGithubActionsEnabled,
    globalAgentDoctrine: await readGlobalAgentDoctrine({ codexHome: process.env.CODEX_HOME, userProfile: process.env.USERPROFILE }),
  });
  if (input.outPath) {
    const outPath = resolve(input.outPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, assembly.prompt, "utf8");
  }
  return {
    ok: true, identityId: identity.id, promptLength: assembly.prompt.length,
    outPath: input.outPath ? resolve(input.outPath) : undefined,
    memorySurfacePath: input.memorySurfacePath ? resolve(input.memorySurfacePath) : undefined,
    conversationSurfacePath: input.conversationSurfacePath ? resolve(input.conversationSurfacePath) : undefined,
  };
}

async function readOptionalSurface(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const content = (await readFile(resolve(path), "utf8")).trim();
  return content || undefined;
}
