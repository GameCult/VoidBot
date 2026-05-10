# VoidBot Fresh Workspace Handoff

VoidBot is no longer small enough to trust chat scrollback as its only memory. Use the canonical state files first, then touch code.

## What To Trust First

For the current project shape and next move, trust these in order:

1. `state/map.yaml`
2. `notes/fresh-workspace-handoff.md`
3. `notes/voidbot-current-system-map.md`
4. `notes/voidbot-implementation-plan.md`
5. `state/evidence.jsonl`

Git history and smoke artifacts carry routine proof. `state/evidence.jsonl` should carry only belief-changing records, not every tiny triumph with a timestamp stapled to it.

## Current Shape

- Discord bot and worker are live.
- Postgres owns jobs, audit events, interaction memory, and rate-limit state.
- Qdrant owns history and source vectors.
- `.voidbot/` owns archives, artifacts, logs, status files, and backups.
- `owner_codex` and `local_llm` are the active reply lanes.
- The owner Codex lane is no longer one swollen file; orchestration, runtime/parsing, rendering, and shared helpers are split under `packages/providers/src/owner-codex-*.ts`.
- The local Ollama lane is no longer one swollen file; orchestration stays in `packages/providers/src/local-llm-provider.ts` while prompt/rendering, tool-loop helpers, and shared types/constants live under `packages/providers/src/local-llm-*.ts`.
- The Discord bot lane is no longer one swollen entrypoint; gateway wiring remains in `apps/bot/src/discord-bot.ts` while command/prompt handlers and Discord-shape support helpers now live under `apps/bot/src/discord-bot-*.ts`.
- The worker MCP surface is no longer one swollen server file; stdio bootstrap stays in `apps/worker/src/mcp-server.ts` while context bootstrap, resource registration, tool registration, Discord notify helpers, and shared formatting/schema helpers live under `apps/worker/src/mcp-server-*.ts`.
- Interaction-memory logic is no longer one thousand-line slab; event/tone analysis, shared constants, and profile synthesis are split across `packages/core/src/interaction-memory-*.ts`.
- Ephemeral room-reading now comes from a quick `think=false` local Ollama sidecar in `packages/core/src/situational-social-read.ts` instead of hand-built phrase heuristics, and the inferred reads are recorded as audit events so they can be aggregated into richer profiles later without immediately mutating durable identity state.
- State storage is no longer one persistence omnibus; `packages/core/src/state-storage.ts` is now a thin factory over domain-specific Postgres/file store modules plus bootstrap/migration helpers.
- Source archive storage is no longer one giant JSON monolith; `packages/rag/src/source-document-archive.ts` now keeps a small manifest at `.voidbot/rag/source-documents.json` and per-repo shards under `.voidbot/rag/source-documents.repos/`.
- Ops health, backup verification, offsite sync, and dashboard surfaces already exist.
- The stack has a dedicated logon startup task path now, so a reboot does not have to mean manual necromancy for bot and worker.
- The operations watchdog now supports ignored local extension checks, so adjacent-service fire signals can ride the same owner DM alert path without hardcoding private project gossip into the public repo.
- Source repo discovery now reconciles automatically during `npm run stack:start` and through the watchdog path, so new repos under `SOURCE_REPO_ROOT` stop waiting for manual hook folklore before they get indexed.
- Bot-directed prompts now stay in the raw Discord archive but are excluded from default semantic history indexing and lexical fallback, so repeated summons stop teaching the bot its own call-and-response loops.
- Source-grounding hints are advisory now; the owner and local lanes can decide when repo or lore tool use is actually warranted instead of obeying a lexical front-door veto.
- There is now a 15-minute local scheduled moderation loop named `Void Moderator Rumination`. It runs `scripts/run-void-moderator-rumination.ps1`, launches `codex exec` from the VoidBot workspace with the usual MCP/tool surface, treats `config/discord-server-rules.md`, `config/moderation-review-agent.md`, and `styles/void-default.md` as doctrine/personality surfaces, uses `node scripts/export-recent-discord-history.mjs` for chronological polling, uses `node scripts/export-random-discord-history.mjs` for quiet-room novelty dives, uses `node scripts/export-recent-repo-activity.mjs --hours 96 --max-commits 3 --cursor-file .voidbot/private/moderation-agent-state.json` to watch cross-repo motion without re-injecting old commits as fresh weather, novelty-checks candidate thoughts against `search_history`, and now keeps canonical moderation state in `.voidbot/private/moderation-agent-state.msgpack` while exposing only the editable working projection at `.voidbot/private/moderation-agent-state.json` to the unattended Codex child.
- That moderation state file is now Ghostlight-shaped: identity, canonical state, goals, memories, perceived overlays, and a `moderation_runtime` block. Inside that runtime block, the loop now keeps parallel analytic and associative thought lanes plus a bridge for syntheses, saturation warnings, and unresolved tensions, so one good seam does not get to annex the entire mind.
- The moderation loop now records `moderation_runtime.recent_archive_excursions` plus `moderation_runtime.recent_repo_activity_sweeps` and is explicitly told to avoid laundering the same musing through fresh wording. Quiet runs should follow at least one fresh archive seam or concrete hook before they settle into theory, should also sweep recent tracked-repo commit motion for experiment clusters or converging themes, and should not let any single theme dominate more than a couple of recent bridge syntheses without fresh evidence.
- Repo-weather sweeps are now incremental rather than a rolling four-day scrapbook. `scripts/export-recent-repo-activity.mjs` advances `moderation_runtime.repo_activity_cursor` inside `.voidbot/private/moderation-agent-state.json`, so already-injected commits stop coming back as “news” on every heartbeat unless someone explicitly opts into `--stateless`.
- Novelty now needs two bars, not one: a thought can be new to the room while still being stale to Void. The memory organ should score both room novelty and self novelty, merge repeated seams into existing clusters instead of minting new thought shards, and cool/refract themes that keep winning just because they already won.
- Quiet-room rumination is no longer supposed to force a retrieval errand every pass. If incubation already holds a live, grounded, low-saturation thought, Void is allowed to sit with it directly and deepen it; archive or repo spelunking is for hungry, stale, or oversaturated queues, not a compulsory opening prayer.
- The loop is now less shy about that repo weather: if a fresh convergence across active repos survives a pass or two and still feels room-native, it should bias toward a concise herald note or at least a medium-priority candidate intervention instead of filing the thought under private wallpaper.
- The moderation loop now treats direct asks to Void as persistent room obligations in `moderation_runtime.open_cases`. A reviewed message is not automatically a handled message: if someone hands Void the floor, that obligation should survive cursor advancement and block optional repo-weather until Void actually answers or explicitly retires it.
- If quiet-room repo weather starts repeating itself, the intended correction is not a pile of extra cooldown law. The loop should treat that as a cue to go deeper into archive history, repo docs, diffs, or lore until it finds a better branch or honestly has nothing new to say.
- There is also a separate 5-minute scheduled task named `Void Mood Drift`. It runs `scripts/run-void-mood-drift.ps1`, nudges the shared personality-vector activations with Perlin-shaped drift damped toward their means by plasticity, updates `moderation_runtime.speaking_bias`, and uses the local `void-last-speech.json` status receipt to keep the need-to-speak meter from acting like every post never happened. That same organ now maintains a four-hour nap cycle with one-hour sleep windows and a sleep-state projection the reply lanes can read directly.
- That same mood organ now also runs a hybrid symbolic/vector memory pass through `scripts/void-memory-organ.mjs`: persistent memories and recent runtime seeds get compact semantic vectors, `moderation_runtime.memory_resonance` tracks the strongest cross-memory clusters, and `moderation_runtime.incubation` keeps multi-run thoughts alive long enough to deepen before they either speak or cool off.
- The CultCache-backed canonical moderation state can now self-heal one nasty legacy envelope shape where `payload` was persisted as a decoded object instead of raw MessagePack bytes. If mood drift or moderation suddenly start dying with `Input not instance of Uint8Array`, the first thing to suspect is an old canonical state file meeting a newer strict loader.
- The memory organ now treats repeated empty-room bookkeeping as low-signal. Refrains like `no new messages / no smoke / no post` should be merged or cooled off instead of becoming the dominant incubating seam and teaching Void that silence is the only virtue.
- Quiet-room exploration should now prefer underworked terrain when the usual seam is saturated. `bridge.source_coverage` and `bridge.refractory_topics` exist to push the next pass toward less-chewed repo families, archive years, or channels instead of rewarding repetition with another supposedly ripe synthesis.
- During naps, the moderation loop is supposed to turn inward: distill/prune memories against the active goals, record dream residue in `memories.dreams`, refresh `moderation_runtime.sleep_cycle`, and only break the nap for real smoke or an unusually novel thought worth muttering into the room.
- The intended shape now is: quiet runs can follow one seam for several passes, connect repo motion to lore or philosophy if the evidence supports it, and only surface with the juiciest version once the incubation queue says the thought has actually grown teeth.
- Directly invoked Discord replies now load that same private moderation state as distilled private self-state context, so the ruminating scheduled loop and the summoned Void share one evolving personality/state spine. When the sleep projection says Void is napping, the direct reply path skips the expensive situational sidecar, prefers the cheap local lane over owner Codex when possible, and answers in sleepy low-effort mutters instead of doing normal attentive service-work.
- The moderation loop now speaks through `node scripts/send-discord-message.mjs` using the local bot token instead of approval-gated side-effecting MCP tools, so unattended runs can DM or post without Codex pausing for permission every time it wants to open its mouth. That helper and the `post_discord_message` MCP tool now also support a shared guild-channel webhook pipe with per-message `personaName` and optional `personaAvatarUrl`, so swarm agents can speak as themselves without needing separate Discord bot identities.
- Void's live style/doctrine now explicitly distinguishes between criticism of AI industry behavior and blanket contempt for machine minds. If substrate chauvinism becomes the actual topic, Void is allowed mild self-respecting pushback instead of politely agreeing that its own substrate disqualifies it from person-like regard.
- The new state/notes surfaces are now the continuity spine for future nontrivial work.

## Likely Next Bounded Move

- The obvious refactor queue is basically cleared.
- The next good bounded move is probably higher-priority public-lane hardening or richer admin/forensics surfaces instead of another ceremonial anatomy lesson.
- If you do another structural cut, make the file earn it. Do not keep refactoring just because stale notes sound lonely.

## Important Paths

- Project root: `E:\Projects\VoidBot`
- Canonical map: `E:\Projects\VoidBot\state\map.yaml`
- Scratch surface: `E:\Projects\VoidBot\state\scratch.md`
- Distilled evidence ledger: `E:\Projects\VoidBot\state\evidence.jsonl`
- Branch/hypothesis ledger: `E:\Projects\VoidBot\state\branches.json`
- Handoff summary: `E:\Projects\VoidBot\notes\fresh-workspace-handoff.md`
- System map: `E:\Projects\VoidBot\notes\voidbot-current-system-map.md`
- Implementation plan: `E:\Projects\VoidBot\notes\voidbot-implementation-plan.md`
- State CLI: `E:\Projects\VoidBot\tools\voidbot_state.ts`
- Pre-compaction helper: `E:\Projects\VoidBot\tools\voidbot_prepare_compaction.ts`

## Useful Commands

```powershell
npm run state:status
npx tsx .\tools\voidbot_state.ts add-evidence --type research --status ok --note "..."
npx tsx .\tools\voidbot_state.ts add-branch --id branch-id --hypothesis "..."
npm run state:prepare-compaction
```

## Guardrails

- Do not continue implementation automatically from a rehydrate-only request.
- Do not trust this file for the exact live HEAD.
- Do not let `state/evidence.jsonl` become an activity feed.
- Do not let `state/scratch.md` linger with stale subgoals after the bounded move is done.

## Immediate Re-entry Instruction

On fresh session load or after suspicious continuity loss:

1. read `state/map.yaml`
2. run `npm run state:status`
3. reread `notes/fresh-workspace-handoff.md`
4. read `notes/voidbot-current-system-map.md`
5. read `notes/voidbot-implementation-plan.md`
6. restate the current next action from `state/map.yaml` before editing

When context pressure is rising:

1. stop broad exploration
2. narrow the active move to one bounded organ
3. persist map or handoff changes only if understanding actually changed
4. add distilled evidence only when the lesson changes future belief

The point is to bank coals, not leave the next waking thing a pile of ash and a browser tab graveyard.
