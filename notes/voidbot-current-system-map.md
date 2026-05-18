# VoidBot Current System Map

This note is the source-grounded description of how the live VoidBot stack is shaped right now. It is not a prose replacement for the code, and it is not a second canonical map. Its job is to explain the major organs and their data flow in plain language with concrete path anchors.

## Main Organs

- `apps/bot/src/discord-bot.ts`
  - Discord gateway shell: client bootstrap, provider wiring, event registration, and top-level orchestration.
- `apps/bot/src/discord-bot-handlers.ts`
  - Prompt/command handling, provider dispatch, rate-limit gating, job approval/rejection, reindexing, and slash-command registration helpers.
- `apps/bot/src/discord-bot-support.ts`
  - Discord-shape adapters, archive/source conversion helpers, ambient-memory ingestion helpers, source-grounding hint logic, and bot-side message formatting/rendering helpers.
- `apps/worker/src/index.ts`
  - owner-job poller, provider execution, handoff packaging, and MCP wiring for the worker-side lane.
- `apps/worker/src/mcp-server.ts`
  - thin stdio entrypoint that boots the MCP context and registers the resource/tool surfaces.
- `apps/worker/src/mcp-server-context.ts`
  - workspace bootstrap, config loading, archive/vector wiring, retrieval-service creation, and source-context ingester setup for the MCP lane.
- `apps/worker/src/mcp-server-resources.ts`
  - MCP resource registration for indexed repos plus history/source semantic-search resource templates.
- `apps/worker/src/mcp-server-tools.ts`
  - MCP tool registration for archived history search, indexed source/lore search, context windows, repo listing, registered repo-identity Discord speech, and owner notifications.
- `apps/worker/src/mcp-server-shared.ts`
  - MCP input schemas, argument types, and shared result-formatting/resource helper functions.
- `apps/worker/src/mcp-server-discord.ts`
  - Discord DM-channel creation and message-post helpers for `notify_owner`.
- `packages/core/src/state-storage.ts`
  - Thin state-storage factory that chooses file or Postgres backends and wires the domain stores together.
- `packages/core/src/state-storage-postgres-bootstrap.ts`
  - Postgres schema bootstrap plus one-time legacy file-state import.
- `packages/core/src/state-storage-postgres-job-queue.ts`
  - Postgres-backed job queue plus job row persistence helpers.
- `packages/core/src/state-storage-postgres-audit-log.ts`
  - Postgres-backed audit log plus audit-event upsert helper.
- `packages/core/src/state-storage-postgres-interaction-memory.ts`
  - Postgres-backed interaction-memory event storage and profile reconstruction.
- `packages/core/src/state-storage-rate-limit-stores.ts`
  - File and Postgres implementations for Void usage rate-limit state.
- `packages/core/src/interaction-memory-analysis.ts`
  - Event construction, tone/tag analysis, repetition detection, and persistence gating for remembered interactions.
- `packages/core/src/interaction-memory-profile.ts`
  - Profile synthesis, disposition, psychological read, inferred traits, interaction dimensions, and response-guidance construction.
- `packages/core/src/context-builder.ts`
  - request context assembly, including interaction-memory/profile attachment, shared Void self-state projection, and any precomputed situational social read.
- `packages/core/src/void-self-state-loader.ts`
  - thin typed `.cc` self-state loader that delegates read-side rendering to the projection module.
- `packages/core/src/void-self-state-projection.ts`
  - read-side projection authority for typed self-state: renders the agent-facing summary and compact nap/reply-mode projection from typed documents without touching legacy state.
- `packages/core/src/situational-social-read.ts`
  - quick Ollama sidecar inferer for ephemeral room-reading scaffolding built from the current prompt, recent room transcript, and longer-horizon interaction memory.
- `packages/providers/src/owner-codex-provider.ts`
  - thin orchestration layer for the Discord-safe `codex exec` lane.
- `packages/providers/src/owner-codex-runtime.ts`
  - Codex process execution, stdout/stderr parsing, trace-event normalization, history-tool loop requests, and owner-DM intent parsing.
- `packages/providers/src/owner-codex-render.ts`
  - prompt assembly, bundle rendering, and trace/debug transcript rendering for the owner lane.
- `packages/providers/src/owner-codex-shared.ts`
  - owner-lane constants, shared types, request-payload shaping, trace formatting helpers, and interaction-memory rendering.
- `packages/providers/src/local-llm-provider.ts`
  - thin orchestration shell for the Ollama chat lane plus the bounded host-managed read-only tool loop.
- `packages/providers/src/local-llm-render.ts`
  - local-lane prompt assembly, interaction-memory rendering, source-grounding reminders, and artifact rendering.
- `packages/providers/src/local-llm-tools.ts`
  - local-lane tool definitions, assistant-message normalization, tool argument parsing, and toolbox execution helpers.
- `packages/providers/src/local-llm-shared.ts`
  - local-lane constants, shared request/response/tool types, and low-level text/metadata helpers.
- `packages/rag/src/retrieval-service.ts`
  - high-level history/source retrieval API used by bot, worker, and provider tool loops.
- `packages/rag/src/qdrant-vector-store.ts`
  - Qdrant vector persistence for history and source collections.
- `packages/rag/src/message-archive.ts`
  - archived Discord message store under `.voidbot/rag/messages.json`, including bot-directed prompts that stay preserved for forensics even when they are excluded from default history retrieval.
- `packages/rag/src/source-document-archive.ts`
  - archived source/lore document manifest under `.voidbot/rag/source-documents.json` plus per-repo shards under `.voidbot/rag/source-documents.repos/`.

## Flow 1: Discord Request To Provider

1. `apps/bot/src/discord-bot.ts` receives a slash command or mention-driven request and delegates prompt/command work into `apps/bot/src/discord-bot-handlers.ts`.
2. Permission checks run through `packages/core/src/permission-engine.ts`.
3. Void usage limits are applied through `packages/core/src/void-usage-rate-limiter.ts` backed by `packages/core/src/state-storage.ts`.
4. `apps/bot/src/discord-bot-support.ts` adapts Discord message/interaction shapes, ambient-memory events, and source-grounding hints.
5. `packages/core/src/interaction-memory-analysis.ts` turns direct prompts or ambient mentions into normalized remembered events; `packages/core/src/interaction-memory-profile.ts` distills remembered events into a reusable longer-horizon social read.
6. `apps/bot/src/discord-bot-handlers.ts` usually runs a quick `think=false` local Ollama sidecar pass over the prompt and recent room transcript to infer an ephemeral situational social read, then records that read as an audit event for later aggregation. If the shared self-state says Void is napping, the handler skips that extra room-read pass and keeps the request deliberately cheap.
7. `packages/core/src/context-builder.ts` assembles request context, including recent interaction profile, the situational social read, the shared Void self-state projection, and any retrieval hints.
8. Provider selection goes through `packages/providers/src/index.ts`, but the handler can downshift owner traffic into the cheaper local lane when the shared self-state says Void is napping.
9. The bot either:
   - answers directly through `local_llm`, or
   - queues an owner job for the worker / `owner_codex` path.

## Flow 2: Owner Job Execution

1. `apps/worker/src/index.ts` polls approved jobs from durable state.
2. The worker claims a job and dispatches it to the configured provider.
3. `packages/providers/src/owner-codex-provider.ts` runs `codex exec` in the bounded lane, exposes the VoidBot MCP server, records traces, and carries advisory source-grounding hints plus retrieval tools for repo/lore/project questions.
   Runtime and parsing live in `packages/providers/src/owner-codex-runtime.ts`; prompt and artifact rendering live in `packages/providers/src/owner-codex-render.ts`.
4. If the answer fits the Discord-safe lane, the worker posts it back.
5. If the task needs deeper work, the worker writes a handoff bundle under `.voidbot/artifacts/<job-id>/` and posts the handoff response.

## Flow 3: Retrieval And Indexing

1. `packages/rag/src/message-archive.ts` and `packages/rag/src/source-document-archive.ts` keep the raw corpora.
2. Bot-directed prompts are tagged at ingest, kept in the raw Discord archive, and deliberately skipped when the history ingester builds semantic chunks so repeated summons stop poisoning normal retrieval.
3. `packages/rag/src/retrieval-service.ts` translates history/source queries into vector lookups plus metadata filters.
4. `packages/rag/src/qdrant-vector-store.ts` executes the live vector lookups against separate history and source collections.
5. `scripts/reconcile-source-repos.ts` discovers local Git repos, refreshes push hooks, prunes stale repo shards, and indexes newly discovered repos.
6. `scripts/index-source-repos.ts` and `scripts/git-post-push-index.mjs` drive explicit or detached per-repo source/lore reindex work.
7. `apps/worker/src/mcp-server.ts` boots the MCP lane, while `mcp-server-resources.ts` and `mcp-server-tools.ts` expose retrieval to Codex and other sessions through `search_history`, `get_message_context`, `search_sources`, `get_source_context`, and `list_indexed_repos`.

## Flow 4: Ops And Recovery

- `scripts/start-voidbot-stack.ps1`
  - stack bootstrap, health checks, fresh build, stale-process cleanup, source-repo reconcile, bot/worker restart, runtime status emission.
- `scripts/install-stack-startup-task.ps1`
  - installs the hidden logon task that runs `start-voidbot-stack.ps1` automatically after reboot or sign-in.
- `scripts/check-voidbot-operations.ps1`
  - watchdog for process liveness, Qdrant, Postgres, Ollama, source-repo reconcile drift, Discord auth, backup freshness, offsite sync freshness, and optional ignored local extension checks.
- `scripts/run-void-moderator-rumination.ps1`
  - typed rumination runner. It builds a bounded context packet from `.voidbot/private/void-self-state.cc`, recent Discord chronology, and read-only repo activity; loads `prompts/void-moderator-rumination.md`; runs Codex rumination; applies returned typed operations through `scripts/void-self-state.mjs`; then records parent-owned cursor and speech receipts.
- `scripts/lib/void-rumination-context-projection.ps1`
  - rumination context projector. It turns typed timestamps and helper payloads into prompt-facing relative phrases while leaving exact chronology in parent-owned typed state, status, and cursor bookkeeping.
- `scripts/void-self-state.mjs`
  - typed self-state operation CLI. It applies strict operation payloads such as cursor updates, open-case changes, delivery receipts, repo cursor updates, short-term memory records, sleep-owned distillations, durable-memory revisions/retirements/crystallizations, incubation merges, agency pressure, candidate interventions, sleep-cycle updates, and speaking-pressure updates through `packages/core/src/void-self-state-service.ts` against the CultCache `.cc` store.
- `scripts/run-void-memory-maintenance.ps1`
  - typed memory-maintenance runner. It builds a bounded prompt-facing context from typed short-term memories, durable memories, incubation, candidates, receipts, and scheduled runtime; loads `prompts/void-memory-maintenance.md`; asks Codex for memory/incubation/candidate operation proposals; then applies only allowed typed operations through `scripts/void-self-state.mjs`. It accepts `-StateFilePath` so fixture passes can use a throwaway `.cc` store.
- `scripts/smoke-void-memory-maintenance-sleep-fixture.ps1`
  - sleep-maintenance fixture. It seeds a temporary CultCache `.cc` store with a napping sleep cycle and one short-term memory, runs mood drift with a fake Codex child through the non-skip maintenance branch, and verifies the source short-term record is gone while one durable meaning-preserving memory remains.
- `scripts/smoke-void-memory-lifecycle-fixture.ps1`
  - memory-lifecycle fixture. It proves long-term memory is durable but plastic: a short-term memory promotes into durable memory, later revision retires the superseded durable record, and crystallization produces one active identity memory plus a self-profile value.
- `scripts/smoke-void-short-term-clustering-fixture.ps1`
  - short-term clustering fixture. It proves repeated same-target/topic rumination proposals fold into one provisional memory with merged anchors, while a different topic in the same repo stays separate.
- `scripts/smoke-void-agency-pressure-fixture.ps1`
  - agency-pressure fixture. It seeds one typed self-advocacy pressure, verifies it appears in the rendered self-state summary, then runs mood drift against an isolated fixture state to prove agency pressure contributes to speaking pressure without creating a hard-wired speech candidate.
- `scripts/smoke-void-rumination-fixture.ps1`
  - rumination fixture. It seeds an isolated CultCache `.cc` state, routes the non-skip rumination runner through a fake Codex child, and verifies short-term memory, incubation, agency pressure, and candidate intervention proposals are applied by the parent runner while the prompt-facing context keeps exact timestamps out.
- `scripts/smoke-void-rumination-speech-fixture.ps1`
  - parent-owned speech fixture. It queues one deliverable candidate through fake Codex, routes delivery through a fake Discord sender, then verifies the parent runner writes a delivery receipt and marks the candidate spoken through typed state.
- `scripts/smoke-void-rumination-nap-skip-fixture.ps1`
  - nap-skip fixture. It seeds a napping typed state with no room debt, points `CODEX_EXECUTABLE` at a bogus command, then verifies the runner exits with `napping_without_room_debt` and writes no operation proposals before invoking the model.
- `scripts/install-moderation-rumination-task.ps1`
  - installs the local 15-minute scheduled task that runs the moderation/participation loop through the hidden PowerShell launcher shim.
- Scheduled task `Void Mood Drift`
  - enabled typed mood/sleep runner. It invokes `scripts/run-void-mood-drift.ps1`, which calls `scripts/simulate-void-mood.mjs`; when the typed sleep cycle is napping, that path invokes memory maintenance once per nap.
- Scheduled task `Void Moderator Rumination`
  - enabled after parent-owned speech closure and one observed live scheduled pass with Last Result `0`. Its script is typed-only and has model-branch plus parent-owned speech fixtures.
- Live sleep maintenance
  - passed once on real state after a manual typed nap. The maintenance runner consumed the scheduled rumination short-term memory with one `apply_memory_distillation` operation, leaving short-term memory empty and preserving one durable identity seam with target, claim, tension, action implication, and anchors.
- Sleep brake
  - scheduled rumination skips during naps when there are no new room messages and no open cases, so sleep can distill the short-term surface without awake rumination immediately adding fresh residue.
- `scripts/simulate-void-mood.mjs`
  - typed mood maintenance script that updates scheduled-runtime sleep cycle and speaking pressure in `.voidbot/private/void-self-state.cc`. It owns the sleep transition and invokes typed memory maintenance once per nap unless that nap already completed a maintenance pass. Speaking pressure now derives from queued candidates, incubation, and active typed agency pressure. The old personality-vector drift, memory organ, incubation, dream residue, cleanup, and legacy mirror behavior are offline pending typed replacements.
- Repo Discord identities
  - `REPO_DISCORD_IDENTITIES_PATH` points at a private JSON registry of repo id, repo name, display name, optional avatar URL, optional role id, and allowed channel ids. The role is the Discord mention target; the webhook persona is the speech transport.
  - On startup, the bot tries to find or create missing mentionable roles for registered identities in `DISCORD_GUILD_ID`, then writes the role ids back to the private registry. If Discord permissions are missing, it warns and leaves the registry unchanged.
  - `list_repo_discord_identities` exposes the registered address book to Codex agents, and `post_repo_identity_message` enforces identity/channel registration before posting through the shared webhook pipe.
  - Each repo identity has a Face state path, defaulting to `.voidbot/private/repo-faces/<identity>.cc`. `read_repo_face_state` renders that typed state, and `apply_repo_face_state_operation` applies the same typed operation contract used by Void against that Face's own file.
  - Repo Face prompts now carry an explicit identity doctrine block. Void's style pack contributes discipline, humor permission, and source-grounding habits, but the registered Face state, repo-local `.voidbot` home, avatar, and identity description override the speaking subject so a Face does not collapse back into base Void.
  - Repo Faces are allowed to build a long-running map of their repo and propose concrete changes, including lore/design repairs. Discord jobs remain read-only: a Face must ask for human consensus before implementation changes canonical repo material. If a Face state grants a bylined essay lane, authored opinion essays can carry that Face's own vision without canon consensus as long as the authorship is explicit.
  - On first role-addressed chat, `ensureRepoFaceInitialized` creates the target repo's local `.voidbot/voice`, `.voidbot/state`, `.voidbot/birth`, and `.voidbot/logs` folders, writes `voice/identity.json`, and launches `scripts/run-repo-face-birth.mjs` detached if no birth summary is already present.
  - `scripts/run-repo-face-birth.mjs` is the observable bridge into EpiphanyAgent's newborn path. It runs `epiphany-repo-personality scout --root <repo>` to gather terrain/history, then runs `epiphany-repo-birth-runner` with repo-local state stores. The default mode is `plan`, so first chat creates reviewable birth artifacts without auto-accepting hidden personality mutations.
  - Role mentions create `repo-identity-mention` owner-Codex jobs whose final text is posted by the worker through the registered repo identity webhook persona, then queue `repo-face-rumination` jobs so the Face can think over the recent conversation and decide whether to persist memory, incubate ideas, raise agency pressure, queue candidates, or speak. Rumination jobs remain private unless they explicitly post through `post_repo_identity_message`; the worker must never auto-post their summaries as the base bot.
  - `scripts/run-repo-face-heartbeats.ts` gives every registered repo Face a standing initiative scheduler. It stores per-Face speed, reaction bias, load, next-ready time, and recent queue history at `REPO_FACE_HEARTBEAT_STATE_PATH`, staggers newborn participants across a base interval of twice `VOIDBOT_MODERATION_INTERVAL_MINUTES`, and queues only ready Faces as `repo-face-rumination` owner-Codex jobs.
  - `scripts/install-repo-face-heartbeat-task.ps1` installs the hidden Windows scheduled task for that scheduler. The scheduled task tick interval is `REPO_FACE_HEARTBEAT_INTERVAL_MINUTES`; the per-Face heartbeat interval remains half Void's frequency by using twice Void's moderation interval before initiative speed and load modifiers are applied.
  - The local ignored registry currently includes Nibu for `AetheriaLore`, with Face state in `E:/Projects/AetheriaLore/.voidbot/state/nibu.cc`, Discord role id `1505918221453103247`, and an Aquarium channel allow-list. Nibu's Face state now treats AetheriaLore-first map-building, abrasive character voice, consensus-backed change agency, her own `Aetheria/Lore/Nibu.md` character-note stewardship, Nibu-authored lore essays, and tangential setting fascination as separate active doctrines. That tangential fascination points at embodied ship minds, junkyard abandonment, murderous autonomy, salvage, and save-scumming survival. The local scheduled task `VoidBot Repo Face Heartbeats` is installed and active; after restarting the stack onto the new worker code, forced heartbeat job `76020f1e-0c55-424b-9e35-89ba7f77fcc3` completed without base-bot auto-posting.
- `scripts/run-void-mood-drift.ps1`
  - hidden-task wrapper for the mood-drift organ; writes status/log pulse files and respects the moderation lock so the two state writers do not stomp each other for sport.
- `scripts/install-void-mood-drift-task.ps1`
  - installs the local 5-minute scheduled task that keeps the shared self-state emotionally non-flat between moderation passes.
- `scripts/export-random-discord-history.mjs`
  - plain Node helper for novelty excursions that samples one random archived Discord seam, returns a local context window around the anchor message, and skips bot-directed prompt rows by default.
- `scripts/backup-voidbot-state.ps1`
  - local backup of Postgres, Qdrant snapshots, and RAG archives.
- `scripts/restore-voidbot-state.ps1`
  - local restore path.
- `scripts/sync-voidbot-backup-offsite.ps1`
  - verified offsite backup sync to the Qwen box.
- `scripts/voidbot-operations-dashboard-lib.ps1`
  - dashboard rendering for the local ops surface.

When present, an ignored local script at `.voidbot/private/check-voidbot-operations.local.ps1` can inject adjacent-service checks into the same ops lane. That keeps private infrastructure gossip out of tracked code while preserving one boring place for smoke alarms to land.

## Storage Boundaries

- Postgres:
  - jobs
  - audit events
  - interaction-memory events
  - provider run records
  - usage rate-limit state
- Qdrant:
  - Discord history vectors
  - source/lore vectors
- `.voidbot/`:
  - archived raw corpora
  - source archive manifest plus per-repo source shards
  - job artifacts and traces
  - logs and status files
  - backups and snapshots

The important scar is that these stores are split on purpose. Do not casually weld them back into one convenient blob and act surprised when it becomes a moon.

Within the Postgres path, the implementation is split on purpose now too:
- `state-storage.ts` chooses the backend
- `state-storage-postgres-bootstrap.ts` handles schema/bootstrap/import work
- per-domain modules own queue, audit, interaction-memory, and rate-limit behavior

## Flow 5: Scheduled Moderation Rumination

1. The Windows scheduled task `Void Moderator Rumination` is enabled.
2. `scripts/run-void-moderator-rumination.ps1` reads `.voidbot/private/void-self-state.cc`, polls `node scripts/export-recent-discord-history.mjs`, and gathers read-only repo activity with `node scripts/export-recent-repo-activity.mjs --read-only`.
3. The runner writes a bounded context packet at `.voidbot/status/moderation-rumination-context.json`; the prompt-facing packet projects recent timing as relative phrases instead of raw timestamps.
4. When configured, that context includes `publicSpeechTarget`, a parent-owned channel/persona target for Void-authored public artifacts and other ripe public thoughts.
5. The runner loads `prompts/void-moderator-rumination.md`, substitutes the context/state/output paths, and sends that prompt to Codex.
6. Codex may use retrieval and analysis tools, but its durable state output is restricted to `.voidbot/status/moderation-rumination-operations.json`.
7. The parent runner applies those typed operations through `scripts/void-self-state.mjs`, then records reviewed-message cursor and, on successful normal posting-enabled passes, advances repo-activity cursors from the observed repo weather through typed `update_repo_activity_cursor` operations.
8. If posting is enabled and typed state contains a queued candidate intervention with a delivery target, the parent runner sends at most one candidate, records the delivery receipt, and marks the candidate spoken through typed state. The candidate may have been proposed in the current pass or already queued from an earlier pass. The child prompt forbids direct send-script calls.
9. Before that delivery step, the parent runner now retires queued candidates whose `channelId + replyToMessageId` already appear in canonical typed speech receipts, so a later pass cannot answer an already-answered direct question just because the same message is still visible or the seam still feels warm.
10. The runner writes `.voidbot/status/moderation-rumination.json` and `.voidbot/logs/moderation-rumination.log`.
11. It intentionally does not materialize `.json`, load `.msgpack`, read the legacy moderation monolith, or let the child edit state directly.
12. Before applying model output, the runner enforces speech-pressure accountability. Active self/world advocacy pressures at 0.55 intensity or higher with no matching live queued candidate are projected as `speechPressureObligations`; model output must queue a candidate or cool/retire the pressure instead of returning silent `[]`. Deferred candidates do not satisfy that pressure by themselves, and an older spoken candidate does not keep satisfying a still-active pressure forever.

## Flow 6: Mood And Sleep Runtime

1. The Windows scheduled task `Void Mood Drift` is enabled.
2. `scripts/simulate-void-mood.mjs` reads typed documents from `.voidbot/private/void-self-state.cc`.
3. It updates `void.scheduled_runtime.sleepCycle` and `void.scheduled_runtime.speakingPressure` through `update_sleep_cycle` and `update_speaking_pressure` operations, with active advocacy pressure weighted strongly enough to raise speaking pressure earlier instead of staying a private sulk until the seam is already overripe.
4. It writes `.voidbot/status/void-mood-drift.json`.
5. When sleep is active, the script invokes `scripts/run-void-memory-maintenance.ps1` once per nap to force typed distillation/pruning.
6. The old memory-organ script family, legacy state template, and legacy context exporter have been deleted.

## Flow 7: Typed Memory Maintenance

1. `scripts/run-void-memory-maintenance.ps1` is invoked by mood drift during sleep, and can also be run manually for fixtures.
2. It reads `.voidbot/private/void-self-state.cc` through the typed self-state service.
3. It writes `.voidbot/status/void-memory-maintenance-context.json` with prompt-facing relative chronology and only typed memory/incubation/agency/candidate surfaces.
4. It loads `prompts/void-memory-maintenance.md` and asks Codex for operation proposals unless `-SkipModel` is set.
5. The parent runner rejects any operation outside memory lifecycle, incubation, agency pressure, or candidate-intervention maintenance.
6. The parent runner applies allowed operations through `scripts/void-self-state.mjs`.
7. In sleep mode, the context carries `sleepDirective.forceDistillation` when there is short-term memory pressure. A real model pass that returns no operations under pressure fails visibly, and any real sleep pass that leaves short-term memory behind fails instead of letting yesterday's residue haunt the state. The fixture smoke exercises this path with a fake Codex child so the parent validation and application machinery are tested without relying on live inference.
8. This is the replacement path for sleep/distillation and agency work: model-owned proposals crossing the typed operation boundary, not deterministic repair code editing state.

### Memory Lifecycle

1. Rumination may only write short-term memories. It cannot directly mutate durable memory.
2. The typed state service clusters repeated short-term memories before sleep sees them. If a new record repeats the same target/topic pressure, it updates one provisional memory and merges anchors instead of stacking another variant. This preserves deepening: fresh anchors and sharper tensions should accumulate inside the cluster, while unchanged paraphrases should not become separate memories.
3. Sleep maintenance promotes, merges, prunes, revises, retires, or crystallizes memory through typed operations.
4. Durable memory is not immutable. `revise_durable_memory` creates an explicit replacement and retires superseded source memories; `retire_durable_memory` marks obsolete memory inactive; `crystallize_memory_into_identity` promotes a stable thought into an `identity_seam` and may update self-profile values or private notes.
5. Prompt-facing language should talk about anchors: what made the thought real. The schema still accepts old `evidenceRefs`, but new memory payloads should prefer `anchorRefs` or explicit `anchor:missing`.

### Agency Pressure

1. Rumination and memory maintenance may propose `upsert_agency_pressure` or `retire_agency_pressure`.
2. The typed service validates that each pressure has a concrete target, claim or question, action implication, intensity, and either anchors/source memory ids or an explicit `anchor:missing` tag.
3. The self-state summary renders active agency pressure separately from queued speech candidates.
4. Mood drift reads active and ready agency pressure into speaking pressure, but it does not manufacture speech text from it.
5. The rumination runner bridges desire-to-speak without manufacturing text: strong advocacy pressure becomes an obligation for the model to queue/defer a candidate or explicitly cool/retire the pressure. The parent rejects silent output for those obligations.
