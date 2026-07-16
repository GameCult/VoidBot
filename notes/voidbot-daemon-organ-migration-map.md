# VoidBot Daemon Organ Migration Map

Observed 2026-07-16 after the Yggdrasil replacement. This map distinguishes live process ownership from old scheduled-task documentation.

## Live Bodies

- Starfire `GameCult Local Orchestrator`: disabled.
- Starfire `Void Moderator Rumination`: disabled.
- Starfire `Void Mood Drift`: disabled.
- Starfire `VoidBot Operations Watchdog`: disabled.
- Starfire `Bifrost Agent Dispatch`: disabled.
- Yggdrasil `voidbot.service`: active; Compose runs the resident Persona scheduler.
- Yggdrasil Bifrost web: active, but no Bifrost dispatch worker was found in the queried service/container set.

The disabled tasks are not standby owners. The listed organs currently have no recurring pulse unless another independently supervised service is introduced.

## Authority Map

| Organ | Target owner | Inputs | Outputs | Persistent state | Process supervision | Forbidden ownership |
|---|---|---|---|---|---|---|
| Persona initiative | VoidBot `persona-scheduler` | typed scheduler state, attention commands, Discord activity, Persona state, semantic pressure | approved Persona jobs and typed tick result | `repo-face-heartbeats.cc` plus attention inbox | `voidbot.service` / Compose | Windows scheduled tasks, per-pulse CLI children |
| Void moderation heartbeat | VoidBot daemon moderation organ | server rules, chronological Discord evidence, infringement history, typed open cases | typed moderation operations and parent-owned enforcement requests/receipts | `void-self-state.cc` | `voidbot.service` / Compose | Persona initiative, prompt child, Windows task |
| Void rumination | VoidBot daemon rumination organ | typed Mind, room evidence, repo activity, open obligations, speech receipts | typed Mind operations and candidate interventions; parent-owned delivery | `void-self-state.cc` | `voidbot.service` / Compose | moderation heartbeat, Persona scheduler, child model |
| Void candidate delivery | VoidBot daemon candidate-delivery organ through shared Bifrost command port | targeted queued candidate, canonical speech receipts, Bifrost typed command route | one typed Discord command and completed receipt; candidate marked spoken only afterward | `void-self-state.cc` and Bifrost provider store | `voidbot.service` / Compose | rumination model, worker-local transport clone, direct Discord script |
| Void mood | VoidBot daemon physiology organ | typed affect/runtime documents, clock, active moderation witness | typed sleep and speaking-pressure operations; maintenance intent | `void-self-state.cc` | `voidbot.service` / Compose | memory maintenance, scheduler initiative, repair loops |
| Void memory maintenance | VoidBot daemon memory organ | typed short/durable memory, incubation, candidates, sleep intent | validated memory/incubation/candidate operations | `void-self-state.cc` | `voidbot.service` / Compose | mood organ, rumination child, editable JSON projections |
| Operations watchdog | Idunn/GameCult ops | systemd/Compose health, service endpoints, Postgres/Qdrant/Ollama, backup freshness | typed health witnesses, restart requests, operator notifications | Idunn/ops-owned health state; VoidBot may publish provider health | `idunn-yggdrasil.service` | VoidBot as sole self-health judge, Windows task |
| Bifrost dispatch | Bifrost daemon | Bifrost typed intake/work state and capability policy | claimed work, dispatch receipts, contributor/work transitions | Bifrost CultCache/provider store | Bifrost systemd/Compose service | VoidBot scheduler, Windows task |
| Swarm Eve projection | VoidBot swarm publisher | typed scheduler/control/provider state | Eve/CultMesh projection | derived provider store only | `voidbot.service` / Compose | static dashboard, Local Orchestrator |

## Shared Invariants

1. Each daemon organ owns one policy or transition family, not merely one interval.
2. The recurring clock only creates an observation opportunity. It cannot manufacture model intent.
3. Canonical Mind and moderation state remain typed CultCache `.cc`; JSON files are debug/status or xenos-boundary envelopes only.
4. Model children propose bounded operations. Parent organs validate, apply, deliver, and write receipts.
5. Mood may request memory maintenance but cannot perform memory policy itself.
6. Moderation and rumination share typed state and Discord evidence sources, but do not share decision authority.
7. Bifrost dispatch and operations supervision remain adjacent-service organs; moving them into VoidBot would hide ownership rather than repair it.
8. Deployment is upstream `main` to Idunn to Yggdrasil. No local deployment path may be created.

## Cut Sequence

1. Portable Void physiology is live in the daemon with injected typed state/moderation ports and maintenance intent; the Windows omnibus mood writer is deleted.
2. Portable memory maintenance is daemon-owned: physiology emits a typed nap intent; the memory organ owns bounded context projection, one text-model attempt per nap, whole-batch operation validation, typed application, and residue verification. The attempt receipt is committed before inference, so failure cannot become a periodic retry furnace.
3. Moderation heartbeat, enforcement, and person-shaped rumination are portable organs. Rumination may only emit typed operations and queued candidates; it cannot own transport.
4. Candidate delivery is a separate daemon organ and both it and worker Face speech use `postDiscordViaBifrostCultMesh`. Candidate delivery is enabled independently of model inference and closes state only after a completed typed Bifrost receipt.
5. Give Bifrost dispatch to a Bifrost-owned resident worker.
6. Give operations health/restart scheduling to Idunn and retain VoidBot health publication as provider-owned observation only.

## Deletion Line

After each target organ is live and verified on Yggdrasil, remove its definition from `run-gamecult-orchestrator.ps1` and stop watchdog logic from treating the disabled Local Orchestrator as a valid owner. The rebuild is incomplete while an old Windows path can still be re-enabled and produce the same decision independently.
