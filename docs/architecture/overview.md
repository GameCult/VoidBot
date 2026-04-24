# VoidBot Architecture Overview

This initial scaffold follows the phase-one shape from the spec:

```text
Discord Gateway
  -> Command Router
  -> Permission Engine
  -> Context Builder
  -> Job Queue
  -> Provider Adapter
  -> Storage Layer
      - file-backed queue and audit log for local development
      - PostgreSQL schema draft in packages/core/sql/bootstrap.sql
      - persistent local archive and vector index for RAG
```

## Current state

- `apps/bot` owns Discord connectivity, routing, and command handling.
- `apps/worker` polls owner jobs, runs the local Discord-safe Codex lane, serves bounded history-search tool requests from the RAG index, and prepares handoff bundles when needed.
- `packages/core` contains permissions, context assembly, job storage, audit logging, style loading, and the rotating system message catalog.
- `packages/providers` isolates provider contracts from Discord code.
- `packages/rag` contains the message archive, chunking pipeline, local embedding backends, pluggable vector-store backends, and log import state.
- `packages/sandbox` defines policy profiles and a dry-run policy runner.

## Deliberate shortcuts in this first pass

- Job storage and audit events are file-backed under `.voidbot/` so the bot and worker can function immediately.
- The relational schema is drafted but not yet wired into a real repository implementation.
- Retrieval now uses a persistent vector backend with a local embedding backend by default (`qwen3-embedding:0.6b` through Ollama).
- `VECTOR_STORE_KIND=local_json` keeps the zero-service path available for local development, but `VECTOR_STORE_KIND=qdrant` is now supported for a proper vector database.
- Discord history vectors and source-tree/lore vectors stay in separate physical partitions so source indexing no longer rewrites the entire history corpus.
- The bot live-ingests every message that matches the configured indexing rule and can also backfill from exported log files.
- The owner Codex flow can perform repeated read-only history searches through a bounded tool loop instead of relying on a single retrieval snapshot.
- Stock Discord replies are loaded from `config/system-messages.json` and rotated through shuffled variants to avoid repetitive canned responses.
- Changing embedding models requires a full vector rebuild from the archived messages, which is handled by `npm run rag:rebuild`.
- `owner_codex` has two lanes:
  - `local_exec_owner_only` tries a read-only `codex exec` pass for direct Discord replies
  - `manual_package` remains available when you want explicit approval-gated packaging
- When the local Discord-safe lane is not enough, the worker posts a handoff notice and writes the full context bundle to `.voidbot/artifacts/<job-id>/`.

## Upgrade path

1. Replace the file-backed queue and audit log with PostgreSQL-backed repositories.
2. Cut production deployments over to Qdrant while keeping separate collections for Discord history and source/lore corpora.
3. Add moderation, budgeting, and rate limits before enabling `openai_api` for member traffic.
4. Expand sandbox execution from dry-run policy checks to real constrained runners.
