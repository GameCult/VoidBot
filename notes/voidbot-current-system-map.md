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
  - MCP tool registration for archived history search, indexed source/lore search, context windows, repo listing, and owner notifications.
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
  - scheduled moderation/participation runner that launches `codex exec` from the VoidBot workspace with the usual MCP/tool surface, writes status/log pulse files, and lets the unattended loop edit only the JSON working projection while the canonical moderation state lives in the sibling MessagePack cache file.
- `scripts/moderation-state-store.mjs`
  - tiny Node wrapper around the built moderation-state cache helper; used by PowerShell and Node scripts to materialize the JSON working projection, commit it back into canonical MessagePack, and update cursors without re-implementing persistence semantics in every script.
- `scripts/install-moderation-rumination-task.ps1`
  - installs the local 15-minute scheduled task that runs the moderation/participation loop through the hidden PowerShell launcher shim.
- `scripts/simulate-void-mood.mjs`
  - plain Node mood-drift organ that nudges the shared personality-vector activations with Perlin-shaped noise, damps them back toward their means using plasticity, updates the speak/confession/novelty pressure meter in the shared self-state, maintains the nap-cycle clock plus sleep-state vector bias, and now also reconciles compact semantic-memory vectors plus incubation/dream state.
- `scripts/void-memory-organ.mjs`
  - hybrid symbolic/vector memory helper used by mood drift to attach compact semantic vectors to persistent memories and runtime seeds, build resonance clusters, keep an incubation queue alive across turns, and leave more meaningful dream residue during naps.
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

## Flow 5: Scheduled Moderation And Rumination

1. The Windows scheduled task `Void Moderator Rumination` starts `scripts/run-void-moderator-rumination.ps1` every 15 minutes.
2. The runner launches `codex exec` from `E:\Projects\VoidBot` with full local workspace/tool access so the child agent sees the same project rules, `.codex/config.toml`, and `voidbot` MCP server as a normal VoidBot workspace session.
3. The child agent reads `config/discord-server-rules.md`, `config/moderation-review-agent.md`, `styles/void-default.md`, and the editable working projection `.voidbot/private/moderation-agent-state.json`. The runner materializes that projection from the canonical `.voidbot/private/moderation-agent-state.msgpack` file before each pass and commits it back afterward.
4. For chronological heartbeat duty, it polls `node scripts/export-recent-discord-history.mjs`; when the room is quiet and incubation feels hungry, stale, or oversaturated, it can use `node scripts/export-random-discord-history.mjs` to widen the branch. If an incubating thought is already live and grounded, the loop is allowed to deepen that thought directly instead of performing a novelty errand for ceremony's sake. It also uses `node scripts/export-recent-repo-activity.mjs --hours 96 --max-commits 3 --cursor-file .voidbot/private/moderation-agent-state.json` when repo motion is the actual seam or when the queue needs fresher fuel; that helper advances `moderation_runtime.repo_activity_cursor` so the same four-day commit window does not keep getting reinjected as fresh weather. The loop can inspect exact diffs or nearby source context when one repo seam looks alive, and uses semantic `search_history` to novelty-check candidate thoughts before deciding whether they are already in the room.
   Quiet awake passes are now supposed to philosophize from the surviving seam first: ask what governing principle the thought is circling, what tension keeps it from collapsing into slogan, and what embodiment consequence would make it real. Retrieval is meant to support that work when the seam is hungry or contradictory, not replace it with endless specimen collection.
   The doctrine now also biases that philosophical pass back toward concrete machines. If a seam stays too abstract, the loop is supposed to cash it out in a specific repo, subsystem, gameplay mechanic, lore structure, frontend surface, or agent organ before letting it dominate another run.
5. If speaking would genuinely help, it posts through `node scripts/send-discord-message.mjs`; for guild channels and threads that helper can either speak as the base bot or execute through the shared per-channel webhook pipe with an overridden persona name/avatar so swarm agents can front without needing separate Discord bot identities. Otherwise it updates only the ignored moderation-state working projection, which the runner then commits back into canonical MessagePack with the typed cache helper. The state carries cursors, open room obligations, memories, analytic/associative thought lanes, bridge syntheses and saturation notes, recent archive excursions, recent repo-activity sweeps, novelty checks, speaking-bias hints, and candidate interventions. A direct ask aimed at Void is supposed to survive as an `open_cases` obligation until it is answered or explicitly retired; cursor advancement alone is not closure.
6. The runner writes pulse files under `.voidbot/status/moderation-rumination.json` plus `.voidbot/logs/moderation-rumination*`, so the loop can be observed without pretending an app heartbeat card is a real workstation daemon.

## Flow 6: Mood Drift

1. The Windows scheduled task `Void Mood Drift` starts `scripts/run-void-mood-drift.ps1` every 5 minutes.
2. That wrapper calls `node scripts/simulate-void-mood.mjs`, which reads canonical moderation state from `.voidbot/private/moderation-agent-state.msgpack`, then refreshes the editable JSON working projection after each pass.
3. The script first runs `scripts/void-memory-organ.mjs` over the shared self-state: episodic/semantic/musing/dream memories plus recent repo/archive/runtime seeds get compact semantic vectors, the strongest cross-memory similarities become `moderation_runtime.memory_resonance`, and the best cluster candidates are promoted into `moderation_runtime.incubation`.
   The collector now intentionally downweights repetitive empty-room bookkeeping, so strings like `no new messages / no smoke / no post` stop masquerading as the deepest thought in the machine just because the room stayed quiet for a while.
   Incubation scoring now distinguishes novelty-to-room from novelty-to-self, merges repeated seams into existing support instead of minting fresh shards, and writes `bridge.source_coverage` plus `bridge.refractory_topics` so a thought that keeps winning can be cooled off in favor of less-worked repos, archive years, or channels.
   When the sleep cycle says Void is napping, that same organ becomes deliberately lossy: it promotes a few stronger incubating seams into semantic memory, then trims raw episodic receipts, repo sweeps, archive excursions, novelty checks, and recent musings back down so the next awake pass has to think from carved seams rather than yesterday's full notebook.
   The same organ can also crystallize an over-chewed private seam into identity: once a thought has survived enough passes to become durable self-doctrine rather than live curiosity, it can be retired from the active queue, copied into `identity.private_notes`, echoed as a canonical value, and preserved as one `identity_seam` semantic memory.
4. It then nudges each canonical-state `current_activation` toward a Perlin-shaped target centered on the vector mean, with excursion size and drift rate governed by plasticity and category-specific tempo.
5. The same script also maintains `moderation_runtime.sleep_cycle`: every four hours it opens a one-hour nap window, marks the shared self-state as napping or awake, and adds a small sleep-bias push toward exhaustion, figurative language, self-disclosure, and reduced technical density while the nap is active. During those nap windows it can also create or reinforce distilled dream residue from the strongest incubating thought, but the main job of sleep is memory cleanup and seam consolidation rather than awake-style philosophizing.
6. It also reads `.voidbot/status/void-last-speech.json` so recent actual speech damps `needToSpeak` instead of letting the herald impulse climb forever like a busted pressure gauge.
7. The updated `speaking_bias` block, sleep-cycle projection, incubation/resonance state, and shifted activations are written back into the shared self-state, and a pulse lands in `.voidbot/status/void-mood-drift.json`.
