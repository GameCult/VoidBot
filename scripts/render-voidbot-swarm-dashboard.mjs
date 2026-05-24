#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultStorageRoot = resolve(repoRoot, ".voidbot");
const defaultStatusDir = resolve(defaultStorageRoot, "status");
const defaultSnapshotPath = resolve(defaultStatusDir, "swarm-state.json");
const defaultDashboardPath = resolve(defaultStatusDir, "swarm-dashboard.html");
const defaultCultMeshStorePath = resolve(defaultStatusDir, "cultmesh", "voidbot-swarm-state.cc");
const snapshotDocumentType = "voidbot.swarm_state_snapshot";
const snapshotSchemaId = "voidbot.swarm_state_snapshot.v1";

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

const renderResult = await render();

if (args.open) {
  console.log(pathToFileURL(renderResult.dashboardPath).href);
}

if (args.serve) {
  await serveDashboard({
    host: args.host ?? "0.0.0.0",
    port: Number.parseInt(args.port ?? "8787", 10),
    rootDir: dirname(renderResult.dashboardPath),
    refreshSeconds: Number.parseInt(args.refreshSeconds ?? "10", 10),
  });
} else {
  console.log(`Swarm dashboard HTML: ${renderResult.dashboardPath}`);
  console.log(`Swarm snapshot JSON: ${renderResult.snapshotPath}`);
  console.log(`CultMesh snapshot store: ${renderResult.cultMeshStorePath}`);
}

async function render() {
  let snapshot = await buildSnapshot();
  if (args.public) {
    snapshot = redactSnapshot(snapshot);
  }
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  await mkdir(dirname(dashboardPath), { recursive: true });
  await writeFile(dashboardPath, renderHtml(snapshot), "utf8");

  const cultMeshWrite = await writeCultMeshSnapshot(snapshot, cultMeshStorePath);
  const finalSnapshot = {
    ...snapshot,
    cultMesh: {
      ...snapshot.cultMesh,
      ...cultMeshWrite,
    },
  };

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
  const avatarByIdentity = await readIdentityAvatars(env.REPO_DISCORD_IDENTITIES_PATH);
  const heartbeatMtime = await getMtime(heartbeatStatePath);
  const orchestratorMtime = await getMtime(orchestratorPath);
  const paused = pause.ok ? pause.value?.paused !== false : false;
  const pauseReason = pause.ok && typeof pause.value?.reason === "string" ? pause.value.reason : undefined;
  const participants = Array.isArray(heartbeat.value?.participants) ? heartbeat.value.participants : [];
  const pendingMentions = Array.isArray(heartbeat.value?.pendingMentions) ? heartbeat.value.pendingMentions : [];
  const initiativeClock = numberOrNull(heartbeat.value?.initiativeClock);
  const participantSnapshots = participants.map((participant) =>
    projectParticipant(participant, pendingMentions, initiativeClock, avatarByIdentity),
  );
  const activeTurns = participantSnapshots.filter((participant) => participant.activeJobId);
  const readyNow = participantSnapshots.filter((participant) =>
    participant.status === "active" &&
    !participant.activeJobId &&
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
      note: "CultMesh should distribute this typed CultCache snapshot; the web page remains read-only.",
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
    pendingMentionCount: participant.pendingMentionCount,
    shuffleReason: participant.pendingMentionCount > 0 ? "mention" : participant.activeJobId ? "active" : null,
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

function projectParticipant(participant, pendingMentions, initiativeClock, avatarByIdentity) {
  const identityId = String(participant.identityId ?? "unknown");
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
    displayName: String(participant.displayName ?? identityId),
    repoName: String(participant.repoName ?? "unknown"),
    avatarUrl: avatarByIdentity.get(identityId.toLowerCase()) ?? null,
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

async function readIdentityAvatars(registryPathValue) {
  const avatars = new Map();
  const registryPath = resolveConfigPath(registryPathValue, resolve(repoRoot, ".voidbot", "private", "repo-discord-identities.json"));
  const registry = await readJsonFile(registryPath);
  const identities = Array.isArray(registry.value?.identities)
    ? registry.value.identities
    : Array.isArray(registry.value)
      ? registry.value
      : [];
  for (const identity of identities) {
    const id = typeof identity?.id === "string" ? identity.id.toLowerCase() : "";
    const avatarUrl = typeof identity?.avatarUrl === "string" ? identity.avatarUrl : "";
    if (id && avatarUrl) {
      avatars.set(id, avatarUrl);
    }
  }
  return avatars;
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

async function writeCultMeshSnapshot(snapshot, storePath) {
  try {
    const cultCacheRoot = resolve(repoRoot, "..", "CultCacheTS");
    const cultCachePackage = resolve(cultCacheRoot, "package.json");
    if (!existsSync(cultCachePackage)) {
      return {
        writeStatus: "skipped",
        writeError: `CultCacheTS package was not found at ${cultCachePackage}.`,
      };
    }

    const requireCultCache = createRequire(cultCachePackage);
    const { CultCache, SingleFileMessagePackBackingStore, defineDocumentType } = requireCultCache(
      resolve(cultCacheRoot, "dist", "index.js"),
    );
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
    const store = new SingleFileMessagePackBackingStore(storePath);
    const cache = CultCache.builder()
      .withDocumentType(snapshotDefinition)
      .withGenericStore(store)
      .build();
    await cache.pullAllBackingStores();
    await cache.put(snapshotDefinition, "voidbot-swarm", snapshot);
    return {
      writeStatus: "ok",
      storePath,
      writtenAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      writeStatus: "failed",
      storePath,
      writeError: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderHtml(snapshot) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VoidBot Swarm State</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101113;
      --panel: #181a1d;
      --panel-2: #202327;
      --line: #343941;
      --text: #f1efe7;
      --muted: #aaa69a;
      --green: #61d394;
      --amber: #e6b450;
      --coral: #e06c66;
      --cyan: #55b8c6;
      --violet: #a891e8;
      --ink: #070808;
      --font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
    }

    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body {
      margin: 0;
      color: var(--text);
      font: 15px/1.5 var(--font);
      letter-spacing: 0;
      background:
        linear-gradient(180deg, rgba(16, 17, 19, 0.98), rgba(16, 17, 19, 1)),
        var(--bg);
    }

    main {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 20px;
      display: grid;
      gap: 16px;
    }

    header {
      display: grid;
      gap: 10px;
      padding: 18px 0 6px;
    }

    h1, h2, h3, p { margin: 0; }
    h1 {
      font-size: clamp(2rem, 5vw, 4.5rem);
      line-height: 0.95;
      font-weight: 760;
    }

    h2 {
      font-size: 1rem;
      font-weight: 720;
      text-transform: uppercase;
    }

    .topline {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      color: var(--muted);
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }

    .metric, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .metric {
      padding: 14px;
      min-height: 92px;
      display: grid;
      align-content: space-between;
      gap: 8px;
    }

    .metric strong {
      font-size: 2rem;
      line-height: 1;
    }

    .metric span {
      color: var(--muted);
      font-size: 0.86rem;
      text-transform: uppercase;
      font-weight: 680;
    }

    section {
      padding: 14px;
      display: grid;
      gap: 12px;
      overflow: hidden;
    }

    .participants {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 10px;
    }

    .agent {
      min-width: 0;
      display: grid;
      gap: 10px;
      padding: 12px;
      background: var(--panel-2);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .agent-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: start;
    }

    .agent h3 {
      font-size: 1.08rem;
      font-weight: 760;
      overflow-wrap: anywhere;
    }

    .repo {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.76rem;
      overflow-wrap: anywhere;
    }

    .facts {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .fact {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .fact span {
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      font-weight: 700;
    }

    .fact strong {
      font-family: var(--mono);
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }

    .tables {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 10px;
    }

    .controls {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr);
      gap: 12px;
      align-items: stretch;
    }

    .control-block {
      display: grid;
      gap: 10px;
      min-width: 0;
    }

    .control-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    input[type="range"] {
      width: min(360px, 100%);
      accent-color: var(--cyan);
    }

    select, button {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      font: 700 0.94rem/1 var(--font);
    }

    select {
      min-width: 180px;
      padding: 0 10px;
    }

    button {
      cursor: pointer;
      padding: 0 14px;
    }

    button:hover {
      border-color: var(--cyan);
    }

    .timeline {
      position: relative;
      min-height: 132px;
      padding: 8px 4px 2px;
      overflow-x: auto;
    }

    .timeline-track {
      position: relative;
      min-width: 720px;
      height: 104px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      border-top: 2px solid var(--line);
      background:
        linear-gradient(90deg, rgba(85, 184, 198, 0.24), transparent 18%),
        repeating-linear-gradient(90deg, transparent 0 11.5%, rgba(255,255,255,0.04) 11.5% 12%);
      border-radius: 8px;
    }

    .timeline-now {
      position: absolute;
      top: -11px;
      left: 0;
      width: 2px;
      height: 112px;
      background: var(--cyan);
      box-shadow: 0 0 16px rgba(85, 184, 198, 0.45);
    }

    .turn-card {
      position: relative;
      flex: 0 0 auto;
      width: 62px;
      height: 86px;
      padding: 5px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #24282d;
      box-shadow: 0 12px 26px rgba(0,0,0,0.2);
      display: grid;
      justify-items: center;
      align-content: start;
      gap: 3px;
    }

    .turn-card.active-turn {
      border-color: var(--cyan);
      background: #26343a;
    }

    .turn-card strong {
      max-width: 100%;
      font-size: 0.68rem;
      line-height: 1.05;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .turn-card span {
      max-width: 100%;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.72rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .avatar {
      width: 38px;
      height: 38px;
      border-radius: 999px;
      border: 2px solid rgba(255,255,255,0.14);
      background: #111;
      display: grid;
      place-items: center;
      overflow: hidden;
      font-weight: 900;
      color: var(--text);
    }

    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .turn-card .turn-time {
      font-size: 0.62rem;
    }

    .turn-card .turn-reason {
      color: var(--amber);
      font-size: 0.58rem;
      text-transform: uppercase;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    th, td {
      padding: 9px 8px;
      border-top: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }

    th {
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
    }

    code, .mono {
      font-family: var(--mono);
      font-size: 0.88em;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 26px;
      padding: 4px 9px;
      border-radius: 999px;
      color: var(--ink);
      background: var(--muted);
      font-size: 0.74rem;
      font-weight: 800;
      text-transform: uppercase;
      white-space: normal;
      overflow-wrap: anywhere;
      text-align: center;
    }

    .ready, .ok, .active { background: var(--green); }
    .running, .info { background: var(--cyan); }
    .paused, .warning { background: var(--amber); }
    .failed, .missing, .error { background: var(--coral); }
    .repo-face { background: var(--violet); }

    .muted { color: var(--muted); }
    .footer {
      color: var(--muted);
      font-size: 0.82rem;
      padding-bottom: 14px;
    }

    @media (max-width: 720px) {
      main { padding: 12px; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .participants { grid-template-columns: 1fr; }
      .tables { grid-template-columns: 1fr; }
      .controls { grid-template-columns: 1fr; }
      .facts { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <main id="app"></main>
  <script id="initial-snapshot" type="application/json">${escapeScriptJson(JSON.stringify(snapshot))}</script>
  <script>
    const initialSnapshot = JSON.parse(document.getElementById("initial-snapshot").textContent);
    const app = document.getElementById("app");
    const tone = (value) => String(value || "unknown").toLowerCase().replace(/_/g, "-");
    const text = (value) => value === null || value === undefined || value === "" ? "missing" : String(value);
    const number = (value) => typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "missing";
    const minutes = (value) => typeof value === "number" ? (value <= 0 ? "ready" : value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "m") : "missing";
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
    const esc = (value) => text(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const badge = (value, label = value) => "<span class=\\"badge " + tone(value) + "\\">" + esc(String(label).replace(/_/g, " ")) + "</span>";
    const metric = (label, value, klass = "") => "<article class=\\"metric\\"><span>" + esc(label) + "</span><strong class=\\"" + klass + "\\">" + esc(value) + "</strong></article>";

    function render(snapshot) {
      const summary = snapshot.summary || {};
      const participants = [...(snapshot.participants || [])].sort((a, b) => {
        const active = Number(Boolean(b.activeJobId)) - Number(Boolean(a.activeJobId));
        if (active) return active;
        return (a.nextTurnInMinutes ?? 999999) - (b.nextTurnInMinutes ?? 999999);
      });
      const organs = snapshot.orchestrator?.organs || [];
      const events = snapshot.recentEvents || [];
      const controls = snapshot.controls || {};
      app.innerHTML = [
        "<header>",
          "<div class=\\"topline\\">" + badge(summary.state) + "<span>Generated " + esc(relative(snapshot.generatedAt)) + "</span><span class=\\"mono\\">" + esc(snapshot.cultMesh?.schemaId) + "</span></div>",
          "<h1>VoidBot Swarm State</h1>",
          "<p class=\\"muted\\">CTB scheduler state, rendered from the local status files and mirrored as a CultCache snapshot for CultMesh. Controls write only explicit scheduler commands.</p>",
        "</header>",
        "<section class=\\"summary\\">",
          metric("Participants", number(summary.participantCount)),
          metric("Active turns", number(summary.activeTurnCount)),
          metric("Pending mentions", number(summary.pendingMentionCount)),
          metric("Ready now", number(summary.readyNowCount)),
          metric("Next", summary.nextDisplayName ? summary.nextDisplayName : "missing"),
          metric("Next turn", minutes(summary.nextTurnInMinutes)),
          metric("Global heat", number(summary.globalHeat)),
          metric("Cadence", "x" + number(summary.cadenceMultiplier)),
          metric("Shuffle", summary.lastShuffle ? summary.lastShuffle.kind.replace(/_/g, " ") : "none"),
          metric("CultMesh", snapshot.cultMesh?.writeStatus || "missing"),
        "</section>",
        "<section><h2>Controls</h2><div class=\\"controls\\">",
          "<div class=\\"control-block\\"><div class=\\"muted\\">Heartbeat cadence multiplier</div><div class=\\"control-row\\"><input id=\\"cadence-input\\" type=\\"range\\" min=\\"0.1\\" max=\\"12\\" step=\\"0.1\\" value=\\"" + esc(controls.cadenceMultiplier || 1) + "\\"><strong id=\\"cadence-value\\" class=\\"mono\\">x" + esc(number(controls.cadenceMultiplier || 1)) + "</strong><button id=\\"cadence-apply\\">Apply</button></div></div>",
          "<div class=\\"control-block\\"><div class=\\"muted\\">Manual next turn</div><div class=\\"control-row\\"><select id=\\"force-identity\\">" + participants.map((agent) => "<option value=\\"" + esc(agent.identityId) + "\\">" + esc(agent.displayName) + " / " + esc(agent.repoName) + "</option>").join("") + "</select><button id=\\"force-turn\\">Pull Forward</button></div><div class=\\"repo\\">Latest request: " + esc((controls.manualTurnRequests || [])[0]?.identityId || "none") + " " + esc((controls.manualTurnRequests || [])[0]?.status || "") + "</div></div>",
        "</div></section>",
        "<section><h2>CTB Timeline</h2>",
          renderTimeline(snapshot.upcomingTurns || []),
        "</section>",
        "<section>",
          "<h2>Agents</h2>",
          "<div class=\\"participants\\">",
            participants.map(agentCard).join(""),
          "</div>",
        "</section>",
        "<div class=\\"tables\\">",
          "<section><h2>Orchestrator</h2><table><thead><tr><th>Organ</th><th>Status</th><th>Last run</th></tr></thead><tbody>",
            organs.length ? organs.map((organ) => "<tr><td>" + esc(organ.label) + "<div class=\\"repo\\">" + esc(organ.id) + "</div></td><td>" + badge(organ.lastStatus) + "</td><td>" + esc(relative(organ.lastFinishedAt || organ.lastStartedAt)) + "</td></tr>").join("") : "<tr><td colspan=\\"3\\" class=\\"muted\\">No orchestrator state.</td></tr>",
          "</tbody></table></section>",
          "<section><h2>Recent Events</h2><table><thead><tr><th>Event</th><th>Identity</th><th>When</th></tr></thead><tbody>",
            events.length ? events.slice(0, 16).map((event) => "<tr><td>" + esc(event.type) + (event.reason ? "<div class=\\"repo\\">" + esc(event.reason) + "</div>" : "") + "</td><td>" + esc(event.identityId || "") + "</td><td>" + esc(relative(event.observedAt)) + "</td></tr>").join("") : "<tr><td colspan=\\"3\\" class=\\"muted\\">No heartbeat events.</td></tr>",
          "</tbody></table></section>",
        "</div>",
        "<section><h2>State Files</h2><table><tbody>",
          row("Heartbeat", snapshot.sources?.heartbeatStatePath, snapshot.sources?.heartbeatStateReadable ? "ok" : "missing"),
          row("Orchestrator", snapshot.sources?.orchestratorPath, snapshot.sources?.orchestratorReadable ? "ok" : "missing"),
          row("Pause flag", snapshot.sources?.pausePath, snapshot.sources?.pauseReadable ? (summary.paused ? "paused" : "ok") : "missing"),
          row("CultMesh store", snapshot.cultMesh?.storePath, snapshot.cultMesh?.writeStatus),
        "</tbody></table></section>",
        "<div class=\\"footer\\">This page polls <code>swarm-state.json</code> every 10 seconds when served over HTTP. Controls write scheduler commands; heartbeat pulses own the actual turn mutation.</div>",
      ].join("");
      attachControls();
    }

    function renderTimeline(turns) {
      const cards = turns.map((turn) => {
        const klass = turn.activeJobId ? "turn-card active-turn" : "turn-card";
        return "<article class=\\"" + klass + "\\" title=\\"" + esc(turn.displayName + " / " + turn.repoName + " / " + minutes(turn.nextTurnInMinutes)) + "\\">" + avatarHtml(turn) + "<strong>" + esc(turn.displayName) + "</strong><span class=\\"turn-time\\">" + esc(minutes(turn.nextTurnInMinutes)) + "</span>" + (turn.shuffleReason ? "<span class=\\"turn-reason\\">" + esc(turn.shuffleReason) + "</span>" : "") + "</article>";
      }).join("");
      return "<div class=\\"timeline\\"><div class=\\"timeline-track\\"><div class=\\"timeline-now\\"></div>" + cards + "</div></div>";
    }

    function avatarHtml(turn) {
      const initials = text(turn.displayName).split(/\\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
      return turn.avatarUrl
        ? "<div class=\\"avatar\\"><img src=\\"" + esc(turn.avatarUrl) + "\\" alt=\\"" + esc(turn.displayName) + "\\"></div>"
        : "<div class=\\"avatar\\">" + esc(initials || "?") + "</div>";
    }

    function agentCard(agent) {
      return [
        "<article class=\\"agent\\">",
          "<div class=\\"agent-head\\"><div><h3>" + esc(agent.displayName) + "</h3><div class=\\"repo\\">" + esc(agent.identityId) + " / " + esc(agent.repoName) + "</div></div>" + badge(agent.activeJobId ? "running" : agent.status) + "</div>",
          "<div class=\\"facts\\">",
            fact("Next", minutes(agent.nextTurnInMinutes)),
            fact("Load", number(agent.currentLoad)),
            fact("Speed", number(agent.effectiveSpeed)),
            fact("Heat", number(agent.heat)),
            fact("Queued", number(agent.queuedCount)),
            fact("Mentions", number(agent.pendingMentionCount)),
            fact("Channels", number(agent.channelCount)),
            fact("Last queued", relative(agent.lastQueuedAt)),
          "</div>",
          agent.activeJobId ? "<div class=\\"repo\\">active " + esc(agent.activeJobId) + "</div>" : "",
        "</article>",
      ].join("");
    }

    function fact(label, value) {
      return "<div class=\\"fact\\"><span>" + esc(label) + "</span><strong>" + esc(value) + "</strong></div>";
    }

    function row(label, value, state) {
      return "<tr><th>" + esc(label) + "</th><td class=\\"mono\\">" + esc(value) + "</td><td>" + badge(state || "unknown") + "</td></tr>";
    }

    function attachControls() {
      const cadenceInput = document.getElementById("cadence-input");
      const cadenceValue = document.getElementById("cadence-value");
      const cadenceApply = document.getElementById("cadence-apply");
      const forceSelect = document.getElementById("force-identity");
      const forceButton = document.getElementById("force-turn");
      if (cadenceInput && cadenceValue) {
        cadenceInput.addEventListener("input", () => cadenceValue.textContent = "x" + Number(cadenceInput.value).toLocaleString(undefined, { maximumFractionDigits: 1 }));
      }
      if (cadenceApply && cadenceInput) {
        cadenceApply.addEventListener("click", async () => {
          await postJson("/api/controls", { cadenceMultiplier: Number(cadenceInput.value) });
          await refresh();
        });
      }
      if (forceButton && forceSelect) {
        forceButton.addEventListener("click", async () => {
          await postJson("/api/turns/force", { identityId: forceSelect.value });
          await refresh();
        });
      }
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Control request failed.");
      }
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

async function serveDashboard({ host, port, rootDir, refreshSeconds }) {
  const interval = setInterval(async () => {
    try {
      await render();
    } catch (error) {
      console.error(`Swarm dashboard refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, Math.max(refreshSeconds, 2) * 1000);
  interval.unref();

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "POST" && requestUrl.pathname === "/api/controls") {
        await handleControlUpdate(request, response);
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/turns/force") {
        await handleForceTurn(request, response);
        return;
      }
      const pathname = requestUrl.pathname === "/" ? "/swarm-dashboard.html" : decodeURIComponent(requestUrl.pathname);
      const target = resolve(rootDir, `.${pathname}`);
      if (!target.startsWith(rootDir)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const fileStat = await stat(target);
      if (!fileStat.isFile()) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": contentType(target),
        "cache-control": "no-store",
      });
      response.end(await readFile(target));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise((resolveServer) => server.listen(port, host, resolveServer));
  console.log(`Swarm dashboard serving ${rootDir}`);
  for (const url of localUrls(port, host)) {
    console.log(url);
  }
}

async function handleControlUpdate(request, response) {
  if (args.public) {
    writeJsonResponse(response, 403, { ok: false, error: "Controls are disabled in public mode." });
    return;
  }
  const body = await readRequestJson(request);
  const multiplier = Number(body.cadenceMultiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0.1 || multiplier > 12) {
    writeJsonResponse(response, 400, { ok: false, error: "cadenceMultiplier must be between 0.1 and 12." });
    return;
  }
  const state = await readMutableHeartbeatState();
  state.controls = normalizeDashboardControls(state.controls);
  state.controls.cadenceMultiplier = Math.round(multiplier * 100) / 100;
  state.controls.updatedAt = new Date().toISOString();
  await writeMutableHeartbeatState(state);
  await render();
  writeJsonResponse(response, 200, { ok: true, controls: state.controls });
}

async function handleForceTurn(request, response) {
  if (args.public) {
    writeJsonResponse(response, 403, { ok: false, error: "Controls are disabled in public mode." });
    return;
  }
  const body = await readRequestJson(request);
  const identityId = typeof body.identityId === "string" ? body.identityId.trim() : "";
  if (!identityId) {
    writeJsonResponse(response, 400, { ok: false, error: "identityId is required." });
    return;
  }
  const state = await readMutableHeartbeatState();
  state.controls = normalizeDashboardControls(state.controls);
  state.controls.manualTurnRequests.push({
    id: randomUUID(),
    identityId,
    requestedAt: new Date().toISOString(),
    status: "pending",
    note: "Requested from swarm dashboard.",
  });
  state.controls.manualTurnRequests = state.controls.manualTurnRequests.slice(-20);
  state.controls.updatedAt = new Date().toISOString();
  await writeMutableHeartbeatState(state);
  await render();
  writeJsonResponse(response, 200, { ok: true, controls: state.controls });
}

async function readMutableHeartbeatState() {
  const parsed = await readJsonFile(heartbeatStatePath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    throw new Error(`Cannot read heartbeat state at ${heartbeatStatePath}`);
  }
  return parsed.value;
}

async function writeMutableHeartbeatState(state) {
  await mkdir(dirname(heartbeatStatePath), { recursive: true });
  await writeFile(heartbeatStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeDashboardControls(value) {
  const controls = value && typeof value === "object" ? value : {};
  return {
    cadenceMultiplier: Math.min(12, Math.max(0.1, Number(controls.cadenceMultiplier) || 1)),
    manualTurnRequests: Array.isArray(controls.manualTurnRequests) ? controls.manualTurnRequests : [],
    updatedAt: typeof controls.updatedAt === "string" ? controls.updatedAt : undefined,
  };
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 64 * 1024) {
      throw new Error("Request body is too large.");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function writeJsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function contentType(path) {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".cc":
      return "application/octet-stream";
    default:
      return "text/plain; charset=utf-8";
  }
}

function localUrls(port, host) {
  const urls = [];
  if (host === "127.0.0.1" || host === "localhost") {
    urls.push(`http://127.0.0.1:${port}/`);
    return urls;
  }
  urls.push(`http://127.0.0.1:${port}/`);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}/`);
      }
    }
  }
  return [...new Set(urls)];
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
