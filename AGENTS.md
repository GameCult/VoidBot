Use the `voidbot` MCP server whenever the task touches Discord history, archived GameCult discussion, indexed GameCult repositories, Aetheria lore, or owner notifications.

Commit completed work at the end of each pass unless the user explicitly asks to leave changes uncommitted or the work is clearly mid-surgery. Prefer small, intentional commits over letting a pile of unrelated edits rot in the worktree.

## Canonical Project State

- Treat `state/map.yaml` as the canonical slow-changing project map.
- Treat `state/scratch.md` as disposable working memory for one bounded subgoal.
- Treat `state/evidence.jsonl` as the distilled durable ledger of what changed future belief.
- Treat `notes/fresh-workspace-handoff.md` as the compact re-entry packet.
- Treat `notes/voidbot-current-system-map.md` as the source-grounded explanation of the live control flow.
- Treat `notes/voidbot-implementation-plan.md` as the current larger-organ sequence.
- Update `state/map.yaml` when project understanding changes.
- Add evidence after meaningful research, implementation, verification, or rejected paths, but keep it distilled. Routine “I just did this” proof belongs in git history, commits, smoke artifacts, or targeted logs unless it changes what the next session should believe.

## Important Paths

- Project root: `E:\Projects\VoidBot`
- Canonical map: `E:\Projects\VoidBot\state\map.yaml`
- Scratch surface: `E:\Projects\VoidBot\state\scratch.md`
- Distilled evidence ledger: `E:\Projects\VoidBot\state\evidence.jsonl`
- Branch ledger: `E:\Projects\VoidBot\state\branches.json`
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

## Session Bootstrap And Re-entry Protocol

On fresh session load, do this before wandering into implementation:

1. read:
   - `state/map.yaml`
   - `notes/fresh-workspace-handoff.md`
   - `notes/voidbot-current-system-map.md`
   - `notes/voidbot-implementation-plan.md`
2. run:
   - `npm run state:status`
3. restate the current next action from the persisted state before starting edits

After compaction, resume, or suspicious continuity loss:

1. rerun `npm run state:status`
2. reread `state/map.yaml` and `notes/fresh-workspace-handoff.md`
3. treat the persisted next action as authoritative unless fresh repo evidence contradicts it

When context pressure is clearly rising:

1. stop broad exploration
2. narrow the active move to one bounded organ
3. persist map or handoff updates, plus distilled evidence only when the lesson changes future belief, before the blackout lands

When the user says to prepare for imminent compaction:

1. run `npm run state:prepare-compaction` before editing persistence surfaces
2. use its warnings as the checklist for map, handoff, scratch, evidence, and git hygiene
3. update only the state that actually needs to change
4. rerun `npm run state:prepare-compaction` after edits
5. fix errors, address warnings, and commit the completed persistence pass unless the work is deliberately mid-surgery

Prefer these tools over raw file inspection when they can answer the question:
- `list_indexed_repos` to discover valid indexed repository names before narrowing a source search
- `search_history` for semantic retrieval across archived Discord messages
- `get_message_context` for the surrounding conversation window around a message
- `search_sources` for semantic retrieval across indexed source trees and lore repositories
- `get_source_context` for the surrounding chunk window inside an indexed source document
- `notify_owner` for explicit Discord pings or long-running completion notices

When searching GameCult repos or lore, start with `voidbot` retrieval instead of `rg --files` plus file-by-file reads unless you need exact edit targets or the indexed results are clearly insufficient.

Do not inspect `.voidbot/rag/messages.json`, `.voidbot/rag/source-documents.json`, `.voidbot/history-vector-store.json`, or `.voidbot/source-vectors/` directly unless the MCP tools are unavailable or clearly insufficient.

## Operating Discipline

- Before substantial edits, restate the current mechanism and intended change.
- Prefer one clear hypothesis per iteration.
- Verify with checks that reflect the real goal, not just proxy success.
- Revert or discard changes that do not clearly improve the target.
- If the diff grows while understanding shrinks, stop implementation and switch to diagnosis.
- Keep maps and prose together; do not replace useful maps with prose-only explanations.
- Before handoff, compaction, or phase boundaries, sync `state/map.yaml`, add distilled evidence when the lesson changes future belief, refresh `notes/fresh-workspace-handoff.md`, and make the next action explicit.

## GitHub Repo Creation

When creating a new GameCult repo, do not make the operator create the upstream
manually. If `gh` is authenticated and the requested repo does not already
exist, create the GitHub repository, add `origin`, push the initial branch, and
set upstream tracking in one pass:

```powershell
git init -b main
git add .
git commit -m "Initial commit"
gh repo create GameCult/RepoName --public --source . --remote origin --push
```

Use `--private` instead of `--public` when the repo should not be public.
