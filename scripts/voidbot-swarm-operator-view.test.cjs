"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { operatorViewPublication, projectSwarmOperatorView, readSwarmOperatorInputs, watchSwarmOperatorInputs } = require("./voidbot-swarm-operator-view.cjs");

test("projects bounded operator state and lets control own heat", () => {
  const view = projectSwarmOperatorView({
    heartbeat: {
      globalHeat: 0.5,
      initiativeClock: 12,
      lastTickAt: "2026-07-15T10:00:00.000Z",
      pendingMentions: [{ identityId: "eve" }],
      participants: [
        { identityId: "eve", displayName: "Eve", status: "active", nextTurnInMinutes: 3, heat: 1.2 },
        { identityId: "odin", displayName: "Odin", status: "active", activeJobId: "job-1", nextTurnInMinutes: 8 },
      ],
    },
    orchestrator: { organs: { heartbeat: { label: "Heartbeat", lastStatus: "ok", lastDurationSeconds: 2 } } },
    pause: { paused: false },
    control: { globalHeat: 0.85 },
    observedAt: "2026-07-15T10:01:00.000Z",
    sources: { heartbeat: { readable: true }, orchestrator: { readable: true } },
  });

  assert.equal(view.version, "voidbot.swarm_operator_view.v1");
  assert.equal(view.summary.activeTurnCount, 1);
  assert.equal(view.summary.pendingMentionCount, 1);
  assert.equal(view.summary.nextIdentityId, "eve");
  assert.equal(view.queue[0].heat, 0.85);
  assert.equal(view.selectedFace.identityId, "eve");
  assert.equal(view.recentEvents, undefined);
});

test("publication exposes the typed record without dashboard-shaped authority", () => {
  const value = projectSwarmOperatorView({
    heartbeat: null,
    orchestrator: null,
    pause: { paused: true, reason: "maintenance" },
    control: null,
    sources: { heartbeat: { readable: false }, orchestrator: { readable: false } },
  });
  const publication = operatorViewPublication(value);
  assert.equal(publication.publicationId, "voidbot.swarm.operator-view");
  assert.equal(publication.documentType, "voidbot.swarm_operator_view");
  assert.equal(publication.schemaId, "voidbot.swarm_operator_view.v1");
  assert.equal(publication.recordKey, "voidbot-swarm");
  assert.equal(value.summary.state, "missing");
  assert.equal(value.selectedFace, null);
});

test("reads source files independently and reports a missing owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voidbot-operator-view-"));
  try {
    const heartbeat = path.join(root, "heartbeat.json");
    await fs.writeFile(heartbeat, JSON.stringify({ participants: [] }));
    const inputs = await readSwarmOperatorInputs({
      heartbeat,
      orchestrator: path.join(root, "missing.json"),
      pause: path.join(root, "pause.json"),
    });
    assert.deepEqual(inputs.heartbeat, { participants: [] });
    assert.equal(inputs.sources.heartbeat.readable, true);
    assert.equal(inputs.sources.orchestrator.readable, false);
    assert.equal(inputs.control, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("watches atomic source replacement without polling", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voidbot-operator-watch-"));
  const target = path.join(root, "heartbeat.json");
  await fs.writeFile(target, "{}");
  let stop = () => {};
  try {
    const changed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("source watcher did not observe replacement")), 2000);
      stop = watchSwarmOperatorInputs({ heartbeat: target }, () => {
        clearTimeout(timeout);
        resolve();
      }, { debounceMs: 10 });
    });
    const replacement = path.join(root, "heartbeat.next.json");
    await fs.writeFile(replacement, '{"state":"ready"}');
    await fs.rename(replacement, target);
    await changed;
  } finally {
    stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
