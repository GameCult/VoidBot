#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultStorageRoot = resolve(repoRoot, ".voidbot");
const defaultStatusDir = resolve(defaultStorageRoot, "status");
const defaultSnapshotPath = resolve(defaultStatusDir, "swarm-state.json");
const defaultDashboardPath = resolve(defaultStatusDir, "swarm-dashboard.html");
const defaultCultMeshStorePath = resolve(defaultStatusDir, "cultmesh", "voidbot-swarm-state.cc");
const providerId = "voidbot.swarm";
const verseId = "voidbot.local";
const snapshotDocumentType = "voidbot.swarm_state_snapshot";
const snapshotSchemaId = "voidbot.swarm_state_snapshot.v1";
const providerAdvertisementDocumentType = "gamecult.eve.provider_advertisement";
const providerAdvertisementSchemaId = "gamecult.eve.provider_advertisement.v1";
const eveBindingDocumentType = "gamecult.eve.interface_binding";
const eveBindingSchemaId = "gamecult.eve.interface_binding.v1";
const surfaceDocumentType = "gamecult.eve.surface_state";
const surfaceSchemaId = "gamecult.eve.surface_state.v1";

const args = parseArgs(process.argv.slice(2));

const env = await readDotEnv(resolve(repoRoot, ".env"));
const storageRoot = resolveConfigPath(env.STORAGE_ROOT, defaultStorageRoot);
const statusDir = resolve(storageRoot, "status");
const heartbeatStatePath = resolveConfigPath(
  env.REPO_FACE_HEARTBEAT_STATE_PATH,
  resolve(statusDir, "repo-face-heartbeats.json"),
);
const orchestratorPath = resolve(statusDir, "gamecult-orchestrator.json");
const pausePath = resolve(repoRoot, "state", "agent-swarm-paused.json");
const snapshotPath = resolveConfigPath(args.snapshot, defaultSnapshotPath.replace(defaultStatusDir, statusDir));
const dashboardPath = resolveConfigPath(args.out, defaultDashboardPath.replace(defaultStatusDir, statusDir));
const cultMeshStorePath = resolveConfigPath(
  args.cultmeshStore,
  defaultCultMeshStorePath.replace(defaultStatusDir, statusDir),
);
const requireCultMeshAdvertisement = !isFlagEnabled(args.public) && !isFlagEnabled(args.allowUnmeshed);

const renderResult = await render();

if (args.open) {
  console.log(pathToFileURL(renderResult.dashboardPath).href);
}

if (args.serve) {
  throw new Error("VoidBot swarm is exposed through CultMesh/Eve, not a web server. Use npm run swarm:render-dashboard to publish the CultMesh surface.");
} else {
  console.log(`Swarm dashboard HTML: ${renderResult.dashboardPath}`);
  console.log(`Swarm snapshot JSON: ${renderResult.snapshotPath}`);
  console.log(`CultMesh snapshot store: ${renderResult.cultMeshStorePath}`);
}

async function render() {
  let snapshot = await buildSnapshot();
  if (isFlagEnabled(args.public)) {
    snapshot = redactSnapshot(snapshot);
  }
  await mkdir(dirname(snapshotPath), { recursive: true });
  await mkdir(dirname(dashboardPath), { recursive: true });

  const pendingEveState = buildEveProviderState(snapshot);
  const cultMeshWrite = await writeCultMeshPublication(snapshot, pendingEveState, cultMeshStorePath);
  if (requireCultMeshAdvertisement && cultMeshWrite.writeStatus !== "ok") {
    throw new Error(`VoidBot swarm CultMesh advertisement failed: ${cultMeshWrite.writeError ?? cultMeshWrite.writeStatus}`);
  }
  const finalSnapshot = {
    ...snapshot,
    cultMesh: {
      ...snapshot.cultMesh,
      ...cultMeshWrite,
    },
  };
  const finalEveState = buildEveProviderState(finalSnapshot);

  await writeFile(snapshotPath, `${JSON.stringify(finalSnapshot, null, 2)}\n`, "utf8");
  await writeFile(dashboardPath, renderHtml(finalSnapshot), "utf8");

  return {
    dashboardPath,
    snapshotPath,
    cultMeshStorePath,
  };
}

async function buildSnapshot() {
  const now = new Date();
  const heartbeat = await readJsonFile(heartbeatStatePath);
  const orchestrator = await readJsonFile(orchestratorPath);
  const pause = await readJsonFile(pausePath);
  const identityMetadata = await readIdentityMetadata(env.REPO_DISCORD_IDENTITIES_PATH);
  const heartbeatMtime = await getMtime(heartbeatStatePath);
  const orchestratorMtime = await getMtime(orchestratorPath);
  const paused = pause.ok ? pause.value?.paused !== false : false;
  const pauseReason = pause.ok && typeof pause.value?.reason === "string" ? pause.value.reason : undefined;
  const participants = Array.isArray(heartbeat.value?.participants) ? heartbeat.value.participants : [];
  const pendingMentions = Array.isArray(heartbeat.value?.pendingMentions) ? heartbeat.value.pendingMentions : [];
  const initiativeClock = numberOrNull(heartbeat.value?.initiativeClock);
  const participantSnapshots = participants.map((participant) =>
    projectParticipant(participant, pendingMentions, initiativeClock, identityMetadata),
  );
  const faceStates = await readFaceStates(identityMetadata);
  for (const participant of participantSnapshots) {
    participant.faceState = faceStates.get(participant.identityId.toLowerCase()) ?? {
      readable: false,
      path: participant.faceStatePath,
      error: participant.faceStatePath ? "State file was not readable." : "No Face state path registered.",
      tree: [],
    };
    participant.restState = participant.faceState.restState ?? null;
  }
  const activeTurns = participantSnapshots.filter((participant) => participant.activeJobId);
  const readyNow = participantSnapshots.filter((participant) =>
    participant.status === "active" &&
    !participant.activeJobId &&
    participant.restState?.isNapping !== true &&
    typeof participant.nextTurnInMinutes === "number" &&
    participant.nextTurnInMinutes <= 0,
  );
  const nextParticipant = [...participantSnapshots]
    .filter((participant) => typeof participant.nextTurnInMinutes === "number")
    .sort((left, right) => left.nextTurnInMinutes - right.nextTurnInMinutes)[0];
  const organs = projectOrgans(orchestrator.value);
  const recentEvents = Array.isArray(heartbeat.value?.history)
    ? heartbeat.value.history.slice(-24).reverse().map(projectHistoryEvent)
    : [];
  const controls = projectControls(heartbeat.value?.controls);
  const upcomingTurns = buildUpcomingTurns(participantSnapshots);
  const lastShuffle = findLastShuffleEvent(recentEvents);

  return {
    schemaVersion: snapshotSchemaId,
    generatedAt: now.toISOString(),
    title: "VoidBot Swarm State",
    sources: {
      heartbeatStatePath,
      heartbeatStateUpdatedAt: heartbeatMtime,
      heartbeatStateReadable: heartbeat.ok,
      heartbeatStateError: heartbeat.ok ? undefined : heartbeat.error,
      orchestratorPath,
      orchestratorUpdatedAt: orchestratorMtime,
      orchestratorReadable: orchestrator.ok,
      orchestratorError: orchestrator.ok ? undefined : orchestrator.error,
      pausePath,
      pauseReadable: pause.ok,
      pauseError: pause.ok ? undefined : pause.error,
    },
    cultMesh: {
      documentType: snapshotDocumentType,
      schemaId: snapshotSchemaId,
      documentKey: "voidbot-swarm",
      storePath: cultMeshStorePath,
      writeStatus: "pending",
      providerId,
      verseId,
      eveDeckEndpoint: primaryCultMeshEndpoint(),
      note: "VoidBot swarm is a CultMesh-advertised Eve provider. The web page is a local lowering of the same surface.",
    },
    summary: {
      state: deriveSwarmState({ heartbeat, orchestrator, paused, activeTurns }),
      paused,
      pauseReason,
      participantCount: participantSnapshots.length,
      activeTurnCount: activeTurns.length,
      pendingMentionCount: pendingMentions.length,
      readyNowCount: readyNow.length,
      nextIdentityId: nextParticipant?.identityId ?? null,
      nextDisplayName: nextParticipant?.displayName ?? null,
      nextTurnInMinutes: nextParticipant?.nextTurnInMinutes ?? null,
      initiativeClock,
      baseRecoveryMinutes: numberOrNull(heartbeat.value?.baseRecoveryMinutes),
      globalHeat: numberOrNull(heartbeat.value?.globalHeat),
      cadenceMultiplier: controls.cadenceMultiplier,
      lastTickAt: stringOrNull(heartbeat.value?.lastTickAt),
      lastShuffle,
    },
    controls,
    upcomingTurns,
    participants: participantSnapshots,
    activeTurns,
    pendingMentions: pendingMentions.map(projectPendingMention),
    orchestrator: {
      state: deriveOrchestratorState(organs),
      organs,
    },
    recentEvents,
  };
}

function projectControls(value) {
  const cadenceMultiplier = numberOrNull(value?.cadenceMultiplier) ?? 1;
  const manualTurnRequests = Array.isArray(value?.manualTurnRequests)
    ? value.manualTurnRequests.slice(-12).reverse().map((request) => ({
      id: stringOrNull(request?.id),
      identityId: stringOrNull(request?.identityId),
      requestedAt: stringOrNull(request?.requestedAt),
      status: stringOrNull(request?.status) ?? "pending",
      note: stringOrNull(request?.note),
    }))
    : [];
  return {
    cadenceMultiplier,
    updatedAt: stringOrNull(value?.updatedAt),
    manualTurnRequests,
  };
}

function buildUpcomingTurns(participants) {
  const ordered = [...participants]
    .filter((participant) => participant.status === "active")
    .sort((left, right) => {
      const activeDelta = Number(Boolean(right.activeJobId)) - Number(Boolean(left.activeJobId));
      if (activeDelta) return activeDelta;
      return (left.nextTurnInMinutes ?? 999999) - (right.nextTurnInMinutes ?? 999999);
    })
    .slice(0, 16);
  const maxMinutes = Math.max(1, ...ordered.map((participant) => Math.max(0, participant.nextTurnInMinutes ?? 0)));
  return ordered.map((participant, index) => ({
    identityId: participant.identityId,
    displayName: participant.displayName,
    repoName: participant.repoName,
    avatarUrl: participant.avatarUrl,
    participantKind: participant.participantKind,
    activeJobId: participant.activeJobId,
    restState: participant.restState,
    pendingMentionCount: participant.pendingMentionCount,
    shuffleReason: participant.pendingMentionCount > 0
      ? "mention"
      : participant.activeJobId
        ? "active"
        : participant.restState?.isNapping === true
          ? "nap"
          : null,
    nextTurnInMinutes: participant.nextTurnInMinutes,
    effectiveSpeed: participant.effectiveSpeed,
    heat: participant.heat,
    lane: index % 3,
    timelinePosition: participant.activeJobId ? 0 : Math.min(100, Math.max(0, ((Math.max(0, participant.nextTurnInMinutes ?? 0)) / maxMinutes) * 100)),
  }));
}

function findLastShuffleEvent(events) {
  const directMention = events.find((event) =>
    event.type === "queued" &&
    typeof event.pendingMentionCount === "number" &&
    event.pendingMentionCount > 0
  );
  if (directMention) {
    return {
      kind: "direct_mention",
      identityId: directMention.identityId,
      observedAt: directMention.observedAt,
    };
  }
  const manual = events.find((event) => event.type === "manual_turn_override_applied");
  if (manual) {
    return {
      kind: "manual_override",
      identityId: manual.identityId,
      observedAt: manual.observedAt,
    };
  }
  return null;
}

function projectParticipant(participant, pendingMentions, initiativeClock, identityMetadata) {
  const identityId = String(participant.identityId ?? "unknown");
  const metadata = identityMetadata.get(identityId.toLowerCase()) ?? {};
  const nextTurnAt = numberOrNull(participant.nextTurnAt);
  const lastTurnAt = numberOrNull(participant.lastTurnAt);
  const activeTurnStartedAt = numberOrNull(participant.activeTurnStartedAt);
  const channelCount = Array.isArray(participant.groups)
    ? participant.groups.filter((entry) => typeof entry === "string" && entry.startsWith("channel:")).length
    : 0;
  const mentionCount = pendingMentions.filter((mention) => mention?.identityId === identityId).length;
  const nextTurnInMinutes =
    typeof nextTurnAt === "number" && typeof initiativeClock === "number"
      ? round(nextTurnAt - initiativeClock, 3)
      : null;

  return {
    identityId,
    displayName: String(participant.displayName ?? metadata.displayName ?? identityId),
    repoName: String(participant.repoName ?? metadata.repoName ?? "unknown"),
    repoPath: stringOrNull(metadata.repoPath),
    faceStatePath: stringOrNull(metadata.faceStatePath),
    personaStatePath: stringOrNull(metadata.personaStatePath),
    description: stringOrNull(metadata.description),
    avatarUrl: metadata.avatarUrl ?? null,
    avatarPath: metadata.avatarPath ?? null,
    channelPermissions: Array.isArray(metadata.channelPermissions)
      ? metadata.channelPermissions.slice(0, 12).map((entry) => ({
        label: stringOrNull(entry?.label),
        topic: stringOrNull(entry?.topic),
        speechThreshold: stringOrNull(entry?.speechThreshold),
        speedMultiplier: numberOrNull(entry?.speedMultiplier),
      }))
      : [],
    participantKind: String(participant.participantKind ?? "repo_face"),
    turnKind: String(participant.turnKind ?? "repo_face_rumination"),
    status: String(participant.status ?? "unknown"),
    currentLoad: numberOrNull(participant.currentLoad),
    heat: numberOrNull(participant.heat),
    effectiveSpeed: numberOrNull(participant.effectiveSpeed),
    initiativeSpeed: numberOrNull(participant.initiativeSpeed),
    nextTurnAt,
    nextTurnInMinutes,
    lastTurnAt,
    activeTurnStartedAt,
    activeJobId: stringOrNull(participant.activeJobId),
    lastQueuedAt: stringOrNull(participant.lastQueuedAt),
    queuedCount: numberOrNull(participant.queuedCount),
    pendingMentionCount: mentionCount,
    channelCount,
    constraintCount: Array.isArray(participant.constraints) ? participant.constraints.length : 0,
    constraints: Array.isArray(participant.constraints) ? participant.constraints.slice(0, 4).map(String) : [],
  };
}

function projectOrgans(orchestrator) {
  const organs = orchestrator?.organs && typeof orchestrator.organs === "object" ? orchestrator.organs : {};
  return Object.entries(organs).map(([id, organ]) => ({
    id,
    label: String(organ?.label ?? id),
    intervalMinutes: numberOrNull(organ?.intervalMinutes),
    lastStartedAt: stringOrNull(organ?.lastStartedAt),
    lastFinishedAt: stringOrNull(organ?.lastFinishedAt),
    lastExitCode: numberOrNull(organ?.lastExitCode),
    lastStatus: String(organ?.lastStatus ?? "unknown"),
    lastLogPath: stringOrNull(organ?.lastLogPath),
  }));
}

function projectHistoryEvent(event) {
  return {
    type: String(event?.type ?? "event"),
    identityId: stringOrNull(event?.identityId),
    observedAt: stringOrNull(event?.observedAt ?? event?.queuedAt ?? event?.appliedAt),
    activeJobId: stringOrNull(event?.activeJobId),
    statusPath: stringOrNull(event?.statusPath),
    reason: stringOrNull(event?.reason),
    pendingMentionCount: numberOrNull(event?.pendingMentionCount),
    nextTurnAt: numberOrNull(event?.nextTurnAt),
    recoveryMinutes: numberOrNull(event?.recoveryMinutes),
  };
}

async function readIdentityMetadata(registryPathValue) {
  const metadata = new Map();
  const registryPath = resolveConfigPath(registryPathValue, resolve(repoRoot, ".voidbot", "private", "repo-discord-identities.json"));
  const registry = await readJsonFile(registryPath);
  const identities = Array.isArray(registry.value?.identities)
    ? registry.value.identities
    : Array.isArray(registry.value)
      ? registry.value
      : [];
  for (const identity of identities) {
    const id = typeof identity?.id === "string" ? identity.id.toLowerCase() : "";
    if (id) {
      metadata.set(id, {
        id,
        displayName: stringOrNull(identity?.displayName),
        repoName: stringOrNull(identity?.repoName),
        repoPath: stringOrNull(identity?.repoPath),
        identityKind: stringOrNull(identity?.identityKind),
        faceStatePath: stringOrNull(identity?.faceStatePath),
        personaStatePath: stringOrNull(identity?.personaStatePath),
        description: stringOrNull(identity?.description),
        avatarUrl: stringOrNull(identity?.avatarUrl),
        avatarPath: stringOrNull(identity?.avatarPath),
        channelPermissions: Array.isArray(identity?.channelPermissions) ? identity.channelPermissions : [],
      });
    }
  }
  return metadata;
}

async function readFaceStates(identityMetadata) {
  const states = new Map();
  let core = null;
  try {
    const requireCore = createRequire(resolve(repoRoot, "packages", "core", "package.json"));
    core = requireCore(resolve(repoRoot, "packages", "core", "dist", "index.js"));
  } catch (error) {
    for (const [id, identity] of identityMetadata.entries()) {
      states.set(id, {
        readable: false,
        path: identity.faceStatePath ?? null,
        error: `Core typed-state loader unavailable: ${error instanceof Error ? error.message : String(error)}`,
        tree: [],
      });
    }
    return states;
  }

  for (const [id, identity] of identityMetadata.entries()) {
    if (identity.identityKind === "native_persona") {
      states.set(id, readPersonaStateSummary(identity));
      continue;
    }

    if (!identity.faceStatePath) {
      states.set(id, {
        readable: false,
        path: null,
        error: "No Face state path registered.",
        tree: [],
      });
      continue;
    }
    try {
      const typedState = await core.loadVoidSelfStateTypedDocuments({
        canonicalPath: identity.faceStatePath,
        identity: {
          agentId: id,
          publicName: identity.displayName ?? id,
          publicDescription: identity.description ?? undefined,
        },
      });
      const rendered = core.buildVoidSelfStateContext
        ? core.buildVoidSelfStateContext(typedState, {
          sourcePath: identity.faceStatePath,
          identity: {
            agentId: id,
            publicName: identity.displayName ?? id,
            publicDescription: identity.description ?? undefined,
          },
        })
        : null;
      states.set(id, {
        readable: true,
        path: identity.faceStatePath,
        summary: truncate(rendered?.summary ?? "", 1200),
        counts: countFaceState(typedState),
        restState: projectRestState(typedState),
        tree: buildFaceStateTree(typedState),
      });
    } catch (error) {
      states.set(id, {
        readable: false,
        path: identity.faceStatePath,
        error: error instanceof Error ? error.message : String(error),
        tree: [],
      });
    }
  }
  return states;
}

function readPersonaStateSummary(identity) {
  if (!identity.personaStatePath) {
    return {
      readable: false,
      path: null,
      error: "No Persona state path registered.",
      tree: [],
    };
  }

  try {
    const raw = readFileSync(resolve(identity.personaStatePath), "utf8");
    const state = JSON.parse(stripBom(raw));
    return {
      readable: true,
      kind: "native_persona",
      path: identity.personaStatePath,
      summary: truncate(state.publicDescription ?? state.presentation?.voiceSummary ?? "", 1200),
      counts: {
        memory: state.thoughtMemory?.memories?.length ?? 0,
        pressures: state.agencyPressure?.pressures?.length ?? 0,
        needs: state.affect?.needs?.length ?? 0,
        statusReads: state.affect?.statusReads?.length ?? 0,
        doctrine: state.affect?.doctrineStances?.length ?? 0,
      },
      tree: buildPersonaStateTree(state),
    };
  } catch (error) {
    return {
      readable: false,
      kind: "native_persona",
      path: identity.personaStatePath,
      error: error instanceof Error ? error.message : String(error),
      tree: [],
    };
  }
}

function buildPersonaStateTree(state) {
  return [
    node("Persona", "persona", [
      leaf("Public Name", state.publicName),
      leaf("Description", state.publicDescription),
      leaf("Voice", state.presentation?.voiceSummary),
      collectionNode("Values", "values", state.values, valueNode),
      objectNode("Activation", "activationProfile", state.activationProfile),
      collectionNode("Private Notes", "privateNotes", state.privateNotes, valueNode),
    ]),
    node("Thought Memory", "thoughtMemory", [
      collectionNode("Short Term", "thoughtMemory.shortTerm", state.thoughtMemory?.shortTerm, memoryNode),
      collectionNode("Durable Memories", "thoughtMemory.memories", state.thoughtMemory?.memories, memoryNode),
      collectionNode("Incubation", "thoughtMemory.incubation", state.thoughtMemory?.incubation, memoryNode),
    ]),
    node("Affect", "affect", [
      collectionNode("Needs", "affect.needs", state.affect?.needs, valueNode),
      collectionNode("Status Reads", "affect.statusReads", state.affect?.statusReads, valueNode),
      collectionNode("Doctrine", "affect.doctrineStances", state.affect?.doctrineStances, valueNode),
    ]),
  ];
}

function projectRestState(typedState) {
  const sleepCycle = typedState?.scheduledRuntime?.sleepCycle;
  if (!sleepCycle || typeof sleepCycle !== "object") {
    return null;
  }
  return {
    isNapping: sleepCycle.isNapping === true,
    napEndsAt: stringOrNull(sleepCycle.currentNapEndsAt),
    nextNapStartsAt: stringOrNull(sleepCycle.nextNapStartsAt),
    activeDreamThemes: Array.isArray(sleepCycle.activeDreamThemes)
      ? sleepCycle.activeDreamThemes.slice(0, 8).map(String)
      : [],
  };
}

function countFaceState(typedState) {
  return {
    shortTerm: typedState?.thoughtMemory?.shortTerm?.length ?? 0,
    memories: typedState?.thoughtMemory?.memories?.length ?? 0,
    incubation: typedState?.thoughtMemory?.incubation?.length ?? 0,
    bonds: typedState?.faceAffect?.socialBonds?.length ?? 0,
    pressures: typedState?.agencyPressure?.pressures?.length ?? 0,
    candidates: typedState?.candidateInterventions?.interventions?.length ?? 0,
  };
}

function buildFaceStateTree(typedState) {
  return [
    node("Self Profile", "selfProfile", [
      leaf("Public Name", typedState?.selfProfile?.publicName),
      leaf("Description", typedState?.selfProfile?.publicDescription),
      collectionNode("Values", "selfProfile.values", typedState?.selfProfile?.values, valueNode),
      objectNode("Activation", "selfProfile.activationProfile", typedState?.selfProfile?.activationProfile),
      collectionNode("Private Notes", "selfProfile.privateNotes", typedState?.selfProfile?.privateNotes, valueNode),
    ]),
    node("Thought Memory", "thoughtMemory", [
      collectionNode("Short Term", "thoughtMemory.shortTerm", typedState?.thoughtMemory?.shortTerm, memoryNode),
      collectionNode("Durable Memories", "thoughtMemory.memories", typedState?.thoughtMemory?.memories, memoryNode),
      collectionNode("Incubation", "thoughtMemory.incubation", typedState?.thoughtMemory?.incubation, memoryNode),
    ]),
    node("Affect", "faceAffect", [
      collectionNode("Needs", "faceAffect.needs", typedState?.faceAffect?.needs, valueNode),
      collectionNode("Social Bonds", "faceAffect.socialBonds", typedState?.faceAffect?.socialBonds, memoryNode),
      collectionNode("Status Reads", "faceAffect.statusReads", typedState?.faceAffect?.statusReads, memoryNode),
      objectNode("Mood", "faceAffect.moodDimensions", typedState?.faceAffect?.moodDimensions),
      collectionNode("Social Biases", "faceAffect.socialBiases", typedState?.faceAffect?.socialBiases, valueNode),
    ]),
    node("Agency", "agencyPressure", [
      collectionNode("Pressures", "agencyPressure.pressures", typedState?.agencyPressure?.pressures, memoryNode),
      collectionNode("Candidates", "candidateInterventions.interventions", typedState?.candidateInterventions?.interventions, memoryNode),
    ]),
    node("Runtime", "scheduledRuntime", [
      objectNode("Sleep Cycle", "scheduledRuntime.sleepCycle", typedState?.scheduledRuntime?.sleepCycle),
      objectNode("Speaking Pressure", "scheduledRuntime.speakingPressure", typedState?.scheduledRuntime?.speakingPressure),
      objectNode("Last Runs", "scheduledRuntime.lastRuns", typedState?.scheduledRuntime?.lastRuns),
    ]),
  ].filter(Boolean);
}

function node(label, path, children = []) {
  const compactChildren = children.filter(Boolean);
  return { kind: "branch", label, path, children: compactChildren, count: compactChildren.length };
}

function leaf(label, value, path = label) {
  if (value === null || value === undefined || value === "") return null;
  return {
    kind: "leaf",
    label,
    path,
    title: label,
    preview: truncate(renderValuePreview(value), 120),
    detail: renderValueDetail(value),
  };
}

function collectionNode(label, path, values, projector) {
  if (!Array.isArray(values) || values.length === 0) return node(label, path, [leaf("empty", "No entries.", `${path}.empty`)]);
  return node(label, path, values.slice(0, 80).map((value, index) => projector(value, `${path}.${index}`, index)));
}

function objectNode(label, path, value) {
  if (!value || typeof value !== "object") return node(label, path, [leaf("empty", "No entries.", `${path}.empty`)]);
  const children = Object.entries(value).slice(0, 80).map(([key, entry]) => {
    if (entry && typeof entry === "object") return objectNode(key, `${path}.${key}`, entry);
    return leaf(key, entry, `${path}.${key}`);
  });
  return node(label, path, children);
}

function valueNode(value, path, index) {
  if (value && typeof value === "object") {
    const title = value.label ?? value.name ?? value.kind ?? value.id ?? `entry ${index + 1}`;
    return leaf(String(title), value, path);
  }
  return leaf(`entry ${index + 1}`, value, path);
}

function memoryNode(value, path, index) {
  if (!value || typeof value !== "object") return leaf(`entry ${index + 1}`, value, path);
  const target = value.target?.label ?? value.target?.id ?? value.targetKind ?? value.target ?? value.kind;
  const title = value.summary ?? value.claim ?? value.question ?? value.title ?? value.id ?? value.memoryId ?? `entry ${index + 1}`;
  const label = target ? `${target}: ${title}` : title;
  return {
    kind: "leaf",
    label: truncate(String(label), 120),
    path,
    title: String(title),
    preview: truncate(value.claim ?? value.question ?? value.tension ?? value.actionImplication ?? value.summary ?? renderValuePreview(value), 180),
    detail: renderMemoryDetail(value),
  };
}

function renderMemoryDetail(value) {
  const lines = [];
  for (const key of ["kind", "summary", "claim", "question", "tension", "actionImplication", "status", "intensity", "createdAt", "updatedAt"]) {
    if (value?.[key] !== null && value?.[key] !== undefined && value?.[key] !== "") {
      lines.push(`${key}: ${renderValuePreview(value[key])}`);
    }
  }
  if (value?.target) lines.push(`target: ${renderValuePreview(value.target)}`);
  if (Array.isArray(value?.anchorRefs) && value.anchorRefs.length > 0) {
    lines.push(`anchors:\n${value.anchorRefs.map((anchor) => `- ${renderValuePreview(anchor)}`).join("\n")}`);
  }
  if (Array.isArray(value?.tags) && value.tags.length > 0) lines.push(`tags: ${value.tags.join(", ")}`);
  return lines.join("\n\n") || renderValueDetail(value);
}

function renderValuePreview(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderValueDetail(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function projectPendingMention(mention) {
  return {
    identityId: stringOrNull(mention?.identityId),
    sourceChannelId: stringOrNull(mention?.sourceChannelId),
    sourceMessageId: stringOrNull(mention?.sourceMessageId),
    createdAt: stringOrNull(mention?.createdAt),
    prompt: truncate(String(mention?.prompt ?? mention?.content ?? ""), 220),
  };
}

function deriveSwarmState({ heartbeat, orchestrator, paused, activeTurns }) {
  if (!heartbeat.ok) return "missing";
  if (paused) return "paused";
  const organ = projectOrgans(orchestrator.value).find((entry) => entry.id === "repo-face-heartbeats");
  if (organ && organ.lastStatus && !["ok", "skipped_disabled"].includes(organ.lastStatus)) {
    return "warning";
  }
  if (activeTurns.length > 0) return "running";
  return "ready";
}

function deriveOrchestratorState(organs) {
  if (organs.length === 0) return "missing";
  if (organs.some((organ) => ["failed", "error", "stalled"].includes(organ.lastStatus))) return "warning";
  if (organs.some((organ) => organ.lastStatus === "running")) return "running";
  return "ok";
}

async function writeCultMeshPublication(snapshot, eveState, storePath, allowStoreReset = true) {
  try {
    const cultPackages = loadCultPackages();
    if (!cultPackages) {
      return {
        writeStatus: "skipped",
        writeError: "CultMesh/CultCache packages were not found in known local CultLib paths.",
      };
    }

    const { CultMesh, defineDocumentType } = cultPackages;
    const snapshotDefinition = defineDocumentType({
      type: snapshotDocumentType,
      schemaName: snapshotDocumentType,
      schemaId: snapshotSchemaId,
      schemaVersion: snapshotSchemaId,
      contentHash: snapshotSchemaId,
      canonicalSchemaJson: JSON.stringify({
        schemaName: snapshotDocumentType,
        schemaVersion: snapshotSchemaId,
        description: "Redacted read-only VoidBot swarm state snapshot for CultMesh distribution.",
      }),
      global: true,
      schema: {
        parse(input) {
          if (!input || typeof input !== "object") {
            throw new Error("VoidBot swarm snapshot must be an object.");
          }
          return input;
        },
      },
    });
    const providerDefinition = defineDocumentType({
      type: providerAdvertisementDocumentType,
      schemaName: providerAdvertisementDocumentType,
      schemaId: providerAdvertisementSchemaId,
      schemaVersion: providerAdvertisementSchemaId,
      contentHash: providerAdvertisementSchemaId,
      global: true,
      name: "providerId",
      schema: { parse: parseObjectDocument("Eve provider advertisement") },
    });
    const surfaceDefinition = defineDocumentType({
      type: surfaceDocumentType,
      schemaName: surfaceDocumentType,
      schemaId: surfaceSchemaId,
      schemaVersion: surfaceSchemaId,
      contentHash: surfaceSchemaId,
      global: true,
      name: "providerId",
      schema: { parse: parseObjectDocument("Eve surface state") },
    });
    const eveBindingDefinition = defineDocumentType({
      type: eveBindingDocumentType,
      schemaName: eveBindingDocumentType,
      schemaId: eveBindingSchemaId,
      schemaVersion: eveBindingSchemaId,
      contentHash: eveBindingSchemaId,
      global: true,
      name: "bindingId",
      schema: { parse: parseObjectDocument("Eve interface binding") },
    });
    const node = await CultMesh.createNode(storePath, {
      documents: [snapshotDefinition, providerDefinition, surfaceDefinition, eveBindingDefinition],
    });
    const providerAdvertisement = buildProviderAdvertisement(snapshot);
    const eveBinding = buildEveInterfaceBinding(snapshot, eveState);
    await node.put(snapshotDefinition, "voidbot-swarm", snapshot);
    await node.put(providerDefinition, providerId, providerAdvertisement);
    await node.put(surfaceDefinition, providerId, eveState);
    await node.put(eveBindingDefinition, providerId, eveBinding);
    await node.flush?.(true);
    return {
      writeStatus: "ok",
      storePath,
      documents: [snapshotDocumentType, providerAdvertisementDocumentType, surfaceDocumentType, eveBindingDocumentType],
      providerId,
      verseId,
      eveBinding: {
        documentType: eveBindingDocumentType,
        schemaId: eveBindingSchemaId,
        key: providerId,
      },
      eveDeckEndpoint: primaryCultMeshEndpoint(),
      writtenAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      allowStoreReset &&
      existsSync(storePath) &&
      /global document type .* has multiple persisted entries/i.test(message)
    ) {
      const backupPath = `${storePath}.bak-duplicate-globals-${timestampForFile(new Date())}`;
      await rename(storePath, backupPath);
      const retry = await writeCultMeshPublication(snapshot, eveState, storePath, false);
      return {
        ...retry,
        recoveredFrom: {
          reason: "duplicate-global-documents",
          backupPath,
        },
      };
    }

    return {
      writeStatus: "failed",
      storePath,
      writeError: message,
    };
  }
}

function timestampForFile(date) {
  return date.toISOString().replace(/[:.]/g, "").replace("T", "-").replace("Z", "Z");
}

function loadCultPackages() {
  const candidates = [
    resolve(repoRoot, "..", "CultLib", "packages", "cultmesh-ts", "package.json"),
    resolve(repoRoot, "..", "CultMeshTS", "package.json"),
  ];
  for (const packageJson of candidates) {
    if (!existsSync(packageJson)) {
      continue;
    }
    try {
      const requireCult = createRequire(packageJson);
      const { CultMesh } = requireFirstAvailable(requireCult, [
        "cultmesh-ts",
        "cultmesh-ts/dist/index.js",
      ]);
      const { defineDocumentType } = requireFirstAvailable(requireCult, [
        "cultcache-ts",
        "cultcache-ts/dist/index.js",
      ]);
      if (CultMesh && defineDocumentType) {
        return { CultMesh, defineDocumentType };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function requireFirstAvailable(requireFromPackage, specifiers) {
  let lastError;
  for (const specifier of specifiers) {
    try {
      return requireFromPackage(specifier);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function parseObjectDocument(label) {
  return (input) => {
    if (!input || typeof input !== "object") {
      throw new Error(`${label} must be an object.`);
    }
    return input;
  };
}

function buildProviderAdvertisement(snapshot) {
  const endpoints = [
    primaryCultMeshEndpoint(),
  ];
  return {
    schemaVersion: providerAdvertisementSchemaId,
    providerId,
    verseId,
    title: "VoidBot Swarm",
    description: "VoidBot swarm status, CTB order, controls, and selected Face state as an Eve/CultUI surface.",
    version: String(snapshot.summary?.initiativeClock ?? Date.now()),
    status: snapshot.summary?.state ?? "unknown",
    updatedAt: snapshot.generatedAt,
    endpoints,
    provider: providerManifest(),
    controlSurface: {
      primary: primaryCultMeshEndpoint(),
      controls: {
        transport: "cultmesh-binding",
        documentType: eveBindingDocumentType,
        key: providerId,
      },
    },
    documents: [{
      type: snapshotDocumentType,
      schemaId: snapshotSchemaId,
      key: "voidbot-swarm",
    }, {
      type: surfaceDocumentType,
      schemaId: surfaceSchemaId,
      key: providerId,
    }, {
      type: eveBindingDocumentType,
      schemaId: eveBindingSchemaId,
      key: providerId,
    }],
  };
}

function buildEveInterfaceBinding(snapshot, eveState) {
  return {
    schemaVersion: eveBindingSchemaId,
    bindingId: providerId,
    providerId,
    verseId,
    title: "VoidBot Swarm",
    kind: "eve-cultui-surface",
    updatedAt: snapshot.generatedAt,
    authority: {
      owner: "VoidBot swarm renderer",
      sourceDocuments: [{
        type: snapshotDocumentType,
        schemaId: snapshotSchemaId,
        key: "voidbot-swarm",
      }],
      surfaceDocument: {
        type: surfaceDocumentType,
        schemaId: surfaceSchemaId,
        key: providerId,
      },
      controlOwner: "VoidBot heartbeat state",
    },
    surface: eveState.surface,
    stateSummary: {
      state: snapshot.summary?.state ?? "unknown",
      participantCount: snapshot.summary?.participantCount ?? 0,
      activeTurnCount: snapshot.summary?.activeTurnCount ?? 0,
      pendingMentionCount: snapshot.summary?.pendingMentionCount ?? 0,
      nextIdentityId: snapshot.summary?.nextIdentityId ?? null,
      nextDisplayName: snapshot.summary?.nextDisplayName ?? null,
      lastTickAt: snapshot.summary?.lastTickAt ?? null,
    },
    controls: [{
      id: "swarm.pause",
      label: "Pause swarm",
      command: "set-pause",
      writes: {
        documentType: eveBindingDocumentType,
        key: providerId,
        field: "controlIntent.pause",
      },
    }, {
      id: "swarm.cadence",
      label: "Set cadence",
      command: "set-cadence-multiplier",
      writes: {
        documentType: eveBindingDocumentType,
        key: providerId,
        field: "controlIntent.cadenceMultiplier",
      },
    }, {
      id: "swarm.force-turn",
      label: "Pull Face forward",
      command: "force-turn",
      writes: {
        documentType: eveBindingDocumentType,
        key: providerId,
        field: "controlIntent.manualTurnRequests",
      },
    }],
    rendererHints: {
      preferredLowerings: ["eve-native", "nightwing-tui", "browser"],
      viewportMode: "continuous-ops",
      tileId: "voidbot-swarm",
      minWidth: 112,
      minHeight: 30,
      preferredWidth: 156,
      preferredHeight: 58,
      priority: -30,
      density: "continuous",
    },
    lowerings: [{
      kind: "static-html",
      role: "local-debug-artifact",
      path: dashboardPath,
    }],
  };
}

function providerManifest() {
  return {
    id: providerId,
    title: "VoidBot Swarm",
    description: "Native Eve tab for VoidBot agent status, CTB order, selected Face state, and swarm controls.",
    version: "1",
    endpoint: primaryCultMeshEndpoint(),
    capabilities: ["ctb", "agent-status", "state-tree", "swarm-controls", "cultmesh-snapshot"],
    usesCultMesh: true,
    transport: "CultMesh Eve interface binding.",
  };
}

function buildEveProviderState(snapshot) {
  const summary = snapshot.summary ?? {};
  const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];
  const upcoming = Array.isArray(snapshot.upcomingTurns) ? snapshot.upcomingTurns : [];
  const orchestrator = snapshot.orchestrator ?? {};
  const organs = Array.isArray(orchestrator.organs) ? orchestrator.organs : [];
  const watchdog = findSnapshotOrgan(organs, "voidbot-operations-watchdog") ?? findSnapshotOrgan(organs, "watchdog");
  const nodes = [
    {
      id: "voidbot-swarm",
      label: `VoidBot Swarm\n${summary.state ?? "unknown"}`,
      kind: "cultmesh-verse",
      visible: true,
      health: summary.state ?? "unknown",
      detail: `agents ${summary.participantCount ?? participants.length}; next ${summary.nextDisplayName ?? "none"}`,
    },
    ...participants.slice(0, 24).map((participant, index) => ({
      id: `face-${participant.identityId}`,
      label: `${participant.displayName}\n${participant.repoName}`,
      kind: "repo-face",
      visible: true,
      x: -0.9 + (index % 6) * 0.36,
      y: -0.3 + Math.floor(index / 6) * 0.22,
      z: 0,
      rotation: 0,
      scale: 1,
      width: 0.26,
      height: 0.16,
      health: participant.activeJobId ? "running" : participant.restState?.isNapping ? "napping" : participant.status,
      detail: `next ${participant.nextTurnInMinutes ?? "?"}m; heat ${participant.heat ?? "?"}`,
    })),
  ];
  return {
    type: "dashboard-state",
    schema: "mimir.eve_dashboard_state.v1",
    providerId,
    title: "VoidBot Swarm",
    version: Math.floor(Date.parse(snapshot.generatedAt ?? new Date().toISOString()) / 1000),
    updatedAt: snapshot.generatedAt,
    selectedNodeId: "voidbot-swarm",
    lutPreset: "terminal",
    nodes,
    surface: {
      schema: "gamecult.eve.surface.v1",
      id: "voidbot.swarm.surface",
      title: "VoidBot Swarm",
      root: eveNode("voidbot-cockpit", "cockpit", {
        title: "VoidBot Swarm",
        status: summary.state ?? "unknown",
        layout: {
          direction: "vertical",
          overflow: "scroll",
          gap: 8,
          padding: 8,
          grow: 5,
          minWidth: 112,
          minHeight: 30,
          preferredWidth: 156,
          preferredHeight: 58,
          priority: -30,
          density: "continuous",
          viewportMode: "continuous-ops",
        },
      }, [
        eveNode("ctb-rail", "rail", {
          title: "CTB order",
          layout: { direction: "horizontal", overflow: "scroll-x", height: 112, gap: 8 },
        }, upcoming.slice(0, 14).map((turn, index) =>
          eveNode(`turn-${stableId(turn.identityId)}-${index}`, "avatar", {
            text: turn.displayName,
            assetUri: turn.avatarUrl,
            status: turnState(turn),
            detail: `${turn.repoName ?? "repo"} / ${minutesText(turn.nextTurnInMinutes)}`,
          }),
        )),
        eveNode("voidbot-ops-row", "row", {
          title: "Operations",
          layout: { direction: "horizontal", gap: 8, grow: 1 },
        }, [
          eveNode("upcoming-faces-pane", "pane", { title: "Next Faces" }, upcoming.slice(0, 10).map((turn, index) =>
            eveNode(`upcoming-face-${index}-${stableId(turn.identityId)}`, "text", {
              role: "mono",
              text: `${String(index + 1).padStart(2, " ")}. ${String(turn.displayName ?? turn.identityId ?? "face").padEnd(10, " ")} ${turnState(turn).padEnd(8, " ")} ${turn.repoName ?? "repo"}  spd ${formatNumber(turn.effectiveSpeed, 3)} heat ${formatNumber(turn.heat, 2)}`,
            }),
          )),
          eveNode("voidbot-watchdog-pane", "pane", { title: "VoidBot Watchdog" }, [
            eveNode("watchdog-summary", "text", {
              role: "mono",
              text: `orchestrator ${orchestrator.state ?? "unknown"}  organs ${organs.length}`,
            }),
            watchdog
              ? eveNode("watchdog-status", "text", {
                role: "strong",
                text: `watchdog ${watchdog.lastStatus ?? "unknown"} exit ${watchdog.lastExitCode ?? 0}\nlast ${shortIso(watchdog.lastFinishedAt ?? watchdog.lastStartedAt)}`,
              })
              : eveNode("watchdog-missing", "text", {
                role: "caption",
                text: "watchdog organ not present in snapshot",
              }),
            ...organs
              .slice()
              .sort((left, right) => {
                const leftWatchdog = String(left.id ?? "").toLowerCase() === "voidbot-operations-watchdog" ? 0 : 1;
                const rightWatchdog = String(right.id ?? "").toLowerCase() === "voidbot-operations-watchdog" ? 0 : 1;
                return leftWatchdog - rightWatchdog || String(left.id ?? "").localeCompare(String(right.id ?? ""));
              })
              .slice(0, 7)
              .map((organ) => eveNode(`watchdog-organ-${stableId(organ.id)}`, "text", {
                role: "caption",
                text: `${organ.label ?? organ.id ?? "organ"}: ${organ.lastStatus ?? "unknown"}`,
              })),
          ]),
        ]),
        eveNode("voidbot-workspace", "row", {
          title: "Swarm State",
          layout: { direction: "horizontal", gap: 8, grow: 2 },
        }, [
          eveNode("voidbot-summary", "text", {
            role: "mono",
            text: [
              "VoidBot Swarm",
              `${summary.state ?? "unknown"}  next ${summary.nextDisplayName ?? "none"}`,
              `agents ${summary.participantCount ?? participants.length}  ready ${summary.readyNowCount ?? 0}  cadence x${summary.cadenceMultiplier ?? 1}`,
              `mesh ${snapshot.cultMesh?.writeStatus ?? "pending"}  ${snapshot.generatedAt}`,
            ].join("\n"),
          }),
          eveNode("voidbot-participants", "list", { title: "Faces" }, participants.slice(0, 16).map((participant) =>
            eveNode(`participant-${stableId(participant.identityId)}`, "row", {
              title: participant.displayName,
              detail: `${participant.repoName} / ${participant.status} / heat ${participant.heat ?? "?"}`,
            }),
          )),
        ]),
      ]),
      assets: participants
        .filter((participant) => participant.avatarUrl)
        .slice(0, 32)
        .map((participant) => ({
          id: `avatar-${participant.identityId}`,
          kind: "image",
          uri: participant.avatarUrl,
        })),
    },
  };
}

function eveNode(id, kind, props = {}, children = []) {
  return { id, kind, props, children };
}

function stableId(value) {
  return String(value ?? "id")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "id";
}

function turnState(turn) {
  if (turn?.activeJobId) return "active";
  if ((turn?.pendingMentionCount ?? 0) > 0) return "mention";
  if (turn?.restState?.isNapping) return "nap";
  return minutesText(turn?.nextTurnInMinutes);
}

function minutesText(value) {
  return typeof value === "number"
    ? value <= 0 ? "ready" : `${value.toFixed(value < 10 ? 1 : 0)}m`
    : "unknown";
}

function formatNumber(value, decimals) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(decimals).replace(/\.?0+$/, "") : "?";
}

function shortIso(value) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "unknown";
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function findSnapshotOrgan(organs, needle) {
  const lower = String(needle).toLowerCase();
  return organs.find((organ) =>
    String(organ?.id ?? "").toLowerCase().includes(lower) ||
    String(organ?.label ?? "").toLowerCase().includes(lower));
}

function renderHtml(snapshot) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>VoidBot Swarm Control</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Montserrat:wght@100;300;500&family=Press+Start+2P&family=Ubuntu:wght@400;500;700&display=swap");

    :root {
      color-scheme: dark;
      --bg: #03070d;
      --panel: rgba(6, 15, 19, 0.9);
      --panel-soft: rgba(142, 223, 176, 0.07);
      --line: rgba(142, 223, 176, 0.18);
      --line-strong: rgba(142, 223, 176, 0.4);
      --text: #effcf8;
      --muted: rgba(239, 252, 248, 0.66);
      --green: #8edfb0;
      --amber: #ffae58;
      --cyan: #69e2ef;
      --coral: #ff7b72;
      --violet: #b99dff;
      --rail: 124px;
      --font: "Ubuntu", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --display: "Montserrat", "Ubuntu", ui-sans-serif, system-ui, sans-serif;
      --arcade: "Press Start 2P", "VT323", monospace;
      --mono: "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
    }

    * { box-sizing: border-box; }
    html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    html { height: -webkit-fill-available; }
    body {
      background:
        radial-gradient(circle at 72% 12%, rgba(255, 174, 88, 0.14), transparent 24%),
        radial-gradient(circle at 10% 18%, rgba(142, 223, 176, 0.14), transparent 28%),
        linear-gradient(180deg, #03070d, #07110f 52%, #091712);
      color: var(--text);
      font: 15px/1.45 var(--font);
      letter-spacing: 0;
    }

    h1, h2, h3, p { margin: 0; }
    h1, h2, h3, .kicker, .badge, .metric strong, .turn-card strong, .state-leaf strong {
      font-family: var(--display);
      font-weight: 100;
      letter-spacing: 0;
    }
    button, select, input { font: inherit; }
    button, select {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(142, 223, 176, 0.09);
      color: var(--text);
      font-weight: 760;
    }
    button { cursor: pointer; padding: 0 12px; }
    button:hover, select:hover { border-color: var(--amber); }
    select { min-width: 0; padding: 0 10px; }
    input[type="range"] { width: 100%; accent-color: var(--cyan); }

    .shell {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: var(--app-height, 100vh);
      min-height: -webkit-fill-available;
      background: rgba(3, 7, 13, 0.72);
      overflow: hidden;
    }

    .hud-canvas {
      position: absolute;
      inset: 0;
      z-index: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    .ctb-rail {
      position: absolute;
      z-index: 3;
      top: 0;
      left: 0;
      right: 0;
      height: var(--rail);
      display: flex;
      gap: 8px;
      padding: 10px 274px 10px 10px;
      border-color: var(--line);
      background: rgba(3, 7, 13, 0.86);
      backdrop-filter: blur(18px);
      overflow: auto;
      min-width: 0;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: rgba(142, 223, 176, 0.58) rgba(3, 7, 13, 0.32);
    }

    .turn-card {
      flex: 0 0 auto;
      width: 72px;
      height: 96px;
      display: grid;
      justify-items: center;
      align-content: start;
      gap: 4px;
      padding: 7px 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(8, 19, 24, 0.9);
      color: var(--text);
      text-align: center;
    }
    .turn-card.active-turn { border-color: var(--cyan); box-shadow: 0 0 24px rgba(105, 226, 239, 0.22); }
    .turn-card.selected { border-color: var(--amber); background: rgba(255, 174, 88, 0.11); }
    .turn-card.mention-turn { border-color: var(--amber); }
    .turn-card strong, .turn-card span {
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .turn-card strong { font-size: 0.68rem; line-height: 1.05; }
    .turn-card span { color: var(--muted); font: 0.64rem/1.05 var(--mono); }
    .turn-card .turn-reason { color: var(--amber); text-transform: uppercase; }

    .avatar {
      display: grid;
      width: 42px;
      height: 42px;
      place-items: center;
      overflow: hidden;
      border: 2px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: linear-gradient(160deg, #69e2ef, #c2f5f0);
      color: #08313a;
      font-weight: 900;
      line-height: 1;
    }
    .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }

    .workspace {
      position: absolute;
      z-index: 1;
      top: var(--rail);
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
    }

    .status-panel {
      position: absolute;
      top: 14px;
      right: 10px;
      z-index: 4;
      width: 250px;
      height: 96px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 5px;
      padding: 7px;
      border: 1px solid rgba(255, 174, 88, 0.34);
      border-radius: 8px;
      background:
        repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0) 0 3px, rgba(0, 0, 0, 0.24) 3px 4px),
        linear-gradient(160deg, rgba(255, 174, 88, 0.12), rgba(6, 15, 19, 0.94) 34%, rgba(105, 226, 239, 0.08));
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04), 0 18px 42px rgba(0, 0, 0, 0.32);
      color: var(--text);
      font-family: var(--display);
      font-weight: 100;
      overflow: hidden;
    }

    .status-panel h2 {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      font-size: 0.62rem;
      line-height: 1;
      color: var(--amber);
      font-family: var(--arcade);
      font-weight: 400;
    }

    .status-grid {
      min-height: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px 7px;
      align-content: start;
    }

    .hud-stat {
      min-width: 0;
      display: grid;
      gap: 3px;
    }

    .hud-label {
      display: flex;
      justify-content: space-between;
      gap: 3px;
      color: rgba(239, 252, 248, 0.74);
      font-size: 0.43rem;
      line-height: 1;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .hud-label span:first-child {
      font-family: var(--arcade);
      font-weight: 400;
    }

    .hud-label span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--display);
      font-weight: 100;
    }

    .hud-bar {
      height: 4px;
      overflow: hidden;
      border: 1px solid rgba(239, 252, 248, 0.16);
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.34);
    }

    .hud-fill {
      display: block;
      height: 100%;
      width: calc(var(--fill, 0) * 1%);
      max-width: 100%;
      background: linear-gradient(90deg, var(--green), var(--cyan));
    }

    .hud-fill.warn { background: linear-gradient(90deg, var(--amber), var(--coral)); }

    .pane {
      position: absolute;
      min-width: 0;
      min-height: 0;
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
      overflow: hidden;
    }
    .pane-scroll { overflow: auto; }
    .inspector-pane {
      left: 12px;
      top: 12px;
      bottom: 12px;
      width: calc(24% - 15px);
      grid-template-rows: auto auto auto minmax(0, 1fr);
    }
    .tree-pane {
      left: calc(24% + 6px);
      top: 12px;
      bottom: 12px;
      width: calc(34% - 18px);
      grid-template-rows: auto minmax(0, 1fr);
    }
    .tree-pane .mono { overflow-wrap: anywhere; }
    .memory-pane {
      left: calc(58% + 6px);
      top: 12px;
      right: 12px;
      bottom: 12px;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .kicker { color: var(--green); font-size: 0.74rem; text-transform: uppercase; }
    h1 { font-size: clamp(1.55rem, 3.4vw, 3rem); line-height: 0.98; }
    h2 { font-size: 1rem; text-transform: uppercase; }
    .muted { color: var(--muted); }
    .mono { font-family: var(--mono); }

    .metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
    .metric, .fact, .agent-stat {
      min-width: 0;
      padding: 10px;
      border: 1px solid rgba(142, 223, 176, 0.12);
      border-radius: 8px;
      background: var(--panel-soft);
    }
    .metric span, .fact span { display: block; color: var(--muted); font-size: 0.68rem; font-weight: 800; text-transform: uppercase; }
    .metric strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.12rem; }
    .fact strong { display: block; overflow-wrap: anywhere; font: 0.9rem/1.15 var(--mono); }

    .control-grid {
      display: grid;
      gap: 8px;
      align-content: start;
      padding: 10px;
      border: 1px solid rgba(105, 226, 239, 0.16);
      border-radius: 8px;
      background: rgba(3, 7, 13, 0.36);
    }
    .control-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .force-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }

    .inspector-hero {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
    }
    .inspector-hero .avatar { width: 64px; height: 64px; }
    .inspector-hero h1, .inspector-hero p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .inspector-lore {
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      color: var(--muted);
      font-size: 0.83rem;
    }
    .agent-stats { display: grid; gap: 8px; }
    .agent-stat {
      display: grid;
      gap: 6px;
      padding: 8px;
    }
    .agent-stat-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: rgba(239, 252, 248, 0.88);
      font: 0.72rem/1.1 var(--mono);
      text-transform: uppercase;
    }
    .agent-stat-head span:first-child {
      color: var(--muted);
      font-family: var(--display);
      font-weight: 300;
    }
    .agent-bar {
      height: 8px;
      overflow: hidden;
      border: 1px solid rgba(239, 252, 248, 0.16);
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.38);
      box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.34);
    }
    .agent-fill {
      display: block;
      width: calc(var(--fill, 0) * 1%);
      max-width: 100%;
      height: 100%;
      background: linear-gradient(90deg, var(--green), var(--cyan));
      box-shadow: 0 0 12px rgba(105, 226, 239, 0.28);
    }
    .agent-fill.hot { background: linear-gradient(90deg, var(--amber), var(--coral)); }
    .agent-fill.cool { background: linear-gradient(90deg, var(--violet), var(--cyan)); }
    .channel-list, .state-tree, .detail-body {
      min-height: 0;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      display: grid;
      align-content: start;
      gap: 8px;
    }
    .channel-chip {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(142, 223, 176, 0.06);
      font-size: 0.78rem;
    }
    .channel-chip strong, .channel-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    details.state-node {
      border: 1px solid rgba(142, 223, 176, 0.12);
      border-radius: 8px;
      background: rgba(142, 223, 176, 0.045);
      overflow: hidden;
    }
    details.state-node[open] { border-color: rgba(105, 226, 239, 0.22); }
    details.state-node > summary {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 10px;
      cursor: pointer;
      color: var(--text);
      font-family: var(--display);
      font-weight: 100;
    }
    .state-children {
      display: grid;
      gap: 6px;
      padding: 6px 8px 8px 12px;
      border-top: 1px solid rgba(142, 223, 176, 0.08);
    }
    .state-leaf {
      min-width: 0;
      display: grid;
      gap: 3px;
      padding: 8px;
      border: 1px solid rgba(142, 223, 176, 0.1);
      border-radius: 8px;
      background: rgba(3, 7, 13, 0.34);
      color: var(--text);
      text-align: left;
    }
    .state-leaf:hover, .state-leaf.selected { border-color: var(--amber); background: rgba(255, 174, 88, 0.09); }
    .state-leaf strong {
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow-wrap: anywhere;
    }
    .state-leaf span {
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow-wrap: anywhere;
    }
    .state-leaf span { color: var(--muted); font: 0.72rem/1.15 var(--mono); }

    .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .detail-card {
      min-height: 0;
      display: grid;
      gap: 10px;
      align-content: start;
      padding: 12px;
      border: 1px solid rgba(105, 226, 239, 0.16);
      border-radius: 8px;
      background: rgba(3, 7, 13, 0.42);
    }
    .detail-card pre {
      min-height: 0;
      margin: 0;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: rgba(239, 252, 248, 0.88);
      font: 0.84rem/1.35 var(--mono);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--green);
      color: #06100d;
      font-size: 0.7rem;
      text-transform: uppercase;
    }
    .badge.running, .badge.info { background: var(--cyan); }
    .badge.paused, .badge.warning { background: var(--amber); }
    .badge.failed, .badge.missing, .badge.error { background: var(--coral); }
    .badge.repo-face { background: var(--violet); }

    @media (orientation: landscape) {
      .ctb-rail {
        flex-direction: row;
        align-items: center;
        border-bottom: 1px solid var(--line);
      }
      .turn-card { width: 76px; height: 96px; }
    }

    @media (orientation: portrait) {
      :root { --rail: 94px; }
      .ctb-rail {
        top: 0;
        left: 0;
        right: auto;
        bottom: 0;
        width: var(--rail);
        height: auto;
        padding: 10px;
        flex-direction: column;
        align-items: center;
        border-right: 1px solid var(--line);
      }
      .workspace {
        top: 0;
        left: var(--rail);
      }
      .inspector-pane {
        left: 10px;
        top: 10px;
        right: 10px;
        bottom: auto;
        width: auto;
        height: 34%;
        padding-right: calc(clamp(190px, 22vw, 230px) + 24px);
        grid-template-columns: minmax(230px, 0.9fr) minmax(180px, 0.76fr) minmax(230px, 1fr);
        grid-template-rows: minmax(0, 1fr);
        align-items: stretch;
      }
      .tree-pane {
        left: 10px;
        top: calc(34% + 20px);
        bottom: 10px;
        width: calc(44% - 16px);
      }
      .memory-pane {
        left: calc(44% + 4px);
        top: calc(34% + 20px);
        right: 10px;
        bottom: 10px;
      }
      .control-grid {
        min-height: 0;
      }
      .inspector-hero {
        align-self: start;
      }
      .agent-stats {
        min-height: 0;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-content: start;
        gap: 7px;
      }
      .agent-stat {
        padding: 7px;
      }
      .agent-bar {
        height: 7px;
      }
      .inspector-lore {
        display: none;
      }
      .turn-card { width: 72px; height: 96px; }
      .status-panel {
        position: fixed;
        top: 8px;
        right: 8px;
        bottom: auto;
        left: auto;
        width: clamp(190px, 22vw, 230px);
        height: 88px;
      }
    }

    @media (max-width: 760px) {
      .pane { padding: 12px; }
      .status-panel { width: 210px; }
    }

    @media (max-width: 850px) and (orientation: portrait) {
      .inspector-pane {
        height: 38%;
        padding-right: 12px;
        grid-template-columns: minmax(210px, 1fr) minmax(170px, 0.8fr);
      }
      .agent-stats {
        grid-column: 1 / -1;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .tree-pane {
        top: calc(38% + 20px);
      }
      .memory-pane {
        top: calc(38% + 20px);
      }
      .status-panel {
        top: auto;
        right: 12px;
        bottom: 12px;
        width: 180px;
        height: 84px;
      }
    }

    @media (max-width: 980px) and (orientation: landscape) {
      .inspector-pane { width: 25%; }
      .tree-pane { left: calc(25% + 18px); width: calc(34% - 18px); }
      .memory-pane { left: calc(59% + 12px); }
      .inspector-lore { display: none; }
    }
  </style>
</head>
<body>
  <main id="app"></main>
  <script id="initial-snapshot" type="application/json">${escapeScriptJson(JSON.stringify(snapshot))}</script>
  <script>
    const initialSnapshot = JSON.parse(document.getElementById("initial-snapshot").textContent);
    const app = document.getElementById("app");
    let selectedIdentity = null;
    let selectedStatePath = null;

    const tone = (value) => String(value || "unknown").toLowerCase().replace(/_/g, "-");
    const text = (value) => value === null || value === undefined || value === "" ? "missing" : String(value);
    const esc = (value) => text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const number = (value) => typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "missing";
    const minutes = (value, restState = null) => restState?.isNapping === true
      ? "napping"
      : typeof value === "number"
        ? (value <= 0 ? "ready" : value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "m")
        : "missing";
    const relative = (timestamp) => {
      if (!timestamp) return "missing";
      const time = Date.parse(timestamp);
      if (!Number.isFinite(time)) return timestamp;
      const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
      if (seconds < 60) return seconds + "s ago";
      const mins = Math.round(seconds / 60);
      if (mins < 60) return mins + "m ago";
      const hours = Math.round(mins / 60);
      if (hours < 48) return hours + "h ago";
      return Math.round(hours / 24) + "d ago";
    };
    const initials = (value) => text(value).split(/\\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
    const badge = (value, label = value) => "<span class=\\"badge " + tone(value) + "\\">" + esc(String(label).replace(/_/g, " ")) + "</span>";

    function render(snapshot) {
      setAppHeight();
      const participants = sortedParticipants(snapshot);
      if (!selectedIdentity || !participants.some((agent) => agent.identityId === selectedIdentity)) {
        selectedIdentity = (snapshot.upcomingTurns || [])[0]?.identityId || participants[0]?.identityId || null;
        selectedStatePath = null;
      }
      const selected = participants.find((agent) => agent.identityId === selectedIdentity) || participants[0] || null;
      const selectedLeaf = findSelectedLeaf(selected);
      if (selectedLeaf) selectedStatePath = selectedLeaf.path;
      app.innerHTML = [
        "<div class=\\"shell\\">",
          "<canvas id=\\"hud-canvas\\" class=\\"hud-canvas\\"></canvas>",
          renderCtb(snapshot.upcomingTurns || []),
          renderStatusPanel(snapshot, selected),
          "<section class=\\"workspace\\" aria-label=\\"VoidBot swarm control\\">",
            renderInspector(snapshot, participants, selected),
            renderStateTree(selected),
            renderStateDetail(selected, selectedLeaf),
          "</section>",
        "</div>",
      ].join("");
      attachControls();
      attachSelection();
      attachStateSelection();
      requestAnimationFrame(drawHudCanvas);
    }

    function setAppHeight() {
      document.documentElement.style.setProperty("--app-height", window.innerHeight + "px");
    }

    function sortedParticipants(snapshot) {
      return [...(snapshot.participants || [])].sort((a, b) => {
        const active = Number(Boolean(b.activeJobId)) - Number(Boolean(a.activeJobId));
        if (active) return active;
        const mentions = (b.pendingMentionCount || 0) - (a.pendingMentionCount || 0);
        if (mentions) return mentions;
        return (a.nextTurnInMinutes ?? 999999) - (b.nextTurnInMinutes ?? 999999);
      });
    }

    function renderCtb(turns) {
      return "<nav class=\\"ctb-rail\\" aria-label=\\"Upcoming CTB turns\\">" + turns.map((turn) => {
        const klass = ["turn-card", turn.identityId === selectedIdentity ? "selected" : "", turn.activeJobId ? "active-turn" : "", turn.pendingMentionCount > 0 ? "mention-turn" : ""].filter(Boolean).join(" ");
        return "<button class=\\"" + klass + "\\" type=\\"button\\" data-select=\\"" + esc(turn.identityId) + "\\" title=\\"" + esc(turn.displayName + " / " + minutes(turn.nextTurnInMinutes, turn.restState)) + "\\">" + avatarHtml(turn) + "<strong>" + esc(turn.displayName) + "</strong><span>" + esc(minutes(turn.nextTurnInMinutes, turn.restState)) + "</span>" + (turn.shuffleReason ? "<span class=\\"turn-reason\\">" + esc(turn.shuffleReason) + "</span>" : "") + "</button>";
      }).join("") + "</nav>";
    }

    function renderInspector(snapshot, participants, agent) {
      if (!agent) return "<section class=\\"pane inspector-pane\\"><p class=\\"kicker\\">Face</p><p class=\\"muted\\">No selected Face.</p></section>";
      const counts = agent.faceState?.counts || {};
      const memoryCount = (counts.shortTerm || 0) + (counts.memories || 0);
      return "<section class=\\"pane inspector-pane\\">" + renderControls(snapshot, participants) + "<div class=\\"inspector-hero\\">" + avatarHtml(agent) + "<div><p class=\\"kicker\\">Selected Face</p><h1>" + esc(agent.displayName) + "</h1><p class=\\"muted mono\\">" + esc(agent.identityId) + " / " + esc(agent.repoName) + "</p></div></div><div class=\\"agent-stats\\">" +
        statBar("Turn", minutes(agent.nextTurnInMinutes, agent.restState), turnPercent(agent.nextTurnInMinutes), agent.restState?.isNapping === true ? "warm" : "cool") +
        statBar("Memory", number(memoryCount), Math.min(100, memoryCount * 7), "cool") +
        statBar("Pressure", number(counts.pressures || 0), Math.min(100, (counts.pressures || 0) * 14), (counts.pressures || 0) > 4 ? "hot" : "") +
        statBar("Heat", number(agent.heat), Math.min(100, (agent.heat || 0) * 34), (agent.heat || 0) > 1.5 ? "hot" : "") +
        statBar("Load", number(agent.currentLoad), Math.min(100, (agent.currentLoad || 0) * 100), (agent.currentLoad || 0) > 0.7 ? "hot" : "") +
        statBar("Speed", number(agent.effectiveSpeed), Math.min(100, (agent.effectiveSpeed || 0) * 34), "") +
      "</div><div class=\\"inspector-lore\\"><p>" + esc(agent.description || "No Face description registered.") + "</p><div class=\\"channel-list\\">" + (agent.channelPermissions || []).map((channel) => "<div class=\\"channel-chip\\"><strong>" + esc(channel.label || "channel") + "</strong><span>x" + esc(number(channel.speedMultiplier || 1)) + "</span><span class=\\"muted\\">" + esc(channel.topic || "no topic") + "</span><span class=\\"mono muted\\">" + esc(channel.speechThreshold || "threshold") + "</span></div>").join("") + "</div></div></section>";
    }

    function renderControls(snapshot, participants) {
      const controls = snapshot.controls || {};
      const latest = (controls.manualTurnRequests || [])[0];
      const paused = snapshot.summary?.paused === true;
      const pauseReason = snapshot.summary?.pauseReason
        ? "<div class=\\"muted small\\">" + esc(snapshot.summary.pauseReason) + "</div>"
        : "";
      return "<div class=\\"control-grid\\"><p class=\\"kicker\\">Controls</p>" +
        "<div><div class=\\"muted\\">Swarm brake</div><div class=\\"control-row\\"><span>" + badge(paused ? "paused" : "running", paused ? "Paused" : "Unpaused") + "</span></div>" + pauseReason + "</div>" +
        "<div><div class=\\"muted\\">Heartbeat cadence</div><div class=\\"control-row\\"><strong id=\\"cadence-value\\" class=\\"mono\\">x" + esc(number(controls.cadenceMultiplier || 1)) + "</strong></div></div>" +
        "<div><div class=\\"muted\\">Control surface</div><div class=\\"mono\\">CultMesh Eve binding: gamecult.eve.interface_binding / voidbot.swarm</div></div>" +
        "<div class=\\"mono muted\\">Latest request: " + esc(latest?.identityId || "none") + " " + esc(latest?.status || "") + "</div>" +
      "</div>";
    }

    function statBar(label, value, fill, variant = "") {
      return "<div class=\\"agent-stat\\"><div class=\\"agent-stat-head\\"><span>" + esc(label) + "</span><strong>" + esc(value) + "</strong></div><div class=\\"agent-bar\\"><span class=\\"agent-fill " + esc(variant) + "\\" style=\\"--fill:" + esc(clampPercent(fill)) + "\\"></span></div></div>";
    }

    function turnPercent(value) {
      if (typeof value !== "number") return 0;
      return value <= 0 ? 100 : clampPercent(100 - value * 5);
    }

    function renderStateTree(agent) {
      const state = agent?.faceState;
      if (!agent) return "<section class=\\"pane tree-pane\\"><p class=\\"kicker\\">State Graph</p><p class=\\"muted\\">No Face selected.</p></section>";
      if (!state?.readable) return "<section class=\\"pane tree-pane\\"><p class=\\"kicker\\">State Graph</p><p class=\\"muted\\">" + esc(state?.error || "Face state unreadable.") + "</p></section>";
      return "<section class=\\"pane tree-pane\\"><div><p class=\\"kicker\\">State Graph</p><h2>" + esc(agent.displayName) + " memory tree</h2><p class=\\"muted mono\\">" + esc(state.path || "state path missing") + "</p></div><div class=\\"state-tree\\">" + renderTreeNodes(state.tree || [], 0) + "</div></section>";
    }

    function renderTreeNodes(nodes, depth = 0) {
      return (nodes || []).map((node) => {
        if (node.kind === "branch") {
          const open = depth === 0 || branchContainsSelection(node);
          return "<details class=\\"state-node\\" " + (open ? "open" : "") + "><summary><span>" + esc(node.label) + "</span><span class=\\"mono muted\\">" + esc(node.count || 0) + "</span></summary><div class=\\"state-children\\">" + renderTreeNodes(node.children || [], depth + 1) + "</div></details>";
        }
        const klass = "state-leaf" + (node.path === selectedStatePath ? " selected" : "");
        return "<button class=\\"" + klass + "\\" type=\\"button\\" data-state-path=\\"" + esc(node.path) + "\\"><strong>" + esc(node.label) + "</strong><span>" + esc(node.preview || "") + "</span></button>";
      }).join("");
    }

    function renderStateDetail(agent, leaf) {
      if (!agent) return "<section class=\\"pane memory-pane\\"><p class=\\"kicker\\">State Detail</p><p class=\\"muted\\">No selected Face.</p></section>";
      if (!agent.faceState?.readable) return "<section class=\\"pane memory-pane\\"><p class=\\"kicker\\">State Detail</p><p class=\\"muted\\">" + esc(agent.faceState?.error || "Face state unreadable.") + "</p></section>";
      const selected = leaf || firstLeaf(agent.faceState.tree || []);
      if (!selected) return "<section class=\\"pane memory-pane\\"><p class=\\"kicker\\">State Detail</p><p class=\\"muted\\">No entries in this state file.</p></section>";
      selectedStatePath = selected.path;
      return "<section class=\\"pane memory-pane\\"><div><p class=\\"kicker\\">State Detail</p><h2>" + esc(selected.title || selected.label) + "</h2><p class=\\"muted mono\\">" + esc(selected.path) + "</p></div><div class=\\"detail-body\\"><div class=\\"detail-card\\"><pre>" + esc(selected.detail || selected.preview || "") + "</pre></div></div></section>";
    }

    function findSelectedLeaf(agent) {
      const leaves = flattenLeaves(agent?.faceState?.tree || []);
      if (!leaves.length) return null;
      if (selectedStatePath) {
        const existing = leaves.find((leaf) => leaf.path === selectedStatePath);
        if (existing) return existing;
      }
      const memory = leaves.find((leaf) =>
        leaf.label !== "empty" && (
          leaf.path.startsWith("thoughtMemory.shortTerm") ||
          leaf.path.startsWith("thoughtMemory.memories") ||
          leaf.path.startsWith("thoughtMemory.incubation")
        )
      );
      if (memory) return memory;
      return leaves[0];
    }

    function firstLeaf(nodes) {
      return flattenLeaves(nodes)[0] || null;
    }

    function flattenLeaves(nodes) {
      const output = [];
      const visit = (node) => {
        if (!node) return;
        if (node.kind === "leaf") output.push(node);
        for (const child of node.children || []) visit(child);
      };
      for (const node of nodes || []) visit(node);
      return output;
    }

    function branchContainsSelection(node) {
      if (!selectedStatePath) return false;
      if (node.path && selectedStatePath.startsWith(node.path)) return true;
      return (node.children || []).some((child) => child.kind === "branch" ? branchContainsSelection(child) : child.path === selectedStatePath);
    }

    function renderStatusPanel(snapshot, agent) {
      const summary = snapshot.summary || {};
      const organs = snapshot.orchestrator?.organs || [];
      const watchdog = findOrgan(organs, "watchdog");
      const face = findOrgan(organs, "repo-face-heartbeats");
      const mood = findOrgan(organs, "mood");
      const rumination = findOrgan(organs, "rumination");
      const sourceFreshness = snapshot.sources?.heartbeatStateUpdatedAt ? Math.max(0, 100 - ((Date.now() - Date.parse(snapshot.sources.heartbeatStateUpdatedAt)) / 600)) : 0;
      const meshOk = snapshot.cultMesh?.writeStatus === "ok" ? 100 : snapshot.cultMesh?.writeStatus === "pending" ? 50 : 10;
      const turn = agent?.nextTurnInMinutes ?? null;
      const turnFill = typeof turn === "number" ? clampPercent(100 - Math.max(0, turn) * 4) : 0;
      const load = clampPercent((agent?.currentLoad || 0) * 100);
      return "<aside class=\\"status-panel\\" aria-label=\\"Compact swarm status\\"><h2><span>VOID</span><span>" + esc(String(summary.state || "UNK").slice(0, 4).toUpperCase()) + "</span></h2><div class=\\"status-grid\\">" +
        hud("WDOG", organCode(watchdog), organFill(watchdog), organWarn(watchdog)) +
        hud("ORCH", shortState(snapshot.orchestrator?.state), statusFill(snapshot.orchestrator?.state), statusWarn(snapshot.orchestrator?.state)) +
        hud("FACE", organCode(face), organFill(face), organWarn(face)) +
        hud("MOOD", organCode(mood), organFill(mood), organWarn(mood)) +
        hud("RUM", organCode(rumination), organFill(rumination), organWarn(rumination)) +
        hud("MESH", shortState(snapshot.cultMesh?.writeStatus), meshOk, snapshot.cultMesh?.writeStatus !== "ok") +
        hud("AGE", relative(snapshot.sources?.heartbeatStateUpdatedAt).replace(/ ago$/, ""), sourceFreshness, sourceFreshness < 50) +
        hud("TURN", minutes(turn), turnFill, load > 70) +
      "</div></aside>";
    }

    function findOrgan(organs, needle) {
      const lower = String(needle).toLowerCase();
      return organs.find((organ) => String(organ.id || "").toLowerCase().includes(lower) || String(organ.label || "").toLowerCase().includes(lower));
    }

    function shortState(value) {
      const state = String(value || "missing").toLowerCase();
      if (state === "ok") return "OK";
      if (state === "ready") return "RDY";
      if (state === "running") return "RUN";
      if (state === "paused") return "PAUS";
      if (state === "warning") return "WARN";
      if (state === "skipped_disabled") return "SKIP";
      if (state === "missing") return "MISS";
      if (state === "failed" || state === "error") return "FAIL";
      return state.slice(0, 4).toUpperCase();
    }

    function organCode(organ) {
      return organ ? shortState(organ.lastStatus) : "MISS";
    }

    function organFill(organ) {
      return organ ? statusFill(organ.lastStatus) : 0;
    }

    function organWarn(organ) {
      return !organ || statusWarn(organ.lastStatus);
    }

    function statusFill(value) {
      const state = String(value || "missing").toLowerCase();
      if (state === "ok" || state === "ready" || state === "skipped_disabled") return 100;
      if (state === "running") return 82;
      if (state === "warning" || state === "paused") return 46;
      return 12;
    }

    function statusWarn(value) {
      const state = String(value || "missing").toLowerCase();
      return !["ok", "ready", "running", "skipped_disabled"].includes(state);
    }

    function hud(label, value, fill, warn = false) {
      return "<div class=\\"hud-stat\\"><div class=\\"hud-label\\"><span>" + esc(label) + "</span><span>" + esc(value) + "</span></div><div class=\\"hud-bar\\"><span class=\\"hud-fill " + (warn ? "warn" : "") + "\\" style=\\"--fill:" + esc(clampPercent(fill)) + "\\"></span></div></div>";
    }

    function clampPercent(value) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
    }

    function metric(label, value) {
      return "<div class=\\"metric\\"><span>" + esc(label) + "</span><strong>" + value + "</strong></div>";
    }

    function fact(label, value) {
      return "<div class=\\"fact\\"><span>" + esc(label) + "</span><strong>" + esc(value) + "</strong></div>";
    }

    function avatarHtml(agent) {
      return agent.avatarUrl
        ? "<span class=\\"avatar\\"><img src=\\"" + esc(agent.avatarUrl) + "\\" alt=\\"" + esc(agent.displayName) + "\\"></span>"
        : "<span class=\\"avatar\\">" + esc(initials(agent.displayName)) + "</span>";
    }

    function drawHudCanvas() {
      const canvas = document.getElementById("hud-canvas");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const bg = ctx.createLinearGradient(0, 0, rect.width, rect.height);
      bg.addColorStop(0, "#03070d");
      bg.addColorStop(0.55, "#07110f");
      bg.addColorStop(1, "#091712");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, rect.width, rect.height);

      ctx.globalAlpha = 0.26;
      ctx.strokeStyle = "rgba(105,226,239,0.16)";
      ctx.lineWidth = 1;
      for (let x = 0; x < rect.width; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, rect.height);
        ctx.stroke();
      }
      for (let y = 0; y < rect.height; y += 24) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(rect.width, y + 0.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      document.querySelectorAll(".pane, .status-panel").forEach((panel) => {
        const r = panel.getBoundingClientRect();
        drawPanelChrome(ctx, r.left, r.top, r.width, r.height);
      });
    }

    function drawPanelChrome(ctx, x, y, width, height) {
      const radius = 8;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 10;
      roundedRect(ctx, x, y, width, height, radius);
      ctx.fillStyle = "rgba(6,15,19,0.34)";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(105,226,239,0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,174,88,0.16)";
      ctx.beginPath();
      ctx.moveTo(x + 10, y + 1.5);
      ctx.lineTo(x + Math.min(width - 10, 84), y + 1.5);
      ctx.stroke();
      ctx.restore();
    }

    function roundedRect(ctx, x, y, width, height, radius) {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
    }

    function attachSelection() {
      document.querySelectorAll("[data-select]").forEach((element) => {
        element.addEventListener("click", () => {
          selectedIdentity = element.getAttribute("data-select");
          selectedStatePath = null;
          refresh();
        });
      });
    }

    function attachStateSelection() {
      document.querySelectorAll("[data-state-path]").forEach((element) => {
        element.addEventListener("click", () => {
          selectedStatePath = element.getAttribute("data-state-path");
          refresh();
        });
      });
    }

    function attachControls() {
      // Static HTML is a debug lowering only. Network controls live in the
      // CultMesh Eve binding, not HTTP endpoints.
    }

    async function refresh() {
      try {
        const response = await fetch("swarm-state.json?ts=" + Date.now(), { cache: "no-store" });
        if (response.ok) {
          render(await response.json());
          return;
        }
      } catch {}
      render(initialSnapshot);
    }

    render(initialSnapshot);
    setInterval(refresh, 10000);
    window.addEventListener("orientationchange", () => setTimeout(refresh, 180));
    window.addEventListener("resize", () => window.requestAnimationFrame(() => {
      setAppHeight();
      drawHudCanvas();
    }));
    refresh();
  </script>
</body>
</html>
`;
}

function redactSnapshot(snapshot) {
  const redacted = JSON.parse(JSON.stringify(snapshot));
  redacted.visibility = "public_redacted";
  redacted.sources = {
    heartbeatStateReadable: snapshot.sources?.heartbeatStateReadable ?? false,
    heartbeatStateUpdatedAt: snapshot.sources?.heartbeatStateUpdatedAt ?? null,
    orchestratorReadable: snapshot.sources?.orchestratorReadable ?? false,
    orchestratorUpdatedAt: snapshot.sources?.orchestratorUpdatedAt ?? null,
    pauseReadable: snapshot.sources?.pauseReadable ?? false,
  };
  redacted.cultMesh = {
    documentType: snapshot.cultMesh?.documentType,
    schemaId: snapshot.cultMesh?.schemaId,
    documentKey: snapshot.cultMesh?.documentKey,
    writeStatus: snapshot.cultMesh?.writeStatus,
    writtenAt: snapshot.cultMesh?.writtenAt,
    note: "Public redacted snapshot. Local paths and job ids are withheld.",
  };
  redacted.participants = redacted.participants.map((participant) => ({
    ...participant,
    activeJobId: participant.activeJobId ? "active" : null,
    constraints: [],
    constraintCount: participant.constraintCount,
    description: participant.description ? truncate(participant.description, 220) : null,
    faceStatePath: null,
    faceState: participant.faceState
      ? {
        readable: participant.faceState.readable,
        counts: participant.faceState.counts,
        path: null,
        tree: [],
      }
      : undefined,
  }));
  redacted.activeTurns = redacted.activeTurns.map((participant) => ({
    ...participant,
    activeJobId: participant.activeJobId ? "active" : null,
    constraints: [],
  }));
  redacted.pendingMentions = redacted.pendingMentions.map((mention) => ({
    identityId: mention.identityId,
    createdAt: mention.createdAt,
  }));
  redacted.orchestrator.organs = redacted.orchestrator.organs.map((organ) => ({
    ...organ,
    lastLogPath: null,
  }));
  redacted.recentEvents = redacted.recentEvents.map((event) => ({
    ...event,
    activeJobId: event.activeJobId ? "active" : null,
    statusPath: null,
  }));
  return redacted;
}

function primaryCultMeshEndpoint() {
  return `cultmesh://${verseId}/eve/providers/${providerId}`;
}

async function readJsonFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    return { ok: true, value: JSON.parse(stripBom(raw)) };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getMtime(path) {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

async function readDotEnv(path) {
  const values = {};
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      values[line.slice(0, separator).trim()] = line.slice(separator + 1);
    }
  } catch {}
  return values;
}

function resolveConfigPath(value, fallback) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return resolve(repoRoot, raw);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--serve") parsed.serve = true;
    else if (arg === "--open") parsed.open = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        index += 1;
      } else {
        parsed[key] = "true";
      }
    }
  }
  return parsed;
}

function isFlagEnabled(value) {
  return value === true || value === "true" || value === "1" || value === "yes" || value === "on";
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function escapeScriptJson(value) {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
