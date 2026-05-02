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
- State storage is no longer one persistence omnibus; `packages/core/src/state-storage.ts` is now a thin factory over domain-specific Postgres/file store modules plus bootstrap/migration helpers.
- Source archive storage is no longer one giant JSON monolith; `packages/rag/src/source-document-archive.ts` now keeps a small manifest at `.voidbot/rag/source-documents.json` and per-repo shards under `.voidbot/rag/source-documents.repos/`.
- Ops health, backup verification, offsite sync, and dashboard surfaces already exist.
- The stack has a dedicated logon startup task path now, so a reboot does not have to mean manual necromancy for bot and worker.
- The operations watchdog now supports ignored local extension checks, so adjacent-service fire signals can ride the same owner DM alert path without hardcoding private project gossip into the public repo.
- Source repo discovery now reconciles automatically during `npm run stack:start` and through the watchdog path, so new repos under `SOURCE_REPO_ROOT` stop waiting for manual hook folklore before they get indexed.
- Source-grounding hints are advisory now; the owner and local lanes can decide when repo or lore tool use is actually warranted instead of obeying a lexical front-door veto.
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
