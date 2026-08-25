import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./render-voidbot-swarm-dashboard.mjs", import.meta.url), "utf8");

assert.match(source, /\.\.\.process\.env/, "the resident renderer must honor daemon process configuration");

test("the operator surface is composed from metrics and typed lists", () => {
  for (const componentId of [
    "voidbot-status-metrics",
    "live-queue-items",
    "metric-route-provider",
    "route-alerts",
    "metric-swarm-brake",
    "operations-items",
    "pressure-items",
    "pending-mention-items",
    "recent-event-items",
    "selected-channel-items",
  ]) assert.match(source, new RegExp(`\\b${componentId}\\b`));

  assert.match(source, /sourceId: "voidbot\.swarm_operator_view:voidbot-swarm"/);
  assert.match(source, /schemaId: "voidbot\.swarm_operator_view\.v1"/);
});

test("the migrated prose authorities cannot reappear in the surface", () => {
  for (const removedId of [
    "voidbot-status-line",
    "route-summary",
    "swarm-pause-status",
    "live-queue-empty",
    "watchdog-organ-",
    "pressure-face-",
    "pending-mention-0",
    "recent-event-0",
  ]) assert.doesNotMatch(source, new RegExp(`\\b${removedId}\\b`));
});
