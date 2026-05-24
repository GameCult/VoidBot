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
      --status-size: clamp(112px, 16vmin, 150px);
      --font: "Ubuntu", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --display: "Montserrat", "Ubuntu", ui-sans-serif, system-ui, sans-serif;
      --arcade: "Press Start 2P", "VT323", monospace;
      --mono: "SFMono-Regular", "Cascadia Mono", Consolas, monospace;
    }

    * { box-sizing: border-box; }
    html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; }
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
    h1, h2, h3, .kicker, .badge, .metric strong, .turn-card strong, .agent-row strong {
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
      display: grid;
      width: 100vw;
      height: 100dvh;
      background: rgba(3, 7, 13, 0.72);
    }

    .ctb-rail {
      display: flex;
      gap: 8px;
      padding: 10px;
      border-color: var(--line);
      background: rgba(3, 7, 13, 0.86);
      backdrop-filter: blur(18px);
      overflow: auto;
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
      min-width: 0;
      min-height: 0;
      display: grid;
      gap: 12px;
      padding: 12px;
      overflow: hidden;
      grid-template-columns: minmax(280px, 0.88fr) minmax(360px, 1.4fr) minmax(280px, 0.92fr);
      grid-template-rows: auto var(--status-size) minmax(0, 1fr);
      grid-template-areas:
        "header header controls"
        "queue detail status"
        "queue detail events";
    }

    .status-panel {
      width: var(--status-size);
      height: var(--status-size);
      grid-area: status;
      align-self: center;
      justify-self: center;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 7px;
      padding: 9px;
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
      gap: 5px 7px;
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
      font-size: 0.5rem;
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
      height: 5px;
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
    .header-pane { grid-area: header; align-content: center; }
    .controls-pane { grid-area: controls; align-content: center; }
    .queue-pane { grid-area: queue; }
    .detail-pane { grid-area: detail; }
    .events-pane { grid-area: events; }

    .kicker { color: var(--green); font-size: 0.74rem; text-transform: uppercase; }
    h1 { font-size: clamp(1.8rem, 5vw, 4rem); line-height: 0.95; }
    h2 { font-size: 1rem; text-transform: uppercase; }
    .muted { color: var(--muted); }
    .mono { font-family: var(--mono); }

    .metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
    .metric, .fact {
      min-width: 0;
      padding: 10px;
      border: 1px solid rgba(142, 223, 176, 0.12);
      border-radius: 8px;
      background: var(--panel-soft);
    }
    .metric span, .fact span { display: block; color: var(--muted); font-size: 0.68rem; font-weight: 800; text-transform: uppercase; }
    .metric strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.12rem; }
    .fact strong { display: block; overflow-wrap: anywhere; font: 0.9rem/1.15 var(--mono); }

    .control-grid { display: grid; gap: 10px; }
    .control-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .force-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }

    .queue-list, .event-list { display: grid; gap: 8px; overflow: auto; }
    .agent-row {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr) auto;
      gap: 9px;
      align-items: center;
      width: 100%;
      min-height: 58px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(142, 223, 176, 0.06);
      color: var(--text);
      text-align: left;
    }
    .agent-row.selected { border-color: var(--amber); }
    .agent-row strong, .agent-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-row span { color: var(--muted); font: 0.72rem/1.1 var(--mono); }

    .details-head { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 12px; align-items: center; }
    .details-head .avatar { width: 58px; height: 58px; }
    .facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .event-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 8px; border: 1px solid rgba(142, 223, 176, 0.1); border-radius: 8px; background: rgba(142, 223, 176, 0.05); color: var(--muted); font-size: 0.82rem; }

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
      .shell { grid-template-rows: var(--rail) minmax(0, 1fr); }
      .ctb-rail {
        grid-row: 1;
        grid-column: 1;
        flex-direction: row;
        align-items: center;
        border-bottom: 1px solid var(--line);
      }
      .workspace { grid-row: 2; grid-column: 1; }
      .turn-card { width: 76px; height: 96px; }
    }

    @media (orientation: portrait) {
      :root { --rail: 94px; }
      .shell { grid-template-columns: var(--rail) minmax(0, 1fr); }
      .ctb-rail {
        grid-row: 1;
        grid-column: 1;
        flex-direction: column;
        align-items: center;
        border-right: 1px solid var(--line);
      }
      .workspace {
        grid-row: 1;
        grid-column: 2;
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto auto var(--status-size) minmax(0, 1fr) minmax(0, 0.88fr);
        grid-template-areas:
          "header"
          "controls"
          "status"
          "detail"
          "queue";
      }
      .status-panel { justify-self: end; }
      .events-pane { display: none; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .turn-card { width: 72px; height: 96px; }
    }

    @media (max-width: 760px) {
      .workspace { padding: 10px; gap: 10px; }
      .pane { padding: 12px; }
      .header-pane .muted { display: none; }
      .controls-pane { align-content: start; }
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

    const tone = (value) => String(value || "unknown").toLowerCase().replace(/_/g, "-");
    const text = (value) => value === null || value === undefined || value === "" ? "missing" : String(value);
    const esc = (value) => text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    const initials = (value) => text(value).split(/\\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
    const badge = (value, label = value) => "<span class=\\"badge " + tone(value) + "\\">" + esc(String(label).replace(/_/g, " ")) + "</span>";

    function render(snapshot) {
      const participants = sortedParticipants(snapshot);
      if (!selectedIdentity || !participants.some((agent) => agent.identityId === selectedIdentity)) {
        selectedIdentity = (snapshot.upcomingTurns || [])[0]?.identityId || participants[0]?.identityId || null;
      }
      const selected = participants.find((agent) => agent.identityId === selectedIdentity) || participants[0] || null;
      app.innerHTML = [
        "<div class=\\"shell\\">",
          renderCtb(snapshot.upcomingTurns || []),
          "<section class=\\"workspace\\" aria-label=\\"VoidBot swarm control\\">",
            renderHeader(snapshot),
            renderControls(snapshot, participants),
            renderQueue(participants),
            renderDetails(selected),
            renderEvents(snapshot),
            renderStatusPanel(snapshot, selected),
          "</section>",
        "</div>",
      ].join("");
      attachControls();
      attachSelection();
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
        const klass = ["turn-card", turn.activeJobId ? "active-turn" : "", turn.pendingMentionCount > 0 ? "mention-turn" : ""].filter(Boolean).join(" ");
        return "<button class=\\"" + klass + "\\" type=\\"button\\" data-select=\\"" + esc(turn.identityId) + "\\" title=\\"" + esc(turn.displayName + " / " + minutes(turn.nextTurnInMinutes)) + "\\">" + avatarHtml(turn) + "<strong>" + esc(turn.displayName) + "</strong><span>" + esc(minutes(turn.nextTurnInMinutes)) + "</span>" + (turn.shuffleReason ? "<span class=\\"turn-reason\\">" + esc(turn.shuffleReason) + "</span>" : "") + "</button>";
      }).join("") + "</nav>";
    }

    function renderHeader(snapshot) {
      const summary = snapshot.summary || {};
      return "<header class=\\"pane header-pane\\"><p class=\\"kicker\\">VoidBot Swarm Control</p><h1>CTB Cockpit</h1><p class=\\"muted\\">CultMesh mirror and scheduler command surface. State comes from the heartbeat snapshot.</p><div class=\\"metrics\\">" +
        metric("State", badge(summary.state)) +
        metric("Participants", number(summary.participantCount)) +
        metric("Ready", number(summary.readyNowCount)) +
        metric("Mentions", number(summary.pendingMentionCount)) +
        metric("Shuffle", summary.lastShuffle ? summary.lastShuffle.kind.replace(/_/g, " ") : "none") +
      "</div></header>";
    }

    function renderControls(snapshot, participants) {
      const controls = snapshot.controls || {};
      const latest = (controls.manualTurnRequests || [])[0];
      return "<section class=\\"pane controls-pane\\"><p class=\\"kicker\\">Controls</p><div class=\\"control-grid\\">" +
        "<div><div class=\\"muted\\">Heartbeat cadence</div><div class=\\"control-row\\"><input id=\\"cadence-input\\" type=\\"range\\" min=\\"0.1\\" max=\\"12\\" step=\\"0.1\\" value=\\"" + esc(controls.cadenceMultiplier || 1) + "\\"><strong id=\\"cadence-value\\" class=\\"mono\\">x" + esc(number(controls.cadenceMultiplier || 1)) + "</strong></div><button id=\\"cadence-apply\\" type=\\"button\\">Apply</button></div>" +
        "<div><div class=\\"muted\\">Manual next turn</div><div class=\\"force-row\\"><select id=\\"force-identity\\">" + participants.map((agent) => "<option value=\\"" + esc(agent.identityId) + "\\">" + esc(agent.displayName) + " / " + esc(agent.repoName) + "</option>").join("") + "</select><button id=\\"force-turn\\" type=\\"button\\">Pull</button></div></div>" +
        "<div class=\\"mono muted\\">Latest request: " + esc(latest?.identityId || "none") + " " + esc(latest?.status || "") + "</div>" +
      "</div></section>";
    }

    function renderQueue(participants) {
      return "<section class=\\"pane queue-pane\\"><p class=\\"kicker\\">Participants</p><div class=\\"queue-list\\">" + participants.map((agent) => {
        const klass = "agent-row" + (agent.identityId === selectedIdentity ? " selected" : "");
        return "<button class=\\"" + klass + "\\" type=\\"button\\" data-select=\\"" + esc(agent.identityId) + "\\">" + avatarHtml(agent) + "<span><strong>" + esc(agent.displayName) + "</strong><span>" + esc(agent.identityId) + " / " + esc(agent.repoName) + "</span></span>" + badge(agent.activeJobId ? "running" : agent.status) + "</button>";
      }).join("") + "</div></section>";
    }

    function renderDetails(agent) {
      if (!agent) return "<section class=\\"pane detail-pane\\"><p class=\\"kicker\\">Selected Face</p><p class=\\"muted\\">No participant state.</p></section>";
      return "<section class=\\"pane detail-pane\\"><div class=\\"details-head\\">" + avatarHtml(agent) + "<div><p class=\\"kicker\\">Selected Face</p><h2>" + esc(agent.displayName) + "</h2><p class=\\"muted mono\\">" + esc(agent.identityId) + " / " + esc(agent.repoName) + "</p></div></div><div>" + badge(agent.activeJobId ? "running" : agent.status) + " " + (agent.pendingMentionCount > 0 ? badge("warning", "mention") : "") + "</div><div class=\\"facts\\">" +
        fact("Next", minutes(agent.nextTurnInMinutes)) +
        fact("Load", number(agent.currentLoad)) +
        fact("Speed", number(agent.effectiveSpeed)) +
        fact("Heat", number(agent.heat)) +
        fact("Queued", number(agent.queuedCount)) +
        fact("Mentions", number(agent.pendingMentionCount)) +
        fact("Channels", number(agent.channelCount)) +
        fact("Last queued", relative(agent.lastQueuedAt)) +
        fact("Job", agent.activeJobId || "none") +
      "</div></section>";
    }

    function renderEvents(snapshot) {
      const events = (snapshot.recentEvents || []).slice(0, 18);
      return "<section class=\\"pane events-pane\\"><p class=\\"kicker\\">Mesh Events</p><div class=\\"event-list\\">" + (events.length ? events.map((event) => "<div class=\\"event-row\\"><span>" + esc(event.type) + " " + esc(event.identityId || "") + "</span><span>" + esc(relative(event.observedAt)) + "</span></div>").join("") : "<p class=\\"muted\\">No recent events.</p>") + "</div></section>";
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

    function attachSelection() {
      document.querySelectorAll("[data-select]").forEach((element) => {
        element.addEventListener("click", () => {
          selectedIdentity = element.getAttribute("data-select");
          refresh();
        });
      });
    }

    function attachControls() {
      const cadenceInput = document.getElementById("cadence-input");
      const cadenceValue = document.getElementById("cadence-value");
      const cadenceApply = document.getElementById("cadence-apply");
      const forceSelect = document.getElementById("force-identity");
      const forceButton = document.getElementById("force-turn");
      if (forceSelect && selectedIdentity) forceSelect.value = selectedIdentity;
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
          selectedIdentity = forceSelect.value;
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
    window.addEventListener("orientationchange", () => setTimeout(refresh, 120));
    window.addEventListener("resize", () => window.requestAnimationFrame(() => refresh()));
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
