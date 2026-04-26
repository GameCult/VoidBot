# VoidBot Current System Map

This note is the source-grounded description of how the live VoidBot stack is shaped right now. It is not a prose replacement for the code, and it is not a second canonical map. Its job is to explain the major organs and their data flow in plain language with concrete path anchors.

## Main Organs

- `apps/bot/src/discord-bot.ts`
  - Discord gateway, commands, mention handling, permissions, provider selection, rate-limit gating, and context assembly entrypoint.
- `apps/worker/src/index.ts`
  - owner-job poller, provider execution, handoff packaging, and MCP wiring for the worker-side lane.
- `apps/worker/src/mcp-server.ts`
  - read-only retrieval tools and resource surfaces for archived history, indexed repos, lore, and owner notifications.
- `packages/core/src/state-storage.ts`
  - Postgres-backed durable state for jobs, audit events, interaction memory, and Void usage rate-limit counters.
- `packages/core/src/context-builder.ts`
  - request context assembly, including interaction-memory/profile attachment.
- `packages/providers/src/owner-codex-provider.ts`
  - Discord-safe `codex exec` lane, read-only tool policy, source-grounding enforcement, traces, handoff behavior.
- `packages/providers/src/local-llm-provider.ts`
  - Ollama chat lane with a bounded host-managed read-only tool loop.
- `packages/rag/src/retrieval-service.ts`
  - high-level history/source retrieval API used by bot, worker, and provider tool loops.
- `packages/rag/src/qdrant-vector-store.ts`
  - Qdrant vector persistence for history and source collections.
- `packages/rag/src/message-archive.ts`
  - archived Discord message store under `.voidbot/rag/messages.json`.
- `packages/rag/src/source-document-archive.ts`
  - archived source/lore document store under `.voidbot/rag/source-documents.json`.

## Flow 1: Discord Request To Provider

1. `apps/bot/src/discord-bot.ts` receives a slash command or mention-driven request.
2. Permission checks run through `packages/core/src/permission-engine.ts`.
3. Void usage limits are applied through `packages/core/src/void-usage-rate-limiter.ts` backed by `packages/core/src/state-storage.ts`.
4. `packages/core/src/context-builder.ts` assembles request context, including recent interaction profile and any retrieval hints.
5. Provider selection goes through `packages/providers/src/index.ts`.
6. The bot either:
   - answers directly through `local_llm`, or
   - queues an owner job for the worker / `owner_codex` path.

## Flow 2: Owner Job Execution

1. `apps/worker/src/index.ts` polls approved jobs from durable state.
2. The worker claims a job and dispatches it to the configured provider.
3. `packages/providers/src/owner-codex-provider.ts` runs `codex exec` in the bounded lane, exposes the VoidBot MCP server, records traces, and enforces source grounding for repo/lore/project questions.
4. If the answer fits the Discord-safe lane, the worker posts it back.
5. If the task needs deeper work, the worker writes a handoff bundle under `.voidbot/artifacts/<job-id>/` and posts the handoff response.

## Flow 3: Retrieval And Indexing

1. `packages/rag/src/message-archive.ts` and `packages/rag/src/source-document-archive.ts` keep the raw corpora.
2. `packages/rag/src/retrieval-service.ts` translates history/source queries into vector lookups plus metadata filters.
3. `packages/rag/src/qdrant-vector-store.ts` executes the live vector lookups against separate history and source collections.
4. `scripts/index-source-repos.ts` and `scripts/git-post-push-index.mjs` drive detached source/lore reindex work.
5. `apps/worker/src/mcp-server.ts` exposes retrieval to Codex and other sessions through `search_history`, `get_message_context`, `search_sources`, `get_source_context`, and `list_indexed_repos`.

## Flow 4: Ops And Recovery

- `scripts/start-voidbot-stack.ps1`
  - stack bootstrap, health checks, fresh build, stale-process cleanup, bot/worker restart, runtime status emission.
- `scripts/check-voidbot-operations.ps1`
  - watchdog for process liveness, Qdrant, Postgres, Ollama, Discord auth, backup freshness, and offsite sync freshness.
- `scripts/backup-voidbot-state.ps1`
  - local backup of Postgres, Qdrant snapshots, and RAG archives.
- `scripts/restore-voidbot-state.ps1`
  - local restore path.
- `scripts/sync-voidbot-backup-offsite.ps1`
  - verified offsite backup sync to the Qwen box.
- `scripts/voidbot-operations-dashboard-lib.ps1`
  - dashboard rendering for the local ops surface.

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
  - job artifacts and traces
  - logs and status files
  - backups and snapshots

The important scar is that these stores are split on purpose. Do not casually weld them back into one convenient blob and act surprised when it becomes a moon.
