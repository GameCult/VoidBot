# Agent Swarm Teardown Plan - 2026-05-21

This is the current restart gate for repo Faces, CTB heartbeats, Bifrost work routing, and public agent speech.

The ordinary VoidBot spine is not the rotten part. Discord ingestion, worker jobs, provider lanes, RAG, Postgres, Qdrant, and typed CultCache self-state remain conceptually sound. The unstable subsystem is the repo Face swarm loop: scheduling, prompt policy, identity, public speech, governance, Discord mirroring, Bifrost dispatch, GitHub proposal behavior, and repetition control were packed into one prompt-and-parser machine.

Stop feature work on the swarm until this plan has been reduced into a simpler live architecture.

## Plain-Language Live Map

### Core Inputs

- Discord messages, replies, role mentions, and display-name addressing enter through `apps/bot/src/discord-bot.ts`.
- Scheduled ticks enter through `scripts/run-gamecult-orchestrator.ps1`.
- Repo Face registry/config enters through `.voidbot/private/repo-discord-identities.json`, `packages/core/src/repo-discord-identities.ts`, `packages/core/src/epiphany-identities.ts`, and environment config.
- Bifrost governance and dispatch state is currently read through spawned Bifrost scripts.
- Face/Void self-state enters through typed CultCache `.cc` stores.
- RAG/source/history context enters through VoidBot MCP/retrieval surfaces and recent Discord fetches.

### Core Durable State Stores

- Postgres or file state owns jobs, audit events, rate limits, and interaction memory.
- Qdrant owns semantic vectors for Discord history and source/lore retrieval.
- `.voidbot/` owns raw archives, source archive shards, artifacts, logs, backups, and status files.
- `.voidbot/private/void-self-state.cc` owns Void typed self-state.
- Repo-local or storage-root Face `.cc` files own each Face typed self-state.
- `.voidbot/status/repo-face-heartbeats.json` currently owns CTB participant state, pending mentions, heat, history, and active-job guesses.
- `.voidbot/private/repo-discord-identities.json` currently owns role-backed repo identity records.
- Bifrost owns governance/update request state, but VoidBot currently reaches it by spawning Bifrost CLI scripts.

### Core Transformations

- Bot ingestion indexes Discord where configured, detects Void/Face addressing, initializes newborn Faces, and queues pending mentions.
- The orchestrator ticks organs: Bifrost dispatch, repo Face heartbeat, Void mood drift, Void moderation rumination, and watchdog.
- The repo Face heartbeat script reconciles identities, advances initiative, scans active jobs, fetches context, builds a giant child prompt, and queues `repo-face-rumination` jobs.
- The worker executes Codex jobs, parses Face action blocks or legacy sentinels, chooses side effects, posts Discord, calls Bifrost/GitHub bridge scripts, records receipts, and completes jobs.
- The typed state service validates and applies explicit state operations to CultCache `.cc` documents.

### Core Outputs

- Discord messages through bot or webhook transport.
- Bifrost topics, comments, approvals, dispatch requests, and mirror messages.
- GitHub draft PRs, PR comments, and article/proposal branches when enabled.
- Typed memory, affect, agency, receipt, runtime, and candidate-intervention state operations.
- Logs, artifacts, audit events, and status reports.

### Stage Ownership

- Bot owns Discord ingestion and mention detection.
- Job queue owns job lifecycle.
- Worker should own provider execution, but currently also owns repo Face side effects.
- Heartbeat scheduler should own turn selection only, but currently owns prompt policy, context assembly, stale recovery, and pending direct obligations.
- CultCache state service owns typed private state mutation.
- Bifrost should own governance/public transport, but VoidBot currently calls its internals.
- Identity ownership is split between repo Discord identities and Epiphany/Face identities.

### Coherence Invariants

- Public speech must never be raw model text with cleanup applied after the fact.
- Bifrost governance, Discord social speech, Codex dispatch, and GitHub review surfaces must have separate canonical homes.
- Each durable fact must have one owner.
- Scheduler state must not pretend to own job lifecycle truth.
- Face identity and jurisdiction must have one canonical model.
- Prompt prose must not be the architecture.
- Sanitizers must not be responsible for making bad public output acceptable.
- Aquarium social chatter must not become the only home for actionable work.
- Bifrost mirror traffic must be inspectable but not re-ingested as fresh consensus.

### Essential Machinery

- Discord bot, worker, provider, and RAG seams.
- Postgres/file job queue and audit log.
- Qdrant/source/history retrieval.
- Typed CultCache `.cc` state and parent-applied operation boundaries.
- A single dumb orchestrator pulse, provided it only supervises organ lifecycle.
- Bifrost as the governance/public-process bridge, once called through a clean boundary.

### Scaffolding And Compensators

- `sanitizeRepoIdentityPostContent`.
- Face action DSL and legacy JSON sentinels as executable side-effect API.
- Direct `UPDATE REQUEST` bypass.
- Worker-side Bifrost/GitHub bridge script calls.
- Duplicate repo identity and Epiphany identity models.
- Heartbeat state storing scheduler, pending mention queue, heat, history, active load, and stale job repair.
- Inspection/consensus scripts that emit proposals now meant to belong to Bifrost.
- Prompt doctrines that encode runtime policy instead of deriving it from typed state and parent gates.

## Architectural Smells

### 1. Repo Face Heartbeat Is A Rotten Subsystem

Current mechanism: `scripts/run-repo-face-heartbeats.ts` builds the child prompt, selects participants, loads Face state, reads Bifrost digest, fetches Discord snapshots, manages pending mentions, and queues approved owner-Codex jobs.

Real need: autonomous Face turns with social presence, memory, jurisdiction, and work proposal capability.

What breaks if deleted: Face chatter, Face direct-mention responses, and automatic Face work proposals stop.

Verdict: that breakage proves the need exists, not that this implementation owns it coherently.

Simpler architecture: a `FaceTurn` domain engine should emit typed candidate intents. Scheduler selects who gets a turn. Context assembler gathers evidence. Model proposes typed candidates. Parent gates and routes them. Bifrost owns governance.

Files to change: `scripts/run-repo-face-heartbeats.ts`, `apps/worker/src/index.ts`, `packages/core/src/repo-face-heartbeat-queue.ts`, `packages/core/src/repo-face-rest.ts`, repo Face prompt/render helpers, Face heartbeat smokes.

### 2. Sanitizer Is Scar Tissue

Current mechanism: `apps/worker/src/index.ts` strips public prefixes such as `heartbeat from ...` after the model has already produced bad speech.

Real need: stop scheduler/provenance labels from reaching Discord.

What breaks if deleted: bad public labels leak again.

Verdict: that proves public speech is being accepted too late and at the wrong level.

Simpler architecture: model output becomes `speech_candidate`. Parent-side speech eligibility rejects provenance-shaped, stale, repeated, or work-request-shaped content before transport. No string mop.

Files to change: `apps/worker/src/index.ts`, Face action parser/router, heartbeat prompt, model smoke fixtures.

### 3. Worker Owns Too Many Side Effects

Current mechanism: worker sees `repo-face-rumination`, parses action blocks, decides priority among SAY/Bifrost/update/GitHub, writes payload files, calls Bifrost/GitHub scripts, posts Discord, records receipts, and completes the job.

Real need: execute provider jobs and record results.

What breaks if deleted: repo Face side effects stop.

Verdict: side effects need a domain router. The worker is currently a junction box with opinions.

Simpler architecture: worker stores typed job result. A `FaceActionRouter` validates and routes candidates to Bifrost/Discord/GitHub adapters. Bifrost-owned work/governance transport should not live in the worker branch.

Files to change: `apps/worker/src/index.ts`, Bifrost client wrappers, MCP posting tools, tests.

### 4. Bifrost Authority Is Duplicated

Current mechanism: VoidBot directly spawns `agent-transport.mjs`, `governance-threads.mjs`, and `bifrost-bridge.mjs`.

Real need: governance threads, consensus, dispatch, mirroring, and public protocol transport.

What breaks if deleted: work dispatch and topic updates break.

Verdict: Bifrost lacks a clean API boundary from VoidBot's perspective.

Simpler architecture: one Bifrost client boundary, ideally CultNet/API-backed: open/comment/approve/dispatch/mirror. VoidBot supplies identity, context, and candidate intent; Bifrost owns persistence, mirror, dispatch receipts, and future GitHub/Discord crossings.

Files to change: `apps/worker/src/index.ts`, `scripts/run-repo-face-heartbeats.ts`, `scripts/feed-codex-chat-consensus.mjs`, Bifrost integration docs/tests.

### 5. Identity Authority Is Split

Current mechanism: repo Discord identities define id/repo/display/role/channel/avatar; Epiphany identities wrap or derive Faces/grants/jurisdictions from those records.

Real need: one identity model that knows who can speak, where, as whom, and with what authority.

What breaks if one layer is deleted: either Discord addressing or jurisdiction/grants vanish.

Verdict: two models are sharing one authority.

Simpler architecture: canonical `FaceIdentity` owns id, display, avatar, role projection, grants, jurisdictions, state path, channel grants, and repo relationship. Discord role identities become a projection, not a parallel source.

Files to change: `packages/core/src/repo-discord-identities.ts`, `packages/core/src/epiphany-identities.ts`, bot addressing, MCP identity tools, registry migration.

### 6. Scheduler State Owns Lifecycle It Cannot Know

Current mechanism: heartbeat JSON stores active job ids and then scans the job queue to reconcile stale jobs.

Real need: prevent overlapping turns and freeze initiative while a Face thinks.

What breaks if deleted: duplicate turns can be queued.

Verdict: job lifecycle belongs to the job queue. Scheduler may derive active state, not store it as truth.

Simpler architecture: scheduler stores initiative inputs and next-turn estimates only. Job queue is authoritative for active/running/completed. Completion events advance recovery.

Files to change: `scripts/run-repo-face-heartbeats.ts`, `packages/core/src/repo-face-heartbeat-queue.ts`, job queue state APIs.

### 7. Direct UPDATE REQUEST Bypasses Governance

Current mechanism: a Face can emit `UPDATE REQUEST`; worker enqueues Bifrost transport directly if cross-jurisdiction guard passes.

Real need: urgent repo-local dispatch.

What breaks if deleted: immediate dispatch waits for Bifrost topic/approval.

Verdict: that is a desirable break if Bifrost is the governance platform.

Simpler architecture: every work proposal is a Bifrost topic/comment. Dispatch only happens after Bifrost consensus/approval, with the owning Face's approval where applicable.

Files to change: worker parsers, heartbeat prompt, smoke tests, Bifrost topic/dispatch bridge.

### 8. Prompt Text Has Become Executable Policy

Current mechanism: huge prompt doctrine controls speech thresholds, comedy, jurisdiction, work routing, publication, repetition, social embodiment, and Bifrost etiquette.

Real need: rich agent behavior.

What breaks if deleted: Faces lose behavior.

Verdict: behavior exists only because prompt law is carrying architecture. That is fragile.

Simpler architecture: compact prompts over typed state, explicit policy structs, parent gates, and evaluators. Prompts should express voice and intent, not compensate for missing ownership.

Files to change: heartbeat prompt renderers, provider renderers, Face identity doctrine, smoke fixtures.

### 9. Rest/Fatigue Reaches Sideways Into Scheduler State

Current mechanism: post-fatigue updates Face `.cc` state and directly edits heartbeat JSON next-turn timing.

Real need: speech changes future cadence.

What breaks if deleted: fatigue no longer delays turns.

Verdict: rest state belongs in Face state; scheduler should read it next tick.

Simpler architecture: Face state records rest/fatigue. Scheduler projects readiness from Face state and job queue.

Files to change: `packages/core/src/repo-face-rest.ts`, heartbeat scheduler.

### 10. Inspector And Consensus Scripts Are Bifrost Compensators

Current mechanism: inspector emits proposal seeds from agent state; feed-consensus builds Discord packets and can enqueue Bifrost requests.

Real need: observe asks and route work.

What breaks if deleted: manual rescue lanes disappear.

Verdict: Bifrost should own proposal/consensus/dispatch. Inspector should report failures and state health, not mint governance artifacts.

Simpler architecture: inspector is health/audit only. Bifrost owns work proposal state and consensus.

Files to change: `scripts/inspect-agent-state-requests.ts`, `scripts/feed-codex-chat-consensus.mjs`, package scripts, inspector automation.

## Ranked Teardown Plan

### Keep

- Bot/worker/provider/RAG structural seam.
- Postgres/file job queue and audit events.
- Qdrant/source/history retrieval.
- Typed CultCache `.cc` private state and parent-applied operations.
- A single local orchestrator pulse, made dumb and observable.
- Bifrost as governance/public-process bridge.

### Cut

1. Public speech sanitizer.
2. Direct `UPDATE REQUEST` bypass as a Face-to-Codex dispatch rail.
3. Legacy repo Face JSON sentinels after typed candidate output exists.
4. Inspector-generated proposal/consensus artifacts.
5. Direct Discord prompt lanes for Faces.
6. Worker-owned Bifrost/GitHub bridge logic after Bifrost has one callable boundary.

### Collapse

1. Repo Discord identity and Epiphany Face identity into one canonical Face identity.
2. Discord post paths into one public transport adapter.
3. Bifrost topic/comment/approval/dispatch calls into one Bifrost client boundary.
4. Action DSL and legacy sentinels into one typed candidate output contract.

### Split

1. Heartbeat script into scheduler, context assembler, prompt renderer, and turn submitter.
2. Scheduler state from job lifecycle.
3. Agent psychology/state from public speech gating.
4. Casual Aquarium speech from Bifrost governance/work routing.
5. Canonical Bifrost comments from in-character Discord mirror speech.

### Rebuild

1. Repo Face turn system.
2. Bifrost transport boundary.
3. Face public-output pipeline: model proposes, parent validates, policy routes, transport posts.
4. Tests around invariants rather than current implementation shape.

## First Bounded Moves

1. Keep the swarm offline while teardown work proceeds.
2. Point canonical state and handoff docs at this teardown plan.
3. Add a repo-controlled pause flag that all swarm/organs obey before any scheduled work can resume. Landed: `state/agent-swarm-paused.json` is the repo brake.
4. Replace child-facing `heartbeat` framing with neutral `turn` language. Landed for active prompts/provider framing; legacy names remain only in compatibility/task/config surfaces.
5. Introduce parent-side public speech eligibility and make sanitizer deletion possible. Landed as a Spark/Codex parent-review pass with one retry, not a regex language cop.
6. Route all work proposals through Bifrost topics; remove direct `UPDATE REQUEST` dispatch. Landed for the worker: legacy `UPDATE REQUEST` blocks are reconciled into Bifrost topics instead of immediate agent transport enqueue.
7. Collapse identity authority.
8. Split scheduler from context/prompt/router.

Restart is not allowed until these invariants can be stated in code and tested:

- no public model speech posts without parent eligibility;
- no work request exists only in Aquarium;
- no Bifrost mirror post is treated as fresh consensus input;
- no scheduler JSON owns active job truth;
- no sanitizer is needed to hide internal runtime labels;
- no Face identity exists in two competing canonical forms.
