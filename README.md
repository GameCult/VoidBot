# VoidBot

`TypeScript workspace` · `Discord bot` · `Codex MCP` · `Qdrant` · `Ollama`

VoidBot is a Discord-native assistant for GameCult.

It can answer from archived Discord history, indexed GameCult repos, and Aetheria lore, then hand deeper work off to Codex when Discord stops being a sane place to do it. The current build already supports real Discord replies, semantic retrieval, source and lore indexing, and Codex handoff flows.

Future GameCult subsite flavor:

> Meta-commentary as a weather system: little minds standing in the rain going "is this praxis or am I just damp?"

## What VoidBot Can Do

- answer owner questions through a Discord-safe `codex exec` lane
- use real MCP tools for archived Discord history, repo search, lore lookup, and owner notifications
- keep an explicit per-speaker interaction memory for direct conversations and ambient mentions of Void
- index live Discord traffic for selected channels
- backfill old Discord exports into the archive
- index source trees and lore repos with local Ollama embeddings
- run semantic retrieval on either local JSON shards or Qdrant
- use a remote Ollama chat model for the `local_llm` provider
- kick off detached source reindex jobs from local Git push hooks

## At A Glance

```mermaid
flowchart LR
  Discord["Discord"] --> Bot["apps/bot"]
  Bot --> Worker["apps/worker"]
  Bot --> History["Discord archive"]
  Worker --> Codex["Codex exec / MCP"]
  Worker --> Sources["Source + lore archive"]
  History --> Qdrant["Qdrant"]
  Sources --> Qdrant
  Codex --> Qdrant
  Ollama["Ollama"] --> Qdrant
  Ollama --> Worker
```

## Current Shape

The repo is split into a bot, a worker, and a handful of focused packages:

- `apps/bot`: Discord gateway, commands, permissions, and request assembly
- `apps/worker`: background job execution and the Void MCP server
- `packages/core`: queueing, audit log, permissions, style packs, system messages
- `packages/providers`: `owner_codex`, `local_llm`, and provider registry glue
- `packages/rag`: archives, chunking, embedding backends, retrieval, vector stores
- `packages/config`: environment-driven configuration
- `packages/shared`: shared contracts and types
- `packages/sandbox`: policy-first sandbox scaffolding

The durable local state is split on purpose: Postgres holds jobs, audit events, and interaction memory, while `.voidbot/` keeps artifacts, archives, logs, and detached indexing status.

There is also a project-memory spine now for future Codex sessions: `state/map.yaml`, `state/scratch.md`, `state/evidence.jsonl`, `notes/fresh-workspace-handoff.md`, and the helper CLIs under `tools/`. The point is to rehydrate from canonical files instead of pretending the transcript will stay coherent forever.

## Quick Start

### 1. Configure `.env`

Copy `.env.example` to `.env`, then set at minimum:

- `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_OWNER_ID`

Recommended starting values:

```dotenv
ENABLED_PROVIDERS=owner_codex,local_llm
OWNER_CODEX_MODE=local_exec_owner_only
VECTOR_STORE_KIND=qdrant
RAG_EMBEDDING_BACKEND=ollama
RAG_OLLAMA_MODEL=qwen3-embedding:0.6b
STYLE_PACK_PATH=styles/void-default.md
SYSTEM_MESSAGES_PATH=config/system-messages.json
```

If you want the remote Ollama generation path too, configure:

- `LOCAL_LLM_OLLAMA_BASE_URL`
- `LOCAL_LLM_OLLAMA_MODEL`
- `LOCAL_LLM_SOCIAL_READ_OLLAMA_MODEL`
- `LOCAL_LLM_OLLAMA_TIMEOUT_MS`
- `LOCAL_LLM_OLLAMA_KEEP_ALIVE`
- `LOCAL_LLM_OLLAMA_THINK`
- `LOCAL_LLM_OLLAMA_NUM_CTX`
- `LOCAL_LLM_ALLOW_PUBLIC`

`LOCAL_LLM_ALLOW_PUBLIC=false` is the sane default. It keeps the local model restricted to admins and the configured owner while you test.
`LOCAL_LLM_OLLAMA_THINK=low` is a good default if you want better phrasing and a little more initiative without dragging reply time into the swamp.
`LOCAL_LLM_SOCIAL_READ_OLLAMA_MODEL` is optional. Leave it blank to reuse the main local reply model, or set it when you want the room-reading sidecar on a different model than the public/local response lane.

If you want a private local persona instead, point `STYLE_PACK_PATH` and `SYSTEM_MESSAGES_PATH` at your own ignored local files.

If you sometimes summon Void through a role mention instead of the bot user mention, set:

- `DISCORD_BOT_TRIGGER_ROLE_IDS`

That lets the history pipeline classify those messages as bot-directed prompts too.

Void usage limits are configurable too:

- `VOID_USAGE_COOLDOWN_SECONDS`
- `VOID_USAGE_DAILY_LIMIT`
- `VOID_USAGE_UNLIMITED_USER_IDS`
- `VOID_USAGE_UNLIMITED_ROLE_IDS`
- `VOID_USAGE_BOOST_USER_IDS`
- `VOID_USAGE_BOOST_ROLE_IDS`
- `VOID_USAGE_BOOST_MULTIPLIER`

The default shape is simple on purpose: everyone gets the base cooldown and daily cap, listed users or roles can be made unlimited, and listed users or roles can get a boosted lane that cuts cooldowns and multiplies daily allowance by `VOID_USAGE_BOOST_MULTIPLIER` (default `10`).

### 2. Install dependencies

```bash
npm install
npm run build
```

### 3. Pull the embedding model

VoidBot defaults to Ollama embeddings with `qwen3-embedding:0.6b`:

```bash
ollama pull qwen3-embedding:0.6b
```

`RAG_EMBEDDING_DIMENSIONS` only matters for the hash fallback backend. Ollama-backed embeddings report their own dimensions.

### 4. Start Postgres

VoidBot now keeps queue state, audit events, and interaction memory in Postgres. `npm run stack:start` will launch the local Docker Postgres container automatically for the default local DSN, but you can start it yourself if you want the database up first:

```bash
docker compose -f infra/postgres/docker-compose.yml up -d
```

The default local state-store config is:

```dotenv
STATE_STORAGE_BACKEND=postgres
DATABASE_DSN=postgres://voidbot:voidbot@localhost:5432/voidbot
```

### 5. Start Qdrant

Qdrant is the recommended vector backend now. It avoids the pain that comes from stuffing everything into local JSON and then acting surprised when the file turns into a small moon.

Windows helper path:

```bash
npm run qdrant:setup
```

Normal day-to-day startup after that:

```bash
npm run qdrant:up
```

Or run Qdrant manually:

```powershell
docker pull qdrant/qdrant
docker volume create voidbot_qdrant_storage
docker run -p 6333:6333 -p 6334:6334 -v voidbot_qdrant_storage:/qdrant/storage qdrant/qdrant
```

Then point the bot at it:

```dotenv
VECTOR_STORE_KIND=qdrant
QDRANT_URL=http://127.0.0.1:6333
QDRANT_HISTORY_COLLECTION=voidbot_discord_history_chunks
QDRANT_SOURCE_COLLECTION=voidbot_repository_source_chunks
```

If you already have local vectors and want to lift them into Qdrant without re-embedding:

```bash
npm run rag:migrate-qdrant
```

Use `-- --wipe` only when you intentionally want to replace the target collections.

### 6. Start the stack

The normal startup path is one command:

```bash
npm run stack:start
```

That script:

- verifies or starts local Postgres if `STATE_STORAGE_BACKEND=postgres`
- verifies Qdrant if `VECTOR_STORE_KIND=qdrant`
- checks the Ollama endpoints and required models
- rebuilds the workspace
- stops stale VoidBot bot/worker processes for this repo
- starts a fresh bot and worker pair
- writes runtime status to `.voidbot/status/runtime-stack.json`
- writes logs to `.voidbot/logs/bot.log` and `.voidbot/logs/worker.log`

If you do not want a reboot or fresh logon to leave the bot dead on the floor, install the startup task once:

```bash
npm run state:install-startup-task
```

That creates the `VoidBot Stack Startup` scheduled task, which runs `scripts/start-voidbot-stack.ps1` at logon through the same hidden launcher shim the other ops tasks use.

If you want the raw split-terminal path for debugging, those still exist:

```bash
npm run dev:bot
```

```bash
npm run dev:worker
```

If `DISCORD_APPLICATION_ID` and `DISCORD_GUILD_ID` are set, the bot registers slash commands into that guild on startup.

For `owner_codex`, the worker also needs a working local Codex CLI. If plain `codex` is not invokable from Node on your machine, point `CODEX_EXECUTABLE` and `CODEX_EXEC_ARGS` at the actual install. `CODEX_MODEL` pins the owner Discord lane to a specific model; the default is `gpt-5.4` so older local Codex installs do not faceplant on `gpt-5.5`.

## Example Questions

Things you can ask right now:

- `@Void what did we decide about the website roadmap last year?`
- `@Void summarize prior discussion about ship movement in nautical`
- `/ask provider:local_llm question: where is the MCP server registering search_sources?`
- `/ask provider:local_llm question: what does Aetheria lore say about FTL corporations?`
- `/search-history query: favorite algorithm`

## How The Main Flows Work

### Owner Discord flow

Default mode is `local_exec_owner_only`:

1. The owner uses `@Void ...` or `/ask`.
2. The bot queues an auto-approved owner job.
3. The worker runs `codex exec` in a read-only, Discord-safe lane.
4. Codex can call Void MCP tools such as `search_history`, `get_message_context`, `search_sources`, `get_source_context`, and `list_indexed_repos`.
5. If the answer is short and safe, the worker posts it back to Discord.
6. If the task needs broader tools, file edits, or a deeper investigation, the worker posts a handoff notice and writes a bundle under `.voidbot/artifacts/<job-id>/`.

`/queue-codex` skips the direct-reply attempt and forces the handoff path.

### Manual fallback

`manual_package` still exists when you want the stricter, explicit workflow:

1. Queue a job.
2. Approve it with `/approve-job`.
3. Let the worker write `request.md` and `request.json`.
4. Run the deeper work manually.
5. Approve any final public reply separately.

### Local Ollama flow

The `local_llm` provider uses Ollama chat completion plus a bounded host-managed read-only tool loop. It can use:

- `search_history`
- `get_message_context`
- `search_sources`
- `get_source_context`
- `list_indexed_repos`

Unlike the owner Codex lane, this is not MCP. It is a tighter host-controlled loop and deliberately excludes side-effecting tools.

Project, repo, and lore questions should lean on the source-side lookup tools when the answer depends on indexed repo or lore facts. The providers now treat source-grounding hints as advisory instead of letting a dumb lexical hall monitor veto the whole reply before the model can think.

## Discord, Repo, And Lore Indexing

### Discord history

Discord history is live and incremental:

- matching channels are ingested on `MessageCreate`
- edits are re-upserted
- deletes remove indexed chunks
- bot-directed prompts stay in the raw archive but are excluded from default semantic history indexing and lexical fallback, so the bot stops poisoning its own memory with repeated summons
- `/reindex-channel` replays the most recent 100 messages from the current indexed channel
- exported logs can be backfilled later

Channel selection is controlled by:

- `INDEX_ALL_CHANNELS=true` or `INDEXED_CHANNEL_IDS=...`
- `EXCLUDED_CHANNEL_IDS`
- `EXCLUDED_CHANNEL_NAMES`

Backfill old exports with:

```bash
npm run rag:backfill -- --input /path/to/discord-logs
```

Useful flags:

- `--no-recursive`
- `--all-channels`

If you need to mark old bot-directed prompts in the archive and prune their history vectors without deleting the raw messages:

```bash
npm run rag:scrub-bot-prompts
```

### Source repos and lore

Source indexing is incremental when you run it. The pipeline crawls the repo, compares the current documents to the archived source snapshot, deletes vectors for changed or removed source IDs, and upserts only the changed chunks.

Configure:

- `SOURCE_REPO_ROOT`
- `SOURCE_REPO_PATTERNS`
- `SOURCE_REPO_INCLUDE_PREFIXES`
- `RAG_SOURCE_ARCHIVE_PATH`
- `RAG_SOURCE_QUERY_INSTRUCTION`

Index everything that matches your repo patterns:

```bash
npm run rag:index-sources
```

Target specific repos:

```bash
npm run rag:index-sources -- --repo gamecult-site,AetheriaLore
```

Force a clean reindex for specific repos:

```bash
npm run rag:index-sources -- --repo AetheriaLore --force
```

Reconcile the discovered local repos against the source archive, install or refresh hooks, prune stale repo shards, and index anything new:

```bash
npm run rag:reconcile-sources
```

Recommended posture for a shared project root:

- `SOURCE_REPO_PATTERNS=*`
- `SOURCE_REPO_INCLUDE_PREFIXES=AetheriaLore:Aetheria/`

That keeps `AetheriaLore` focused on the useful subtree instead of indexing every random byproduct in the repo.

### Git push hook for source indexing

If you want local pushes to kick off source reindexing automatically:

```bash
npm run rag:install-push-hooks
```

Git does not provide a client-side `post-push` hook, so VoidBot installs a chained `pre-push` hook instead. That hook returns quickly, launches a detached incremental reindex for the pushed repo, and preserves any existing `pre-push` hook by backing it up to `pre-push.voidbot.prev` and running it first.

What that actually means:

- the resync starts on your local machine during `git push`, from the hooked repo's `pre-push` hook
- it updates the local source archive plus the source-side vector store (`Qdrant` if enabled, otherwise the local JSON shard backend)
- it only reindexes the repo being pushed, not every repo in `SOURCE_REPO_ROOT`
- it does not wait for the remote push to succeed, because Git does not give us a real client-side `post-push`
- pushes from some other machine do nothing here unless that machine also has the hook installed
- if a resync for that repo is already running, the hook records `already_running` in the status file and does not start a second one

Progress for those detached runs lives here:

- status: `.voidbot/status/source-hooks/<repo>.json`
- log: `.voidbot/logs/source-hooks/<repo>.log`

That gives you a real polling path instead of an attached session silently rotting while you wonder whether it hung.

### Automatic repo discovery and repair

VoidBot now also reconciles the repo set automatically:

- `npm run stack:start` runs `npm run rag:reconcile-sources` before the bot and worker come back
- `npm run state:check` compares discovered repos under `SOURCE_REPO_ROOT` to the indexed archive and will launch detached repair work if new repos exist
- the reconcile pass refreshes hooks, indexes newly discovered repos, and prunes stale repo shards for repos that no longer exist under the configured root

The old “install hooks once and hope forever” story is dead. New repos under the configured root should get picked up by normal startup and watchdog operations without manual babysitting.

### Source archive layout

The source archive is no longer one giant `source-documents.json` blob trying to die dramatically at scale.

- `RAG_SOURCE_ARCHIVE_PATH` now stores a small repo-summary manifest
- per-repo source documents live under the sibling shard directory `source-documents.repos/`

That keeps incremental repo writes bounded to the repo that actually changed instead of rewriting the whole corpus every time one new project appears.

## Codex Integration

This repo includes a project-scoped `.codex/config.toml`, so Codex sessions opened in `E:\Projects\VoidBot` can use Void's MCP tools automatically.

If you want the same MCP server available from Codex outside this repo:

```bash
npm run codex:mcp:install
```

That registration is global, not workspace-local. You can verify it from anywhere with:

```bash
codex mcp get voidbot
```

Current MCP tools:

- `search_history`
- `get_message_context`
- `search_sources`
- `get_source_context`
- `list_indexed_repos`
- `huginn_read_persona_state`
- `huginn_apply_persona_state_operation`

`read_repo_face_state` and `apply_repo_face_state_operation` remain
compatibility aliases, but Huginn owns Persona-state inspection and mutation
stewardship. VoidBot is only the legacy MCP carrier. The runtime owner is
CultCacheTS/Huginn, whose next proper surface is a CultMesh provider publishing
read-only Eve DSL for `.cc` files. Consuming runtimes lower that DSL into their
own UI.
- `notify_owner`

Notes:

- read-only retrieval tools work in unattended `codex exec` runs
- side-effecting MCP tool calls still run into approval limits in unattended mode
- the owner Discord lane handles notifications through a host-mediated notification intent instead

To remove the shared Codex registration later:

```bash
npm run codex:mcp:remove
```

## Maintenance

If you change the embedding backend or model, rebuild the vector index from the archived corpora:

```bash
npm run rag:rebuild
```

If you still have an old mixed local JSON vector store from earlier builds, migrate it once before moving on:

```bash
npm run rag:migrate-vector-layout
```

Manual local state backups now have a real path instead of vibes:

```bash
npm run state:backup
```

Optional label:

```bash
npm run state:backup -- -Label before-big-reindex
```

That backup contains:

- a `pg_dump` custom-format dump for Postgres jobs, audit events, and interaction memory
- Qdrant snapshots for every collection currently on the local node
- copies of `.voidbot/rag/*` so archive-backed rebuild provenance does not evaporate

Backups are written under `.voidbot/backups/<timestamp>[-label]/` with a `manifest.json`.

Restore the newest backup:

```bash
npm run state:restore
```

Restore a specific backup directory:

```bash
npm run state:restore -- -BackupPath E:\Projects\VoidBot\.voidbot\backups\<timestamp>
```

The backup and restore scripts stop the local bot/worker first and restart them afterward if they were already running. Because the local Qdrant node is shared, the backup path snapshots every collection on that node, not just the two VoidBot ones.

For the next rung up from "local recovery only", VoidBot can also push nightly backup archives to an SSH-reachable offsite box:

```bash
npm run state:sync-offsite
```

That flow:

- runs the normal local backup first
- verifies the fresh backup before it is allowed anywhere near the wire
- compresses the resulting backup directory into a zip archive
- uploads it over `sftp`
- keeps a bounded number of scheduled local backup directories
- prunes older remote zip archives after upload
- writes status to `.voidbot/status/offsite-backup.json`
- appends logs to `.voidbot/logs/offsite-backup.log`

Install the daily scheduled task:

```bash
npm run state:install-offsite-task
```

Defaults come from `.env` / `.env.example`:

- `OFFSITE_BACKUP_SSH_TARGET`
- `OFFSITE_BACKUP_REMOTE_WINDOWS_DIR`
- `OFFSITE_BACKUP_REMOTE_SFTP_DIR`
- `OFFSITE_BACKUP_LOCAL_KEEP_LATEST`
- `OFFSITE_BACKUP_REMOTE_KEEP_LATEST`
- `OFFSITE_BACKUP_LABEL`
- `OFFSITE_BACKUP_TASK_NAME`
- `OFFSITE_BACKUP_TASK_TIME`

The scheduled task uses `Interactive` logon on Windows so it can see the current user's SSH key material. That means the backup job is intended for a workstation session that stays logged in; it is not pretending to be a hardened headless backup appliance.

There is also a recurring watchdog now, so the stack can stop being quiet when it drifts:

```bash
npm run state:check
```

That check covers:

- bot and worker process liveness from `.voidbot/status/runtime-stack.json`
- Qdrant reachability and required collection presence
- Postgres container health and required table presence
- local and remote Ollama model availability
- Discord bot token validity
- latest local backup verification and freshness
- offsite task presence, remote archive freshness, and retention count

It writes status to `.voidbot/status/operations-health.json` and appends logs to `.voidbot/logs/operations-watchdog.log`.

If you want an actual local dashboard instead of spelunking JSON by candlelight:

```bash
npm run state:dashboard
```

That renders `.voidbot/status/operations-dashboard.html`, opens it in your default browser, and auto-refreshes every 10 seconds. The watchdog now also writes a live run-state file while it is executing, so a hidden task that wedges should stay visibly stuck on its last known step instead of failing in perfect silence.

Install the recurring watchdog task:

```bash
npm run state:install-watchdog-task
```

Defaults come from `.env` / `.env.example`:

- `VOIDBOT_BACKUP_MAX_AGE_HOURS`
- `VOIDBOT_OFFSITE_BACKUP_MAX_AGE_HOURS`
- `VOIDBOT_HEALTHCHECK_NOTIFY_REPEAT_HOURS`
- `VOIDBOT_HEALTHCHECK_TASK_NAME`
- `VOIDBOT_HEALTHCHECK_INTERVAL_MINUTES`

The watchdog task also uses `Interactive` logon because the remote freshness check relies on the same local SSH key material as the offsite sync path.

## Moderator Review Loop

Void can also keep a sandboxed little moderator brain running on a schedule without turning the live bot into an auto-ban carnival.

Tracked prompt surfaces:

- `config/discord-server-rules.md`
- `config/moderation-review-agent.md`
- `prompts/void-memory-maintenance.md`
- `prompts/void-moderator-rumination.md`
- `styles/void-default.md`

Local moderation-state surfaces:

- `.voidbot/private/void-self-state.cc`: canonical typed CultCache self-state
- `.voidbot/status/moderation-rumination-context.json`: bounded prompt-facing run context
- `.voidbot/status/moderation-rumination-operations.json`: child-proposed typed operation payloads
- `.voidbot/status/void-memory-maintenance-context.json`: bounded prompt-facing memory-maintenance context
- `.voidbot/status/void-memory-maintenance-operations.json`: child-proposed memory/incubation/candidate operations

Chronological recent-history helper:

```bash
node scripts/export-recent-discord-history.mjs --hours 6 --limit 120
```

Random archive-dive helper for novelty pressure:

```bash
node scripts/export-random-discord-history.mjs --window 6 --min-content-length 24
```

Direct bot-voice send helper for unattended moderation runs:

```bash
node scripts/send-discord-message.mjs --owner-dm
```

or

```bash
node scripts/send-discord-message.mjs --channel-id <channel-id> --reply-to <message-id>
```

If one of the swarm agents should speak as itself through the shared Discord pipe instead of the base Void identity:

```bash
node scripts/send-discord-message.mjs --channel-id <channel-id> --persona-name "Ghostlight Archivist" --persona-avatar-url "https://example.com/avatar.png"
```

Install or refresh the scheduled task:

```bash
npm run state:install-moderation-task
npm run state:install-mood-task
```

The runner records its pulse here:

- `.voidbot/status/moderation-rumination.json`
- `.voidbot/logs/moderation-rumination.log`
- `.voidbot/logs/moderation-rumination-last.jsonl`

That helper exists because semantic `search_history` is good at recall and bad at simple heartbeat duty. The moderator loop can use it to see what changed since its last cursor, then fall back to `search_history`, `get_message_context`, `list_indexed_repos`, `search_sources`, and `get_source_context` when it wants deeper social or project context.
There is also a repo-weather helper:

```bash
npm run moderation:recent-repo-activity -- --hours 96 --max-commits 3
```

That gives the loop a compact digest of recent commit motion across every tracked source repo, so Void can notice the broader experiment zoo instead of only sniffing whatever one thread happened to say out loud.

The moderator state is now typed CultCache state, not an editable Ghostlight-shaped JSON projection. The typed documents own profile, moderation cursor/open cases, speech receipts, thought memory/incubation, scheduled runtime, agency pressure, candidate interventions, and Face affect. Repo Face reads also emit `gamecult.persona_state.v0` as a portable projection for shared Persona interop. Huginn owns the Persona/.cc inspection runtime; VoidBot's MCP state tools are a compatibility carrier until CultCacheTS publishes the same read-only inspection through CultMesh as Eve DSL. The old JSON projection, state template, and context exporter are gone.
The typed rumination runner can still think about GameCult projects, archived Discord seams, indexed repos, recent cross-repo commit motion, and lore, but durable changes must come back as typed operation payloads. The child does not edit state.
The mood-drift task owns the sleep transition. Rumination writes short-term memory only; when Void is napping, mood drift invokes `scripts/run-void-memory-maintenance.ps1` once per nap unless the pass already completed for that nap. Memory maintenance reads typed self-state, loads `prompts/void-memory-maintenance.md`, and applies only memory/incubation/candidate typed operation proposals. Short-term memories do not survive sleep unless promoted into durable memory or merged into incubation; the runner fails a real sleep pass that leaves short-term residue behind. Use `-StateFilePath` for fixture stores, `--skip-memory-maintenance` on `simulate-void-mood.mjs` for smoke runs that must not invoke Codex, and `npm run moderation:memory-maintenance:sleep-fixture` to exercise the non-skip model branch with a fake Codex child. Dream residue, identity crystallization, value pressure, and other agency behavior still have to come back through that operation boundary. No compatibility séance.
Long-term memory is durable, not frozen. Sleep can promote short-term residue into durable memory, and later maintenance can explicitly revise, retire, or crystallize durable memories instead of silently overwriting Void's past thoughts. Use `npm run moderation:memory-lifecycle:fixture` to verify promotion, revision, retirement, and crystallization into an identity memory plus self-profile value. The live language is anchors, not courtroom evidence: a thought needs something that made it real, whether that is room context, repo motion, source/lore retrieval, a prior memory, or self-state pressure.
Agency pressure is also typed state now, not hard-wired behavior. `upsert_agency_pressure` records sustained discomfort, active tension, self-advocacy requests, and world-advocacy requests as first-class pressure; candidate interventions may emerge from that pressure, but they are not the pressure itself. Use `npm run moderation:agency-pressure:fixture` to verify agency pressure enters the `.cc`, appears in the self-state summary, and contributes to mood speaking pressure.
Directly invoked live replies read the same typed private self-state as a distilled self-state attachment. When the sleep projection says Void is napping, the direct reply path skips the expensive room-read sidecar, avoids normal attentive service-work, and answers in brief sleepy grumbles instead.
The moderation loop now speaks through the local bot token instead of approval-gated side-effecting MCP tools, so unattended runs can DM or post without making Codex stop and ask your permission every time it finds a mouthful of words.

## Persistent Project State

VoidBot is now large enough that transcript memory alone is a stupid way to steer it. The repo carries a small canonical project-state scaffold for future sessions:

- `state/map.yaml`: slow-changing canonical project map and current next action
- `state/scratch.md`: disposable one-subgoal working memory
- `state/branches.json`: hypothesis / branch ledger
- `state/evidence.jsonl`: distilled belief-changing evidence, rejections, and scars
- `notes/fresh-workspace-handoff.md`: re-entry packet
- `notes/voidbot-current-system-map.md`: source-grounded control-flow explanation
- `notes/voidbot-implementation-plan.md`: larger-organ build order

Useful commands:

```bash
npm run state:status
npm run state:prepare-compaction
```

For direct edits to the ledger surfaces:

```bash
npx tsx tools/voidbot_state.ts add-evidence --type research --status ok --note "..."
npx tsx tools/voidbot_state.ts add-branch --id branch-id --hypothesis "..."
```

## Commands

Current slash commands:

- `/ask`
- `/queue-codex`
- `/approve-job`
- `/reject-job`
- `/provider-status`
- `/search-history`
- `/summarize-channel`
- `/reindex-channel`
- `/set-style`

Some commands are full working paths. Some are still thin MVPs. They exist because the structure is real, not because the system is pretending to be finished.

## Important Files

Useful local state and docs:

- `.voidbot/artifacts/<job-id>/`: handoff bundles, stdout, stderr, traces
- `.voidbot/rag/messages.json`: archived Discord messages
- `.voidbot/rag/source-documents.json`: archived source and lore documents
- `.voidbot/rag/import-state.json`: log-backfill file state
- `.voidbot/status/runtime-stack.json`: live stack status, service reachability, and bot/worker PIDs
- `.voidbot/status/offsite-backup.json`: latest offsite backup sync result
- `.voidbot/status/operations-health.json`: latest watchdog health report
- `.voidbot/status/operations-watchdog.json`: live watchdog run-state plus last notification metadata
- `.voidbot/status/operations-dashboard.html`: auto-refreshing local operations dashboard
- `state/map.yaml`: canonical project map and current next action
- `state/evidence.jsonl`: distilled project-memory ledger
- `notes/fresh-workspace-handoff.md`: re-entry packet for future sessions
- `notes/voidbot-current-system-map.md`: source-grounded system map
- `notes/voidbot-implementation-plan.md`: larger-organ plan
- `config/system-messages.json`: rotating stock system messages
- `styles/void-default.md`: public default style pack
- `docs/architecture/overview.md`: higher-level architecture notes
- `packages/core/sql/bootstrap.sql`: PostgreSQL schema for jobs, audit events, and interaction memory

## Safety Boundaries

- `owner_codex` hard-rejects non-owner traffic
- the Discord-safe owner lane is read-only
- the bot does not expose arbitrary shell execution
- deeper tasks are handed off instead of turning Discord into a cursed remote terminal
- sandbox support is still policy-first and dry-run only
- `manual_package` remains available when you want explicit review points

## Development Roadmap

Reasonable next steps from here:

1. Add a real scheduled restore drill instead of stopping at backup verification and freshness checks.
2. Expand worker processing into richer provider run records, moderation hooks, and admin inspection tools.
3. Replace the remaining scaffolded provider paths with funded, production-grade implementations.
4. Add real constrained sandbox execution instead of policy-only dry runs.

## Related Docs

- [SPEC.md](./SPEC.md)
- [Architecture Overview](./docs/architecture/overview.md)
- Deep agent-state, personality, culture, and persistent-world architecture now lives in the sibling `Ghostlight` repo.
- [TypeScript Workspace Decision](./docs/decisions/0001-typescript-workspace.md)
