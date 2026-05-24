# VoidBot Swarm Web Interface

This is the read-only swarm visibility surface for iPad or LAN use.

## Owner

`scripts/render-voidbot-swarm-dashboard.mjs` owns the projection. It reads the existing state owners:

- `.voidbot/status/repo-face-heartbeats.json`
- `.voidbot/status/gamecult-orchestrator.json`
- `state/agent-swarm-paused.json`

It writes:

- `.voidbot/status/swarm-state.json`
- `.voidbot/status/swarm-dashboard.html`
- `.voidbot/status/cultmesh/voidbot-swarm-state.cc`

The `.cc` file is a CultCache snapshot document with schema id `voidbot.swarm_state_snapshot.v1`. CultMesh should distribute that document when a live mesh bridge is installed.

The app controls do not edit the turn queue directly. They write a small `controls` object into the heartbeat state:

- `cadenceMultiplier`: multiplies scheduler heat on the next heartbeat pulse.
- `manualTurnRequests`: asks the scheduler to pull a Face forward on the next pulse.

The heartbeat runner owns the actual mutation. Direct mentions, manual pull-forward requests, and the resulting upcoming CTB order are mirrored back into `swarm-state.json` and the CultCache snapshot so the app is seeing state, not guessing from DOM tricks.

## Local iPad Use

From `E:\Projects\VoidBot`:

```powershell
npm run swarm:dashboard
```

Open the LAN URL printed by the command on the iPad. The server refreshes the snapshot every 10 seconds and serves a fullscreen single-viewport SPA from `.voidbot/status`.

The CTB strip is intentionally compact: avatar icons show upcoming Face turns in scheduler order. It occupies the long side of the viewport: top edge in landscape, left edge in portrait. A direct mention should appear as a shuffle in the mirrored snapshot once the heartbeat state records the pending obligation or queued turn.

The graph surface is the interface, not decoration. Face nodes represent scheduler participants. UI facts and controls are graph nodes too: the cadence node contains the slider, the manual-turn node contains the selector/button, status/count nodes show their live values, and the selected-Face node carries the currently focused participant facts. The SPA starts from a deterministic force-style layout, then runs a DOM-aware settle pass so spring-attached UI nodes stay near the viewport center while avoiding rendered graph content.

For a one-shot render without serving:

```powershell
npm run swarm:render-dashboard
```

## Public Hosting Shape

`voidbot.gamecult.org` should not expose raw private state. Publish `swarm-state.json`, `swarm-dashboard.html`, and the CultCache snapshot only after deciding the access model:

- public redacted view, if agent names, job ids, paths, and timing are acceptable
- private nginx/Heimdall-gated view, if the operational paths and job ids are sensitive
- Quartz-hosted static shell plus a separately synced redacted snapshot, if the domain should behave like the other GameCult static sites

Do not make the public site read Face `.cc` files directly. The exporter is the redaction boundary.

For public/static output, render with:

```powershell
node scripts/render-voidbot-swarm-dashboard.mjs --public --out .voidbot/status/public-swarm-dashboard.html --snapshot .voidbot/status/public-swarm-state.json --cultmeshStore .voidbot/status/cultmesh/public-voidbot-swarm-state.cc
```
