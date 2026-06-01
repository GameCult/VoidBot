# VoidBot Swarm Web Interface

This is the VoidBot swarm Eve/CultUI surface. The browser page is only a local
debug lowering.

## Owner

`scripts/render-voidbot-swarm-dashboard.mjs` owns the projection. It reads the existing state owners:

- `.voidbot/status/repo-face-heartbeats.json`
- `.voidbot/status/gamecult-orchestrator.json`
- `state/agent-swarm-paused.json`

It writes:

- `.voidbot/status/swarm-state.json`
- `.voidbot/status/swarm-dashboard.html`
- `.voidbot/status/cultmesh/voidbot-swarm-state.cc`

The `.cc` file is the CultMesh publication point. It must contain:

- `voidbot.swarm_state_snapshot.v1` keyed as `voidbot-swarm`
- `gamecult.eve.provider_advertisement.v1` keyed as `voidbot.swarm`
- `gamecult.eve.surface_state.v1` keyed as `voidbot.swarm`
- `gamecult.eve.interface_binding.v1` keyed as `voidbot.swarm`

The invariant is blunt: if the swarm surface exists, the Eve interface binding
must be advertised through CultMesh. There is no network web server for swarm
state or controls. Static HTML may be rendered as a local debug artifact, but
the Verse-facing API/GUI/TUI surface is the CultMesh binding.

The app controls do not edit the turn queue directly. They write a small `controls` object into the heartbeat state:

- `cadenceMultiplier`: multiplies scheduler heat on the next heartbeat pulse.
- `manualTurnRequests`: asks the scheduler to pull a Face forward on the next pulse.

The heartbeat runner owns the actual mutation. Direct mentions, manual pull-forward requests, and the resulting upcoming CTB order are mirrored back into `swarm-state.json` and the CultCache snapshot so the app is seeing state, not guessing from DOM tricks.

## Local Publishing

From `E:\Projects\VoidBot`:

```powershell
npm run swarm:render-dashboard
```

This writes the CultMesh documents and a static debug artifact under
`.voidbot/status`. Eve, Odin, Nightwing, and future clients should consume
`gamecult.eve.interface_binding.v1` for `voidbot.swarm` from CultMesh instead
of a web endpoint.

The CTB strip is intentionally compact: avatar icons show upcoming Face turns in scheduler order. It occupies the long side of the viewport: top edge in landscape, left edge in portrait. A direct mention should appear as a shuffle in the mirrored snapshot once the heartbeat state records the pending obligation or queued turn.

The main viewport is a direct cockpit: summary, controls, participant list, selected-Face detail, and recent mesh events. The screen should be readable first and clever never. A tiny square HUD sits opposite the CTB rail, using compressed two-column health-bar debug readouts for watchdog, orchestrator, Face heartbeat, mood, rumination, mesh status, heartbeat age, and selected turn.

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
