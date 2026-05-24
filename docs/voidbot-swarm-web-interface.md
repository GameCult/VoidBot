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

The `.cc` file is a CultCache snapshot document with schema id `voidbot.swarm_state_snapshot.v1`. CultMesh should distribute that document when a live mesh bridge is installed. The web page is only a reader.

## Local iPad Use

From `E:\Projects\VoidBot`:

```powershell
npm run swarm:dashboard
```

Open the LAN URL printed by the command on the iPad. The server refreshes the snapshot every 10 seconds and serves the static page from `.voidbot/status`.

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
