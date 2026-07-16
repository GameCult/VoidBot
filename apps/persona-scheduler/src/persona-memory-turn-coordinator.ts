import type { loadConfig } from "@voidbot/config";
import { getRepoFaceSourceRepoName, type RepoDiscordIdentity } from "@voidbot/core";
import { createTextEmbedder, createVectorStores, RetrievalService } from "@voidbot/rag";
import type { SourceMessage } from "@voidbot/shared";

import { readPersonaCuriosityEvidence } from "./persona-curiosity-context-source.js";
import { projectPersonaCuriosityContext } from "./persona-curiosity-projector.js";
import { readPersonaMemoryRecall } from "./persona-memory-context-source.js";
import { projectPersonaMemorySurface } from "./persona-memory-projector.js";
import { projectPersonaMemoryRecall } from "./persona-memory-recall-projector.js";
import type { PersonaHumanPronounGuidance } from "./persona-social-context-projector.js";
import { projectPersonaStatePacket } from "./persona-state-packet-projector.js";
import { readPersonaStateObservation, type PersonaStateObservation } from "./persona-state-source.js";
import { projectGamecultPersonaState } from "./persona-standard-state-projector.js";
import { projectPersonaText } from "./persona-text-projection-actuator.js";
import { renderPersonaIdentityDoctrine } from "./persona-turn-prompt-projector.js";
import type { ChannelSnapshot } from "./turn-context-source.js";

export interface PersonaMemoryTurnContext {
  stateObservation?: PersonaStateObservation;
  memorySurface: string;
  semanticMemoryRecallSurface: string;
}

interface PersonaMemoryTurnDependencies {
  readState?: typeof readPersonaStateObservation;
  readRecall?: typeof readPersonaMemoryRecall;
  projectMemory?: typeof projectPersonaMemorySurface;
  projectCuriosityFacts?: typeof projectCuriosity;
}

export async function coordinatePersonaMemoryTurn(input: {
  identity: RepoDiscordIdentity;
  config: ReturnType<typeof loadConfig>;
  registryIdentities?: RepoDiscordIdentity[];
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
  humanPronounGuidance?: PersonaHumanPronounGuidance[];
  stateObservation?: PersonaStateObservation;
  projectedMemoryOverride?: string;
  observedAt?: Date;
}, dependencies: PersonaMemoryTurnDependencies = {}): Promise<PersonaMemoryTurnContext> {
  const observation = input.stateObservation ?? await (dependencies.readState ?? readPersonaStateObservation)({ identity: input.identity, storageRoot: input.config.storageRoot });
  const observedAt = input.observedAt ?? new Date();
  if (input.identity.identityKind === "native_persona" && !input.identity.personaStatePath) {
    const memorySurface = `${input.identity.displayName} is a native VoidBot Persona, not a repo Face.\nNo Persona state path is registered. Treat that as a Body fault and keep the public turn modest.`;
    return { stateObservation: observation, memorySurface, semanticMemoryRecallSurface: projectPersonaMemoryRecall({ status: "unavailable", reason: "No Persona state path is registered." }) };
  }
  if (observation.status !== "ok") throw new Error(`${input.identity.displayName} Persona state ${observation.status}: ${observation.reason}`);

  let memorySurface: string;
  if (input.projectedMemoryOverride) memorySurface = input.projectedMemoryOverride;
  else if (observation.stateKind === "gamecult_persona") memorySurface = projectGamecultPersonaState(input.identity, observation.personaState);
  else if (observation.stateKind === "persona_projection_import") memorySurface = projectGamecultPersonaState(input.identity, observation.projectionImport.payload);
  else {
    const roomContext = { recentMessages: input.recentMessages, channelSnapshots: input.channelSnapshots };
    const curiosityGraphFacts = input.identity.identityKind !== "native_persona"
      ? await (dependencies.projectCuriosityFacts ?? projectCuriosity)({ identity: input.identity, config: input.config, state: observation.typedState, ...roomContext })
      : undefined;
    const statePacket = projectPersonaStatePacket({
      identity: input.identity,
      state: observation.typedState,
      registryIdentities: input.registryIdentities ?? [],
      roomContext,
      humanPronounGuidance: input.humanPronounGuidance,
      curiosityGraphFacts,
      observedAt,
    });
    memorySurface = await (dependencies.projectMemory ?? projectPersonaMemorySurface)({
      identityId: input.identity.id,
      characterIdentity: renderPersonaIdentityDoctrine(input.identity),
      statePacket,
      modelProjectionEnabled: input.config.repoFaceHeartbeats.stateProjectorEnabled,
      projectText: input.config.repoFaceHeartbeats.stateProjectorEnabled ? (prompt) => projectPersonaText({
        prompt,
        config: input.config,
        command: "repo-face-state-projector",
        jobId: `state-projector:${input.identity.id}:${observedAt.getTime()}`,
        timeoutMs: 180_000,
      }) : undefined,
    });
  }
  const recall = await (dependencies.readRecall ?? readPersonaMemoryRecall)({
    identity: input.identity,
    config: input.config,
    state: observation,
    projectedMemory: memorySurface,
    recentMessages: input.recentMessages,
    channelSnapshots: input.channelSnapshots,
    observedAt,
  });
  return { stateObservation: observation, memorySurface, semanticMemoryRecallSurface: projectPersonaMemoryRecall(recall) };
}

async function projectCuriosity(input: {
  identity: RepoDiscordIdentity;
  config: ReturnType<typeof loadConfig>;
  state: Extract<PersonaStateObservation, { status: "ok"; stateKind: "void_self_state" }>["typedState"];
  recentMessages: SourceMessage[];
  channelSnapshots: ChannelSnapshot[];
}): Promise<string | undefined> {
  const observation = await readPersonaCuriosityEvidence({
    identity: input.identity,
    state: input.state,
    recentMessages: input.recentMessages,
    channelSnapshots: input.channelSnapshots,
    sourceRepoName: getRepoFaceSourceRepoName(input.identity),
    retrieval: () => {
      const retrieval = createCuriosityRetrieval(input.config);
      return {
        searchHistory: (query, limit) => retrieval.searchHistory(query, limit),
        searchSources: (query, limit, repoName) => retrieval.searchRepositorySources(query, limit, repoName ? { repoName } : undefined),
      };
    },
  });
  const backendDescription = input.config.vectorStore.kind === "qdrant"
    ? `Qdrant collections ${input.config.qdrant.historyCollection} + ${input.config.qdrant.sourceCollection}`
    : "local vector shards";
  return projectPersonaCuriosityContext({ ...input, observation, backendDescription });
}

function createCuriosityRetrieval(config: ReturnType<typeof loadConfig>): RetrievalService {
  const historyEmbedder = createTextEmbedder({ backend: config.ragEmbeddingBackend, hashDimensions: config.ragEmbeddingDimensions, ollamaBaseUrl: config.ragOllamaBaseUrl, ollamaModel: config.ragOllamaModel, ollamaTimeoutMs: config.ragOllamaTimeoutMs, queryInstruction: config.ragQueryInstruction });
  const sourceEmbedder = createTextEmbedder({ backend: config.ragEmbeddingBackend, hashDimensions: config.ragEmbeddingDimensions, ollamaBaseUrl: config.ragOllamaBaseUrl, ollamaModel: config.ragOllamaModel, ollamaTimeoutMs: config.ragOllamaTimeoutMs, queryInstruction: config.ragSourceQueryInstruction || config.ragQueryInstruction });
  const stores = createVectorStores({ kind: config.vectorStore.kind, historyPath: config.vectorStore.path, personaMemoryPath: config.vectorStore.personaMemoryPath, sourceRoot: config.sourceVectorStoreRoot, qdrant: config.qdrant, historyEmbedder, sourceEmbedder, personaMemoryEmbedder: historyEmbedder });
  return new RetrievalService(stores.history, stores.source, stores.personaMemory);
}
