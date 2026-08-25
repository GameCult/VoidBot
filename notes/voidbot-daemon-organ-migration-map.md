# VoidBot Daemon Organ Migration Map

Historical migration map observed 2026-07-16. Its resident full-stack target was lost with the retired Yggdrasil body; the current runtime is recorded below so this document cannot be mistaken for a startup inventory.

## Live Bodies

- Starfire `GameCult Local Orchestrator`: deleted from the repository; the previously installed task remains operational debris to remove if still present on Starfire.
- Starfire `Void Moderator Rumination`: disabled.
- Starfire `Void Mood Drift`: disabled.
- Starfire `VoidBot Operations Watchdog`: disabled.
- Starfire `Bifrost Agent Dispatch`: disabled.
- Yggdrasil `voidbot.service`: active; Compose runs only the typed `voidbot.swarm` Eve publisher at `127.0.0.1:17873`.
- Yggdrasil `voidbot-retrieval.service`: active as a separate bounded read-only recovery service.
- Discord bot, worker, Persona scheduler, Postgres, Qdrant, and resident cognition organs: not restored.

The disabled tasks are not standby owners. The historical organ rows below describe the intended ownership model, not live process evidence.

## Authority Map

| Organ | Target owner | Inputs | Outputs | Persistent state | Process supervision | Forbidden ownership |
|---|---|---|---|---|---|---|
| Persona initiative | VoidBot `persona-scheduler` | typed scheduler state, attention commands, Discord activity, Persona state, semantic pressure | approved Persona jobs and typed tick result | `repo-face-heartbeats.cc` plus attention inbox | `voidbot.service` / Compose | Windows scheduled tasks, per-pulse CLI children |
| Void moderation heartbeat | VoidBot daemon moderation organ | server rules, chronological Discord evidence, infringement history, typed open cases | typed moderation operations and parent-owned enforcement requests/receipts | `void-self-state.cc` | `voidbot.service` / Compose | Persona initiative, prompt child, Windows task |
| Void rumination | VoidBot daemon rumination organ | typed Mind, bounded chronological room evidence, doctrine/rules/voice, open obligations, speech receipts | typed Mind operations and candidate interventions; parent-owned delivery | `void-self-state.cc` | `voidbot.service` / Compose, independent disabled-by-default cadence | moderation heartbeat, Persona initiative, child model transport |
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

The Windows omnibus, installer, and hidden launcher are deleted, and watchdog logic cannot recognize them as health owners. Remaining per-organ Starfire tasks are operational debris, not standby paths; remove any installed copies rather than restoring repository launchers.

Revision `9deebb3` completed this historical source migration and removed the Starfire task husks. That deployment verdict is no longer current: the present Yggdrasil body runs no resident scheduler or cognition organs. Keep this map as an ownership contract for any explicitly authorized future recovery, not as proof that recovery already exists.
