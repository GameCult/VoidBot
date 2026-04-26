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
- Ops health, backup verification, offsite sync, and dashboard surfaces already exist.
- The new state/notes surfaces are now the continuity spine for future nontrivial work.

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
