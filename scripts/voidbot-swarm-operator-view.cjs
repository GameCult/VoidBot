"use strict";

const fs = require("fs");
const pathModule = require("path");

const SCHEMA_ID = "voidbot.swarm_operator_view.v1";
const RECORD_KEY = "voidbot-swarm";

function projectSwarmOperatorView({ heartbeat, orchestrator, pause, control, observedAt = new Date().toISOString(), sources = {}, route = {} }) {
  const initiativeClock = number(heartbeat?.initiativeClock);
  const participants = array(heartbeat?.participants).map((participant) => {
    const identityId = text(participant?.identityId) || "unknown";
    const pendingMentionCount = array(heartbeat?.pendingMentions)
      .filter((mention) => text(mention?.identityId) === identityId).length;
    return {
      identityId,
      displayName: text(participant?.displayName) || identityId,
      repoName: text(participant?.repoName) || "unknown",
      status: text(participant?.status) || "unknown",
      activeJobId: text(participant?.activeJobId),
      nextTurnInMinutes: number(participant?.nextTurnInMinutes) ?? subtract(number(participant?.nextTurnAt), initiativeClock),
      heat: number(participant?.heat),
      avatarUri: text(participant?.avatarUri) || text(participant?.avatarUrl),
      memoryCount: number(participant?.memoryCount) ?? array(participant?.memories).length,
      pressureCount: array(participant?.responsePressureEvidence).length,
      description: text(participant?.description),
      statePath: text(participant?.statePath) || text(participant?.faceStatePath),
      statePreview: preview(participant?.statePreview),
      channels: array(participant?.channelPermissions).slice(0, 8).map((channel) => ({
        label: text(channel?.label) || text(channel?.channelName) || "channel",
        speedMultiplier: number(channel?.speedMultiplier) ?? 1,
        speechThreshold: text(channel?.speechThreshold) || "threshold",
        topic: text(channel?.topic) || "no topic",
      })),
      pendingMentionCount,
    };
  });
  const organs = Object.entries(object(orchestrator?.organs)).map(([id, organ]) => ({
    id,
    label: text(organ?.label) || id,
    status: text(organ?.lastStatus) || "unknown",
    lastFinishedAt: text(organ?.lastFinishedAt),
    durationSeconds: number(organ?.lastDurationSeconds),
  }));
  const activeTurnCount = participants.filter((participant) => participant.activeJobId).length;
  const readyNowCount = participants.filter((participant) =>
    participant.status === "active" && !participant.activeJobId && participant.nextTurnInMinutes !== null && participant.nextTurnInMinutes <= 0,
  ).length;
  const paused = pause?.paused === true;
  const heartbeatReadable = sources.heartbeat?.readable !== false;
  const orchestratorReadable = sources.orchestrator?.readable !== false;

  const nextTurn = selectNextTurn(participants);
  const selected = participants.find((participant) => participant.identityId === nextTurn?.identityId) ?? participants[0] ?? null;
  const surfaceOrgan = object(orchestrator?.organs)["voidbot-swarm-surface"];
  const cultMeshServer = object(surfaceOrgan?.cultMeshServer);
  const alerts = buildAlerts({ sources, organs });
  return {
    version: SCHEMA_ID,
    observedAt,
    summary: {
      state: deriveSwarmState({ heartbeatReadable, paused, activeTurnCount, organs }),
      paused,
      participantCount: participants.length,
      activeTurnCount,
      readyNowCount,
      pendingMentionCount: array(heartbeat?.pendingMentions).length,
      nextIdentityId: nextTurn?.identityId ?? null,
      nextDisplayName: nextTurn?.displayName ?? null,
      lastTickAt: text(heartbeat?.lastTickAt),
    },
    route: {
      storeWriteStatus: text(route.storeWriteStatus) || "ok",
      providerStatus: text(route.providerStatus) || "unknown",
      odinStatus: text(route.odinStatus) || text(cultMeshServer.status) || deriveOrchestratorState(organs, orchestratorReadable),
      endpoint: text(route.endpoint) || text(cultMeshServer.bind),
      lastAnnouncementAt: text(route.lastAnnouncementAt) || text(surfaceOrgan?.lastFinishedAt),
      alerts,
    },
    queue: [...participants]
      .sort((left, right) => nullableOrder(left.nextTurnInMinutes, right.nextTurnInMinutes))
      .map((participant, slot) => ({
        slot: slot + 1,
        identityId: participant.identityId,
        displayName: participant.displayName,
        repoName: participant.repoName,
        state: participant.activeJobId ? "active" : participant.status,
        nextTurnInMinutes: participant.nextTurnInMinutes,
        heat: number(control?.globalHeat) ?? participant.heat ?? number(heartbeat?.globalHeat),
        label: participant.displayName,
        status: participant.activeJobId ? "active" : participant.status,
        detail: `${participant.repoName} · ${formatTurnDistance(participant.nextTurnInMinutes)}`,
        badges: compact([
          participant.heat === null ? null : `heat ${participant.heat}`,
          participant.pendingMentionCount > 0 ? `${participant.pendingMentionCount} mention${participant.pendingMentionCount === 1 ? "" : "s"}` : null,
        ]),
      })),
    selectedFace: selected ? {
      identityId: selected.identityId,
      displayName: selected.displayName,
      repoName: selected.repoName,
      avatarUri: selected.avatarUri,
      status: selected.status,
      nextTurnInMinutes: selected.nextTurnInMinutes,
      heat: number(control?.globalHeat) ?? selected.heat ?? number(heartbeat?.globalHeat),
      memoryCount: selected.memoryCount,
      pressureCount: selected.pressureCount,
      description: selected.description,
      statePath: selected.statePath,
      statePreview: selected.statePreview,
      channels: selected.channels.map((channel) => ({
        label: channel.label,
        status: `${channel.speechThreshold} / x${channel.speedMultiplier}`,
        detail: channel.topic,
      })),
    } : null,
    operations: {
      summary: `organs ${organs.length} / ${deriveOrchestratorState(organs, orchestratorReadable)}`,
      items: organs
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((organ) => ({
          label: organ.label,
          status: organ.status,
          detail: compact([
            organ.lastFinishedAt ? `finished ${organ.lastFinishedAt}` : null,
            organ.durationSeconds === null ? null : `${organ.durationSeconds}s`,
          ]).join(" / "),
        })),
    },
    pressure: [...participants]
      .sort((left, right) => right.pressureCount - left.pressureCount || right.memoryCount - left.memoryCount || left.displayName.localeCompare(right.displayName))
      .slice(0, 6)
      .map((participant) => ({
        label: participant.displayName,
        status: `pressure ${participant.pressureCount}`,
        detail: `memory ${participant.memoryCount} / heat ${participant.heat ?? "?"}`,
      })),
    mentions: array(heartbeat?.pendingMentions).slice(0, 6).map((mention) => ({
      label: text(mention?.identityId) || "face",
      status: "pending",
      detail: compact([text(mention?.createdAt) || text(mention?.queuedAt), text(mention?.prompt)]).join(" / "),
    })),
    recentEvents: array(heartbeat?.history).slice(-8).reverse().map((event) => ({
      label: text(event?.type) || "event",
      status: text(event?.identityId) || "swarm",
      detail: compact([
        text(event?.observedAt) || text(event?.queuedAt) || text(event?.consumedAt) || text(event?.appliedAt),
        text(event?.reason) || text(event?.statusPath),
      ]).join(" / "),
    })),
  };
}

async function readSwarmOperatorInputs(paths) {
  const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
    try {
      const [raw, stats] = await Promise.all([
        fs.promises.readFile(path, "utf8"),
        fs.promises.stat(path),
      ]);
      return [key, { value: JSON.parse(raw), status: { readable: true, updatedAt: stats.mtime.toISOString() } }];
    } catch (error) {
      return [key, { value: null, status: { readable: false, error: error instanceof Error ? error.message : String(error) } }];
    }
  }));
  const read = Object.fromEntries(entries);
  return {
    heartbeat: read.heartbeat.value,
    orchestrator: read.orchestrator.value,
    pause: read.pause.value,
    control: read.control?.value ?? null,
    sources: Object.fromEntries(Object.entries(read).map(([key, result]) => [key, result.status])),
  };
}

function watchSwarmOperatorInputs(paths, onChange, { debounceMs = 75 } = {}) {
  const watched = [...new Set(Object.values(paths).map((value) => pathModule.resolve(value)))];
  const byDirectory = new Map();
  for (const path of watched) {
    const directory = pathModule.dirname(path);
    const names = byDirectory.get(directory) ?? new Set();
    names.add(pathModule.basename(path).toLowerCase());
    byDirectory.set(directory, names);
  }
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      Promise.resolve(onChange()).catch(() => {});
    }, debounceMs);
    timer.unref?.();
  };
  const watchers = [...byDirectory].map(([directory, names]) => fs.watch(directory, { persistent: false }, (_event, filename) => {
    if (filename === null || names.has(String(filename).toLowerCase())) schedule();
  }));
  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

function operatorViewPublication(value) {
  return {
    publicationId: "voidbot.swarm.operator-view",
    documentType: "voidbot.swarm_operator_view",
    schemaId: SCHEMA_ID,
    recordKey: RECORD_KEY,
    value,
  };
}

function deriveSwarmState({ heartbeatReadable, paused, activeTurnCount, organs }) {
  if (!heartbeatReadable) return "missing";
  if (paused) return "paused";
  if (organs.some((organ) => ["failed", "error", "stalled"].includes(organ.status))) return "warning";
  if (activeTurnCount > 0) return "running";
  return "ready";
}

function deriveOrchestratorState(organs, readable) {
  if (!readable || organs.length === 0) return "missing";
  if (organs.some((organ) => ["failed", "error", "stalled"].includes(organ.status))) return "warning";
  if (organs.some((organ) => organ.status === "running")) return "running";
  return "ready";
}

function selectNextTurn(participants) {
  const next = [...participants]
    .filter((participant) => participant.nextTurnInMinutes !== null)
    .sort((left, right) => left.nextTurnInMinutes - right.nextTurnInMinutes)[0];
  return next ? {
    identityId: next.identityId,
    displayName: next.displayName,
    inMinutes: next.nextTurnInMinutes,
  } : null;
}

function buildAlerts({ sources, organs }) {
  const alerts = [];
  for (const [source, status] of Object.entries(sources)) {
    if (status?.readable === false) alerts.push({ code: `source.${source}.unreadable`, severity: "error", detail: text(status.error) || `${source} is unreadable` });
  }
  for (const organ of organs.filter((entry) => ["failed", "error", "stalled"].includes(entry.status))) {
    alerts.push({ code: `organ.${organ.id}.${organ.status}`, severity: "warning", detail: `${organ.label} is ${organ.status}` });
  }
  return alerts;
}

function array(value) { return Array.isArray(value) ? value : []; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" && value.trim() ? value : null; }
function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function subtract(left, right) { return left === null || right === null ? null : Math.round((left - right) * 1000) / 1000; }
function nullableOrder(left, right) { return left === null ? 1 : right === null ? -1 : left - right; }
function compact(values) { return values.filter((value) => value !== null); }
function formatTurnDistance(value) { return value === null ? "unscheduled" : value <= 0 ? "ready now" : `turn in ${value}m`; }
function preview(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

module.exports = {
  RECORD_KEY,
  SCHEMA_ID,
  operatorViewPublication,
  projectSwarmOperatorView,
  readSwarmOperatorInputs,
  watchSwarmOperatorInputs,
};
