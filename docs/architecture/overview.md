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
      - PostgreSQL-backed jobs, audit events, and interaction memory
      - persistent local archives for RAG
      - Qdrant or local JSON vector stores for retrieval
```

## Current state

- `apps/bot` owns Discord connectivity, routing, and command handling.
- `apps/worker` polls owner jobs, runs the local Discord-safe Codex lane, serves bounded history-search tool requests from the RAG index, and prepares handoff bundles when needed.
- `packages/core` contains permissions, context assembly, Postgres-backed state storage, style loading, and the rotating system message catalog.
- `packages/providers` isolates provider contracts from Discord code.
- `packages/rag` contains the message archive, chunking pipeline, local embedding backends, pluggable vector-store backends, and log import state.
- `packages/sandbox` defines policy profiles and a dry-run policy runner.

VoidBot's Verse-facing service contract lives in
`docs/architecture/voidbot-verse-service-contract.md`. The short version:
VoidBot owns Discord cognition, archive/source retrieval, typed Void self-state,
and repo Face compatibility rails; Huginn owns Persona/.cc runtime inspection
stewardship; Bifrost owns governed work transport; Odin discovers
provider-owned CultMesh surfaces; Eve/CultUI is the presentation contract.

## Current shortcuts and tradeoffs

- Postgres now owns jobs, audit events, and interaction memory, but the archive side of RAG is still file-backed under `.voidbot/`.
- Retrieval now uses a persistent vector backend with a local embedding backend by default (`qwen3-embedding:0.6b` through Ollama).
- `VECTOR_STORE_KIND=local_json` keeps the zero-service path available for local development, but `VECTOR_STORE_KIND=qdrant` is now supported for a proper vector database.
- Discord history vectors and source-tree/lore vectors stay in separate physical partitions so source indexing no longer rewrites the entire history corpus.
- The bot live-ingests every message that matches the configured indexing rule and can also backfill from exported log files.
- Source and lore indexing can also be kicked off by local repo `pre-push` hooks, which launch a detached incremental resync of the pushed repo into the source archive and source-side vector store.
- The owner Codex flow can perform repeated read-only history searches through a bounded tool loop instead of relying on a single retrieval snapshot.
- Stock Discord replies are loaded from `config/system-messages.json` and rotated through shuffled variants to avoid repetitive canned responses.
- Changing embedding models requires a full vector rebuild from the archived messages, which is handled by `npm run rag:rebuild`.
- Local and offsite backups now have a verifier plus a recurring watchdog, so backup freshness and remote retention stop relying on operator vibes.
- `owner_codex` has two lanes:
  - `local_exec_owner_only` tries a read-only `codex exec` pass for direct Discord replies
  - `manual_package` remains available when you want explicit approval-gated packaging
- When the local Discord-safe lane is not enough, the worker posts a handoff notice and writes the full context bundle to `.voidbot/artifacts/<job-id>/`.
- The current swarm operator surface is published as an Eve/CultUI CultMesh
  provider at `asgard.starfire.voidbot/swarm/eve/tui`, backed by
  `.voidbot/status/cultmesh/voidbot-swarm-state.cc`; the legacy
  `cultmesh://voidbot.local/eve/providers/voidbot.swarm` key is only a route,
  and any generated browser page is only a debug lowering of that provider
  surface.

## Upgrade path

1. Keep the current `voidbot.swarm` CultMesh publication discoverable through Odin.
2. Add `.cc` witnesses or native typed CultCache documents for remaining JSON-only status surfaces before treating them as Verse state.
3. Move Persona and repo Face `.cc` inspection to Huginn-owned tooling while VoidBot remains the Discord compatibility carrier.
4. Publish separate Eve/CultUI surfaces for Discord, archive, source, repo Face, and swarm state instead of growing a bespoke dashboard authority.
5. Add a true restore drill path instead of stopping at backup verification plus freshness monitoring.
6. Add moderation, budgeting, and rate limits before enabling `openai_api` for member traffic.
7. Expand worker-side run records and admin tooling around the interaction memory/event stores.
8. Expand sandbox execution from dry-run policy checks to real constrained runners.
