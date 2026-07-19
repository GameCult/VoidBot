# VoidBot Current System Map

This note is the source-grounded description of how the live VoidBot stack is shaped right now. It is not a prose replacement for the code, and it is not a second canonical map. Its job is to explain the major organs and their data flow in plain language with concrete path anchors.

Verse-facing service contract: `docs/architecture/voidbot-verse-service-contract.md`. VoidBot owns Discord cognition, r/GameCultOrg moderation judgment when Bifrost supplies Reddit threads/posts, repo Face Reddit thread intent packaging, archive/source retrieval, typed Void self-state, and repo Face compatibility rails. Huginn owns Persona/.cc runtime inspection stewardship. Bifrost owns governed work and Reddit transport. Odin discovers provider-owned CultMesh surfaces. Eve/CultUI is the presentation contract; browser HTML is only a lowering.

## Deployment Authority

VoidBot runs on Yggdrasil. Idunn owns deployment and consumes upstream repository pushes. The supported deployment path is therefore `upstream main -> Idunn release drift -> Yggdrasil`; a local checkout is a development and diagnostic body only. Future agents must not search for, create, or revive a local VoidBot deployment. Idunn compares `origin/main` with the root-owned `/srv/voidbot/deploy/deployment.env` witness, builds an audited immutable release when they differ, atomically switches `/srv/voidbot/app/current`, and accepts success only after the service set is running and `DEPLOYED_REVISION` matches upstream.

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
  - prompt data projection, bundle rendering, and trace/debug transcript rendering for the owner lane. Behavioral prompt prose is loaded from `prompts/`.
- `packages/providers/src/owner-codex-shared.ts`
  - owner-lane constants, shared types, request-payload shaping, trace formatting helpers, and interaction-memory rendering.
- `packages/providers/src/local-llm-provider.ts`
  - thin orchestration shell for the Ollama chat lane plus the bounded host-managed read-only tool loop.
- `packages/providers/src/local-llm-render.ts`
  - local-lane prompt data projection, interaction-memory rendering, source-grounding reminders, and artifact rendering. Behavioral prompt prose is loaded from `prompts/`.
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
8. Agent hosts start that stdio MCP body inside `compose-worker-1` on Yggdrasil over SSH. Qdrant stays loopback-private on Yggdrasil; agents receive MCP tools, not a raw vector-database route. A Starfire-local MCP body with `QDRANT_URL=http://127.0.0.1:6333` is invalid after the deployment move.

## Flow 4: Ops And Recovery

- `scripts/start-voidbot-stack.ps1`
  - stack bootstrap, health checks, fresh build, stale-process cleanup, source-repo reconcile, bot/worker restart, runtime status emission.
  - It now also ensures the configured Bifrost CultMesh command URI, provider store, and command processor are present through `BIFROST_ROOT`, `BIFROST_CULTMESH_COMMAND_URI`, and `BIFROST_CULTMESH_STORE_PATH`, because VoidBot's repo Face Discord speech writes typed Bifrost command documents and waits for typed receipts.
- `scripts/install-stack-startup-task.ps1`
  - installs the hidden logon task that runs `start-voidbot-stack.ps1` automatically after reboot or sign-in.
- `scripts/check-voidbot-operations.ps1`
  - watchdog for process liveness, Qdrant, Postgres, Ollama, source-repo reconcile drift, Discord auth, backup freshness, offsite sync freshness, and optional ignored local extension checks.
- `scripts/void-self-state.mjs`
  - typed self-state operation CLI. It applies strict operation payloads such as cursor updates, open-case changes, delivery receipts, repo cursor updates, short-term memory records, sleep-owned distillations, durable-memory revisions/retirements/crystallizations, incubation merges, agency pressure, candidate interventions, sleep-cycle updates, and speaking-pressure updates through `packages/core/src/void-self-state-service.ts` against the CultCache `.cc` store.
- `scripts/smoke-void-memory-maintenance-sleep-fixture.ps1`
  - sleep-maintenance fixture. It seeds a temporary CultCache `.cc` store with a napping sleep cycle and one short-term memory, runs mood drift with a fake Codex child through the non-skip maintenance branch, and verifies the source short-term record is gone while one durable meaning-preserving memory remains.
- `scripts/smoke-void-memory-lifecycle-fixture.ps1`
  - memory-lifecycle fixture. It proves long-term memory is durable but plastic: a short-term memory promotes into durable memory, later revision retires the superseded durable record, and crystallization produces one active identity memory plus a self-profile value.
- `scripts/smoke-void-short-term-clustering-fixture.ps1`
  - short-term clustering fixture. It proves repeated same-target/topic rumination proposals fold into one provisional memory with merged anchors, while a different topic in the same repo stays separate.
- `scripts/smoke-persona-initiative-engine.ts`
  - consolidated resident-organ fixture. It proves moderation review/enforcement boundaries, rumination fingerprint and nap gates, typed advocacy accountability, candidate selection, shared Bifrost command receipts, and no-double-delivery without summoning a Windows runner.
- Live sleep maintenance
  - passed once on real state after a manual typed nap. The maintenance runner consumed the scheduled rumination short-term memory with one `apply_memory_distillation` operation, leaving short-term memory empty and preserving one durable identity seam with target, claim, tension, action implication, and anchors.
- Sleep brake
  - scheduled rumination skips during naps when there are no new room messages and no open cases, so sleep can distill the short-term surface without awake rumination immediately adding fresh residue.
- Repo Discord identities
  - `REPO_DISCORD_IDENTITIES_PATH` points at a private JSON registry of repo id, repo name, display name, optional avatar URL, optional role id, and allowed channel ids. The role is the Discord mention target; the webhook persona is the speech transport.
  - That registry may also carry `channelPermissions`: per-topic channel entries with a speech threshold and speed multiplier. These are not another transport; they are the permission/salience map for where a Face may speak. Aquarium is the low-threshold musing lane, while domain channels such as narrative, gamedesign, music, soundtrack, development, programming, visual-effects, machine-learning, and unity3d are available to matching Faces.
  - Void remains the room-wide moderation/participation agent. Repo Faces are the swarm mouth and should be confined to text `#aquarium` (`1501196543150264332`) through registry allow-lists and `REPO_FACE_HEARTBEAT_DEFAULT_CHANNEL_ID`; general is `113786069023064068` and should not be used for autonomous Face chatter.
  - On startup, the bot tries to find or create missing mentionable roles for registered identities in `DISCORD_GUILD_ID`, then writes the role ids back to the private registry. If Discord permissions are missing, it warns and leaves the registry unchanged.
  - `list_repo_discord_identities` exposes the registered address book to Codex agents, and `post_repo_identity_message` enforces identity/channel registration before posting through the shared webhook pipe.
  - Each repo identity has a Face state path, defaulting to `.voidbot/private/repo-faces/<identity>.cc`. The MCP still exposes `read_repo_face_state` and `apply_repo_face_state_operation` for diagnostics and explicit administrative use, but normal character turns do not see those tools. The scheduler reads typed state, projects it into lived memory/mood/obligation language, and the Interpreter writes natural character reflection back into typed state operations.
  - The typed Face state now includes `void.face_affect`: needs, social bonds, status reads, and mood dimensions. This is the state-owned home for substrate concern, attention hunger, recognition needs, territoriality, friendships, rivalries, envy, pride, irritation, pampering, neglect, bypasses, and consultation politics. Affect is projected into heartbeat prompts and repo Face speaking pressure; concrete requests still become agency pressure, candidates, Bifrost topics, or work dispatch.
  - `get_voidbot_runtime_info` exposes the running MCP process id, workspace, self-state schema fingerprint, and registered document types so stale mounted MCP processes can be detected before a state read. `scripts/smoke-repo-face-affect-mcp-fixture.mjs` is the public-surface guard for that document kind. It starts `apps/worker/dist/mcp-server.js`, checks the runtime fingerprint, calls `read_repo_face_state`, and verifies `typedState.faceAffect` comes back with needs, social bonds, status reads, and mood dimensions arrays. This catches stale or incomplete MCP registration even when the direct state service can read the `.cc` file.
  - Shared coordination state has its own authority at `.voidbot/private/repo-face-shared-documents.cc`. Face-role Codex turns see `read_shared_document`, `create_shared_document`, and `update_shared_document` in both their neutral capability prompt and the hard MCP allow-list. The MCP server derives the writer from `VOIDBOT_REPO_FACE_IDENTITY`, validates it against the canonical Face registry, stamps provenance, and rejects stale expected revisions. The Interpreter, scheduler, Bifrost, private Face `.cc` stores, and arbitrary filesystem paths are forbidden writers.
  - Repo Face prompts now carry an explicit identity doctrine block. Void's style pack contributes discipline, humor permission, and source-grounding habits, but the registered Face state, repo-local `.voidbot` home, avatar, and identity description override the speaking subject so a Face does not collapse back into base Void. `ensureRepoFaceInitialized` also repairs the typed `selfProfile` inside the Face `.cc` file, and repo Face MCP state reads/writes pass identity defaults into the state service, so raw state and rendered state agree.
  - Repo Faces are allowed to build a long-running map of their repo and propose concrete changes, including lore/design repairs. Discord jobs remain read-only: a Face must ask for human consensus before implementation changes canonical repo material. Once a proposal is concrete enough to review, it should cross the parent-owned proposal PR rail so GitHub becomes the durable argument surface. If a Face state grants a bylined essay lane, authored opinion essays can carry that Face's own vision without canon consensus as long as the authorship is explicit.
  - On first role-addressed chat, `ensureRepoFaceInitialized` creates the target repo's local `.voidbot/voice`, `.voidbot/state`, `.voidbot/birth`, and `.voidbot/logs` folders, writes `voice/identity.json`, and launches `scripts/run-repo-face-birth.mjs` detached if no birth summary is already present.
  - `scripts/run-repo-face-birth.mjs` is the observable bridge into EpiphanyAgent's newborn path. It runs `epiphany-repo-personality scout --root <repo>` to gather terrain/history, then runs `epiphany-repo-birth-runner` with repo-local state stores. The default mode is `plan`, so first chat creates reviewable birth artifacts without auto-accepting hidden personality mutations.
  - Role mentions, whole-message display-name mentions, and human replies to a Face's webhook/persona message append pending Face obligations to the typed attention inbox resolved from `REPO_FACE_HEARTBEAT_STATE_PATH`. Ordinary bot mentions and DMs use the normal Void bot prompt/job lane immediately; they never enter Persona initiative or create a built-in Void participant. Name matching is exact-token matching across the message, not only prefix matching, so a human introduction such as "Meet Kiko, Huginn and Weksa" queues all named Faces. Persona speech still crosses registered channel/action rails, and the scheduler consumes pending items only after a turn is actually queued.
  - Repo Face proposal/article PRs, PR comments, registered-identity Discord posts, and r/GameCultOrg Reddit thread posts now cross through parent-owned action blocks before Bifrost bridge commands. Bylined essays use the Interpreter-owned `ARTICLE` block: the Face writes naturally, the Interpreter extracts structured title/description/author/date/tags/path/body fields, and deterministic worker code renders/validates YAML frontmatter before calling `BIFROST_ROOT/tools/bifrost-bridge.mjs` for a draft PR and persona announcement. Subreddit threads use the Interpreter-owned `REDDIT THREAD` block: the Face writes a public title/body/share line, and deterministic worker code calls Bifrost `reddit-post` with Persona flair. The old `VOIDBOT_REPO_IDENTITY_ARTICLE` JSON sentinel is cut. Proposal PR and PR-comment sentinels still exist as compatibility rails. This is not merely helper placement: Bifrost's original governance/labor platform role makes it the owner of governed public crossings for GameCult work, including GitHub, r/GameCultOrg Reddit transport/thread access, Discord-native work/member/swarm interactions, dispatch receipts, CultNet/CultCache intake, and future collaboration interfaces. Heimdall is the OAuth/account/capability gate; Bifrost is the bridge/request/routing/receipt authority. VoidBot still owns room/thread cognition, moderation judgment, archive/source retrieval, and Face personality.
  - Repo Face turns now receive a Bifrost governance digest from `BIFROST_ROOT/tools/governance-threads.mjs digest --repo <repo> --agent <identity>` alongside recent Discord context. Bifrost typed CultCache topics/comments are the canonical home for feature requests, Face opinions, missing questions, approvals, and dispatch receipts; Discord is a mirror/evidence source. When `BIFROST_DISCORD_CHANNEL_ID` is configured for `#bifrost`, repo Face Discord context ignores mirrored bot chatter there because the authoritative activity arrives through the Bifrost digest. Human `#bifrost` messages should only become governance comments after Bifrost/Heimdall can link the Discord id to a registered actor. Repo-local asks that would send a human or Codex to add/fix/name/scaffold/document/test/investigate/implement belong on Bifrost with enough room/repo context for a claimed Codex turn; a Face may still speak characterfully in Aquarium, but not as the only dispatch surface. Legacy `UPDATE REQUEST` packets are parsed only as compatibility input and reconciled into Bifrost topics instead of immediate transport enqueue. Local `#bifrost` is channel `1506760343836430376`; work proposals, governance mirrors, and Bifrost dispatch receipts should go there, while Aquarium remains the casual/social swarm room.
  - Repo character turns now have a state-projector plus turn-Interpreter shape. The state-in boundary is `prompts/repo-face-state-projector.prompt.md`: typed state and identity material are translated into lived character prose before the child sees it. The state projector must surface values, drives, wounds, fascinations, aesthetic taste, dignity, mood, needs, social reads, bonds, agency pressure, and the personality-specific meaning of sparse or dense social topology when the state contains those facts. The deterministic state packet feeding that projector is intentionally verbose and parent-facing: it exposes private notes, values, activation vectors, runtime rest/speaking pressure, affect needs, bonds, status reads, mood dimensions, durable memories, short-term residue, agency pressures, incubating thoughts, candidate speech pressure, recent speech residue, social graph facts, room weather, and semantic curiosity graph attractors so every included variable can appear directly or bend behavior. The curiosity graph is built by seeding history/source vector retrieval from current room context, nearby channels, typed Face state, and home-jurisdiction identity, then decoding retrieved chunks into weighted attractor clusters with prominence, saturation, novelty, density, jurisdiction fit, suggested motion, and evidence labels. The projector owns turning those neutral facts into lived curiosity, boredom, fatigue, territorial pull, underexplored intrigue, or a closing/pivot impulse; deterministic code must not decide the feeling. Deterministic code may also attach neutral graph facts such as mapped people and unmapped registered peers to the projector packet, but it must not decide whether that feels like anxiety, territorial scouting, or nothing. Deterministic code attaches recent read-only home-repo activity before chat, using the Face's own state path as the repo-activity cursor source, so current implementation motion is visible as body context. Current-room and nearby-channel logs no longer cross a model conversation projector; deterministic code attaches raw oldest-to-newest transcript evidence with explicit recency/correction rules so the Face can notice human reframes directly. Deterministic code also attaches a social-affordance surface that matches active typed person-bonds/status reads to recent raw messages from that person, so relationship state arrives as a live hook rather than private decorative lore. Deterministic code still owns full prompt assembly and inspection through `scripts/run-repo-face-heartbeats.ts --assemble-prompt <identity>`; that path composes stable doctrine, allowed rooms, research/archive capability guidance, Bifrost digest, projected memory/affect prose, home-repo activity, live social affordances, and raw conversation evidence into the exact child prompt. It must not invent personality, mood, affect, or social memory from typed state. Situational obligations such as direct-call priority or first-public-introduction duty are emitted only when the scheduler packet proves they apply, not as standing prompt law. The child character writes a natural in-character turn on full `gpt-5.4` and may describe desired speech, repo/article proposals, social reads, needs, mood shifts, or memory-worthy thoughts without emitting action DSL blocks. The cheaper Spark/Mini parent Interpreter decides route/retry/drop and translates warranted effects into structured `STATE NOTE` and `SAY` blocks for the worker while governance dispatch remains paused. `STATE NOTE` blocks become typed short-term memory, affect needs, social bonds, status reads, mood dimensions, or agency pressure. The worker still accepts legacy compact JSON sentinels and legacy `UPDATE REQUEST` blocks for compatibility, but the live prompt path keeps transport and state syntax out of the character's roleplay surface.
- `apps/persona-scheduler` is the resident daemon organ that owns the serialized Persona wall-clock pulse on Yggdrasil and remains alive between observations. It queues only registered repo/native Personas; built-in Void never enters initiative. `initiative-engine.ts` owns scheduling state transitions, `state-store.ts` owns typed persistence/migration, attention commands are acknowledged only after durable commit, and external sources/actuators return facts without writing initiative.
- Human-clarity chronology, social topology, peer openings, and relationship-pressure scoring now share the same social-context owner. The shell consumes one named projection result and contains no duplicate social scorer.
- Self-maintenance advocacy is a typed-state pressure projection owned by `persona-memory-projector.ts`. That organ classifies qualifying needs, agency pressures, and must-share candidates, suppresses them under live human-clarity pressure, and fixes their order alongside the other pressure sections; the heartbeat shell no longer carries a parallel maintenance policy.
- Curiosity is split at the evidence boundary. `persona-curiosity-context-source.ts` plans semantic seeds from supplied identity, typed Mind, and room evidence, then acquires and deduplicates bounded neutral nodes through an injected retrieval port. `persona-curiosity-projector.ts` constructs and scores the local attractor graph and renders curiosity weather without vector access. `persona-curiosity-terms.ts` owns their shared topic-term vocabulary. The heartbeat shell wires the existing RAG adapter into these organs and owns neither query policy nor graph interpretation.
- `persona-social-context-source.ts` is the read-only interaction-memory adapter for social guidance. It selects visible humans plus the owner, reads profiles through an injected closeable port, ranks explicit/corrective evidence over ambient usage, and emits neutral pronoun guidance. Storage remains authoritative; the source closes its reader and cannot render prompt prose or mutate profiles.
- `persona-conversation-projector.ts` is the pure owner of conversation projection. Given routing, raw current/nearby messages, pending mentions, and identity, it emits one transcript plus the exact thread/default-focus objects sent to the actuator, and derives shared room-saturation/topic-attractor facts. It cannot read Discord, state, vectors, or the queue; `turn-context-source.ts` remains the evidence owner.
- `persona-turn-prompt-projector.ts` is the final pure turn-policy owner. It composes the repo-Face prompt template and owns identity doctrine, situation/mention/channel/research/social/governance/repetition/worldbuilding directives, plus deterministic jurisdiction-dive cadence. The heartbeat shell passes acquired facts and sends the returned prompt to the actuator; it does not load prompt templates or decide prompt policy.
- Typed native Personas and repo Personas share the same `persona-state-source`/memory-projector path. Legacy `gamecult.persona_state.v0` JSON remains live for Muninn, Sleipnir, Hermodr, and Tengu behind `persona-portable-state-source.ts` and `persona-portable-state-projector.ts`; the source validates schema/read failures and the projector renders bounded imported state without exposing its path. This compatibility organ is not canonical state ownership and should disappear after a provenance-aware `.cc` migration.
- `apps/persona-scheduler/src/persona-scheduler-runner.ts` owns one complete typed scheduler tick in-process. The resident `index.ts` serializes calls to that runner directly; it does not spawn a TypeScript script per pulse. Pause/disabled checks happen before registry, Discord, embedding, provider, or dispatch work. `persona-participant-dispatcher.ts` owns participant-spec projection plus repo-Persona/Void dispatch, while `persona-prompt-inspection.ts` owns the explicit prompt-inspection workflow. `scripts/run-repo-face-heartbeats.ts` is only a 31-line CLI adapter over the runner or inspection organ.
- `apps/persona-scheduler/src/void-physiology-domain.ts` owns pure Void sleep and speaking-pressure projection. `void-physiology-organ.ts` loads typed Mind and applies only `update_sleep_cycle` / `update_speaking_pressure` operations. The resident coordinator serializes organs, so physiology does not infer activity from a filesystem lock. Typed speech receipts own `lastSpokeAt`; sleep-time short-term pressure becomes a maintenance intent and cannot directly launch a model or mutate memory.
- `packages/core/src/bifrost-discord-command.ts` owns the typed Bifrost Discord command/receipt crossing for all VoidBot callers. Worker repo-Face speech and the resident `void-candidate-delivery-organ.ts` supply identity, target, reply, and content through that one port; neither owns CultMesh document definitions, command pumping, receipt polling, or transport completion policy. Candidate delivery marks typed state spoken only after a completed Bifrost receipt and is independently gated by `VOID_CANDIDATE_DELIVERY_ENABLED`.
- Resident person-shaped rumination is independently gated by `VOID_RUMINATION_DAEMON_ENABLED` and its own minimum five-minute cadence. A due pass reads one bounded chronological Discord window plus the dedicated rumination doctrine, server rules, and Void voice; `void-rumination-organ.ts` receipts the stable pressure fingerprint before its one model attempt. It cannot run merely because the one-minute Persona observation clock fired, and it remains disabled on Yggdrasil while the model credential is stale.
- `apps/persona-scheduler/src/bifrost-governance-source.ts` owns the remaining Bifrost governance digest subprocess contract. It supplies the CLI path, arguments, timeout, JSON parsing, and typed command/parse failure topics; Persona prompt composition receives a `BifrostGovernanceDigest` and cannot invoke Bifrost directly.
- The scheduler state has one write authority. `initiative-engine.ts` commits participant reconciliation, operator controls, pause/disabled skips, stale-turn recovery witnesses, semantic pressure, pending-attention consumption, queue outcomes, and tick finalization. `run-repo-face-heartbeats.ts` contains no direct participant/state assignment or history append; its sources and actuators return facts to engine commits.
- `apps/persona-scheduler/src/turn-actuator.ts` is the worker-queue output port. Given a completed prompt, output channel, evidence fields, provider, identity, timestamp, and narrow `createJob` capability, it builds the canonical worker actor/guild `ContextBundle`, creates one approved `repo-face-rumination` job, and returns `{created, activeJobId, requestMessageId}`. It cannot choose a Persona, mutate scheduler state, or compose prompt content. The orchestration shell no longer knows `ContextBuilder`, job approval defaults, worker command names, or `createJob` mechanics.
- `apps/persona-scheduler/src/turn-routing.ts` owns channel selection and projection. It turns registered channel permissions, the configured default, and the newest pending-attention channel into one `PersonaChannelPlan` containing the primary output room, nearby snapshot rooms, normalized options, and low-threshold topics. It also owns the bounded channel-speed multiplier used by participant specs. Context readers and prompt renderers consume this plan without deciding routes.
- `apps/persona-scheduler/src/control-source.ts` owns operator-control observation. It reads the pause witness with explicit absent/running and malformed/fail-closed semantics, loads the typed `voidbot.swarm_control_state` CultMesh document, validates heat bounds, and returns neutral facts. It cannot write scheduler state; engine commits own control application and skip witnesses.
- `apps/persona-scheduler/src/repo-activity-source.ts` owns the home-repo activity subprocess boundary. It resolves the source repo and Face cursor, invokes `export-recent-repo-activity.mjs` with a bounded 96-hour/five-commit window and mandatory `--read-only`, and returns a typed observation. Prompt composition renders that observation and cannot invoke or parse the exporter.
- Idunn invokes the root-owned audited manifest at `/srv/odin/deploy-manifests/voidbot`; `/usr/local/sbin/deploy-voidbot` is a byte-identical inspection/recovery copy, not the live path. Both derive from `gamecult-ops/scripts/deploy-voidbot.sh`. The `idunn` user exclusively owns mutable Git state in `/srv/build/VoidBot` and `/srv/build/cultcache-ts`, including lazy partial-clone object fetches; the root actuator owns immutable artifact construction/promotion, systemd, and deployment witnesses without running Git as root.
- The same scheduler derives semantic `responsePressure` for scheduler-eligible Personas by embedding canonical Face identity-card projections and recent human messages from channels each Face may enter. Pressure decays by message age, aggregates with noisy-OR, awakens at most three eligible Faces, and exposes its message-scoped cosine evidence. It produces bounded `dynamicHeat` for the next scheduled recovery calculation; an unseen message crossing the Persona's interrupt threshold may pull readiness to the current initiative clock exactly once. It cannot create a job, bypass rest or active-turn brakes, impersonate a direct mention, or write inferred desire into Persona state.
  - The Windows omnibus and per-organ wrappers are deleted. `voidbot.service` deploys `persona-scheduler` beside bot, worker, Qdrant, and the CultMesh publisher. Heat changes Persona recovery only and cannot manufacture intent.
  - The registry includes Nibu for `AetheriaLore`, with typed Face state and an Aquarium channel allow-list. Her Persona turns use the resident scheduler and normal worker queue; no local orchestrator exists.
  - The local ignored registry now also includes Epiphany for `EpiphanyAgent`, with Face state in `E:/Projects/EpiphanyAgent/.voidbot/state/epiphany.cc`, Discord role id `1506375937439301642`, and Aquarium channel allow-list `1501196543150264332`. Her repo-local `.voidbot` birth surface has completed in plan/review mode; the generated EpiphanyAgent startup packets still require Self review before accepted native birth mutations. Her jurisdiction is the self-improvement spine: typed state, CultCache/CultNet, Codex bridge boundaries, birth/init rites, low-copy runtime contracts, review gates, graph-shaped memory, heartbeat physiology, and deletion of duplicated authority.
- `scripts/export-random-discord-history.mjs`
  - plain Node helper for novelty excursions that samples one random archived Discord seam, returns a local context window around the anchor message, and skips bot-directed prompt rows by default.
- `scripts/feed-codex-chat-consensus.mjs`
  - plain Node helper that turns recent archived Discord messages, defaulting to text `#aquarium`, into a markdown consensus packet plus a target Codex prompt. By default it writes files under `.voidbot/artifacts/chat-consensus/`; with `--execute`, it feeds the generated prompt to `codex exec` in the requested workspace. With `--enqueue-bifrost`, it also calls `E:/Projects/Bifrost/tools/agent-transport.mjs enqueue` so the packet becomes a CultCache-backed Bifrost intake request for the target repo Face instead of remaining an inert local artifact.
- `scripts/backup-voidbot-state.ps1`
  - local backup of Postgres, Qdrant snapshots, and RAG archives.
- `scripts/restore-voidbot-state.ps1`
  - local restore path.
- `scripts/sync-voidbot-backup-offsite.ps1`
  - verified offsite backup sync to the Qwen box.
- `scripts/voidbot-operations-dashboard-lib.ps1`
  - dashboard rendering for the local ops surface.

When present, an ignored local script at `.voidbot/private/check-voidbot-operations.local.ps1` can inject adjacent-service checks into the same ops lane. That keeps private infrastructure gossip out of tracked code while preserving one boring place for smoke alarms to land.

## Verse Service Contract

- Owner:
  - VoidBot owns Discord ingress, room cognition, r/GameCultOrg moderation judgment when Bifrost supplies Reddit context, archive/source retrieval, direct owner handoff, typed Void self-state, repo Face scheduling compatibility, and parent-owned speech delivery.
  - Huginn owns Persona-state and `.cc` runtime inspection stewardship: schema availability, migration pressure, projection health, access-tool sanity, CultMesh publication, and Eve DSL inspection for typed state.
  - Bifrost owns governed public crossings for GitHub proposals/articles/comments, r/GameCultOrg Reddit post/thread viewing and posting, work topics, dispatch receipts, and future Discord-native work interfaces.
  - Odin owns Verse/provider discovery and interface aggregation, not provider state.
  - Eve/CultUI owns presentation shape; browser/native/TUI renderers lower provider-owned surfaces.
- Inputs:
  - Discord gateway events, archived Discord corpus, indexed source/lore archives, Postgres jobs/audit/interaction memory, Qdrant vectors, typed `.cc` self/Face state, Bifrost governance digest, and resident daemon health.
- Outputs:
  - Discord replies or webhook persona posts through parent-owned rails, owner handoff artifacts, MCP retrieval/tool results, typed CultCache operations, and CultMesh-advertised Eve/CultUI provider surfaces.
- Derived state:
  - JSON status files, generated HTML, source/archive freshness summaries, prompt-facing projections, and local debug snapshots are witnesses or lowerings. They do not own durable truth.
- Forbidden writers:
  - Child prompts, renderers, static dashboards, legacy JSON projections, Odin discovery, Huginn inspection tools, and command receipts must not mutate VoidBot or rendered binding state except through advertised command bindings, typed operation ports, and provider-owned live state handles.
- Shared paths:
  - Manual turns, CTB heartbeats, direct mentions, role/name addressing, moderation rumination, repo Face speech, Bifrost digest reads, and swarm controls should converge on typed operations and Eve/CultUI bindings rather than parallel dashboard endpoints.
- Cut line:
  - If a new status/control surface is meaningful to operators, publish it as typed CultCache or a `.cc` witness and an Eve/CultUI CultMesh surface. Do not add a separate HTTP dashboard or status-card authority.

Current CultMesh namespace:

- Verse id: `voidbot.local`
- Provider id: `voidbot.swarm`
- Endpoint: `cultmesh://voidbot.local/eve/providers/voidbot.swarm`
- Snapshot document: `voidbot.swarm_state_snapshot`
- Provider advertisement: `gamecult.eve.provider_advertisement`
- Eve surface state: `gamecult.eve.surface_state`
- Eve interface binding: `gamecult.eve.interface_binding`
- Store path: `.voidbot/status/cultmesh/voidbot-swarm-state.cc`

Eve v2 live-binding path:

1. VoidBot owns accepted heat in `.voidbot/private/swarm-controls.cc` and publishes that typed document through a retained provider session (`060da23`). The Eve surface binds both heat text and slider to it (`3d86b93`); neither contains a baked live value.
2. CultLib's dev line owns typed live-publication handles, authenticated provider-session ingress, reliable reconnect evidence, and RUDP application receipts (`ebd8c78c`, `d4934233`, `8965f3c0`).
3. Eve's browser lowering resolves bindings and owns subscription cleanup/rebind across surface changes (`85b0139`, `522df00`). Command receipts report applied/rejected intent but cannot paint authoritative values into controls.
4. Odin remains discovery/aggregation. Hermodr's live-publication branch owns the authenticated provider-session broker and ordered SSE lowering (`5cb819e`, `561e320`); one-shot surface/document reads remain bootstrap and diagnostics only.
5. Initial load, external provider mutation, command mutation, and reconnect must converge through the same provider update -> typed handle -> Eve binding path.

Target Eve surfaces:

- `voidbot.discord`: room obligations, direct mentions, speech receipts, moderation/open-case pressure, delivery targets.
- `voidbot.reddit`: r/GameCultOrg thread/post obligations, Persona-authored thread ideas, moderation/open-case pressure, proposed replies/actions, and Bifrost transport receipts.
- `voidbot.archive`: archived Discord corpus status, import/backfill health, bot-directed-prompt exclusion, history vector freshness.
- `voidbot.source`: repo/lore shard freshness, indexed coverage, Qdrant collection health, detached reindex jobs.
- `voidbot.repo_face`: registered identities, repo-local `.cc` witnesses, channel grants, prompt assembly status, Bifrost digest availability, Huginn inspection readiness.
- `voidbot.swarm`: CTB order, active turns, pending mention queues, heat/cadence controls, daemon status, selected Face state witness.

Migration order:

1. Keep `voidbot.swarm` publishing a CultMesh Eve provider through `.voidbot/status/cultmesh/voidbot-swarm-state.cc`.
2. Add `.cc` witness/export documents for JSON-only status surfaces before treating them as Verse state.
3. Move Persona and repo Face `.cc` inspection to Huginn-owned tooling while VoidBot remains the Discord compatibility carrier.
4. Publish `voidbot.discord`, `voidbot.reddit`, `voidbot.archive`, `voidbot.source`, and `voidbot.repo_face` as typed Eve/CultUI bindings.
5. Let Odin discover and aggregate the provider-owned surfaces.
6. Demote old JSON exports, local HTML, and legacy MCP state reads to diagnostics once CultMesh/Eve and Huginn cover the same reality.
7. Extend the proven binding path beyond swarm heat as each remaining baked operator value earns a typed provider-owned document; never revive whole-surface polling or receipt-driven DOM repair.

Huginn demotion line: VoidBot may carry repo Face `.cc` state paths, MCP diagnostics, and Discord compatibility registry data, but Persona/.cc inspection and portable Persona publication belong to Huginn. VoidBot must not let its private registry, static HTML, or legacy MCP state tools become the canonical Persona authority.

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

## Flow 5: Resident Person-Shaped Rumination

1. `apps/persona-scheduler/src/index.ts` owns an independent disabled-by-default rumination cadence; the Persona observation clock cannot authorize it.
2. A due pass acquires one bounded chronological Discord window and reads the dedicated doctrine, server rules, and Void voice surfaces.
3. `void-rumination-projector.ts` derives relative chronology, typed advocacy obligations, and a stable pressure fingerprint that excludes wall-clock churn.
4. `void-rumination-organ.ts` writes the attempt receipt before one tool-free text-model call. The same pressure fingerprint cannot retry after failure or on a later timer pulse.
5. The model may propose only the bounded awake-rumination operation family. The parent validates and applies every operation through the typed self-state service.
6. Speech remains a queued candidate. `void-candidate-delivery-organ.ts` independently selects at most one targeted candidate, crosses the shared typed Bifrost port, and marks it spoken only after a complete receipt.
7. Yggdrasil keeps rumination inference disabled while the configured model credential is stale; this does not disable transport-only delivery of already-authorized candidates.

## Flow 6: Physiology Runtime

1. The resident `apps/persona-scheduler` daemon invokes `void-physiology-organ.ts` on its own five-minute cadence, independent of whether Persona initiative is paused.
2. The organ reads typed documents from `.voidbot/private/void-self-state.cc` and derives the most recent speech time from typed receipts. Resident coordinator serialization is the mutual-exclusion boundary.
3. It updates only `void.scheduled_runtime.sleepCycle` and `void.scheduled_runtime.speakingPressure` through `update_sleep_cycle` and `update_speaking_pressure` operations. Active moderation freezes sleep transitions but does not prevent pressure observation.
4. When a nap has short-term residue, physiology emits a typed memory-maintenance intent. It does not perform memory policy, launch PowerShell, or call a model.
5. The Windows omnibus mood writer has been removed. Legacy mood scripts may remain as fixtures or manual compatibility bodies, but they are not a deployed recurrence or runtime owner.

## Flow 7: Typed Memory Maintenance

1. `void-memory-maintenance-organ.ts` consumes a typed physiology intent containing the nap start and short-term pressure count.
2. It checks typed scheduled-run receipts, then records `void-memory-maintenance-attempt:<napStartedAt>` before inference. This makes one attempt per nap structurally enforceable even when inference fails or returns malformed output.
3. `void-memory-maintenance-projector.ts` builds bounded prompt context with relative chronology, one explicit operation timestamp, and only typed memory/incubation/agency/candidate surfaces.
4. `void-memory-text-actuator.ts` performs one tool-free OpenAI-compatible text request with a bounded completion budget and returns model text only.
5. The organ parses the entire response as a JSON operation array, validates every item against the canonical self-state operation schema, and rejects operations outside the explicit maintenance family before applying any item.
6. It applies allowed operations through the typed self-state service, reloads state, and fails visibly unless all short-term residue is gone.
7. Only a fully successful transaction records `void-memory-maintenance:<napStartedAt>`. A later physiology pulse for the same nap returns an already-attempted or already-completed result without inference.
8. No PowerShell compatibility runner remains; the resident organ is the only maintenance decision path.

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
# Organizational Persona Feedback

The explicit `/epiphany` slash surface is a separate operator-request fork. It accepts only `status`, `sleep(reason)`, `wake`, and `direct(objective)`, requires exact equality with `DISCORD_OWNER_ID`, and writes one immutable, sixty-second `voidbot.discord.epiphany_operator_request.v0` document to `BIFROST_EPIPHANY_OPERATOR_REQUEST_STORE`. The Discord interaction id is the request id, command id, nonce, source event, and slash-message identity. The target is fixed to `epiphany-yggdrasil`. VoidBot does not authenticate the crossing, execute locally, open Epiphany state, or grant Mind, Hands, release, or deployment authority; Bifrost must independently authenticate and admit the request. Ordinary `MessageCreate` content, including the word `wake`, stays on the feedback-only path and cannot call the operator client.

Configured remote Persona feedback is an observation fork beside the existing mention scheduler. `discord-bot.ts` commits the local Persona mention obligation first and independently calls `exportPersonaFeedbackObservation` only when `remotePersonaFeedbackTarget` is present on the addressed Face. The exported immutable event carries exact Discord provenance, addressing mode, target binding, content hash, and stable `voidbot` producer identity. It writes only to `BIFROST_PERSONA_FEEDBACK_OBSERVATION_STORE_PATH`, never the outbound Discord command provider store or Bifrost-private binding/receipt state. It carries `feedback_only`; Bifrost—not VoidBot—classifies actor links, admits targets, and produces downstream cognition pressure.
