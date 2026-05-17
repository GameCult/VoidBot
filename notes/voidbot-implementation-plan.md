# VoidBot Implementation Plan

This is the current forward plan for the next larger organs. It is not a changelog and it is not allowed to become a duplicate brain for the canonical map.

## Current Aim

The typed moderation, mood, sleep, agency, and private self-state boundary is live. The current goal is to let ordinary scheduling run, inspect the next unattended awake rumination and sleep cycle, and harden only the seams that show concrete failure. Void should answer Discord, remember useful social/project context, retrieve GameCult history/source/lore, and run an unattended moderation/participation loop without reviving JSON projection edits, legacy mirrors, or the swollen memory organ.

The next priority is observational hardening of the enabled typed loop. Agents and scheduled workers mutate typed CultCache-backed state through explicit operations, not by editing a whole-state JSON working copy. Sleep and memory distillation now preserve meaning-bearing claims/anchors/tensions in fixture and live-state passes, and short-term rumination has a clustering guard so repeated same-target/topic thoughts update one provisional memory instead of stacking duplicates. Keep checking ordinary cycles for abstraction sludge, duplicate speech, stale residue, or self-orbiting memories.

The center remains prevention, not legacy repair. The old brain is evidence of a failed boundary. The new brain rejects malformed memory at ingress so the runtime does not need a permanent cleanup bureaucracy to recover basic meaning.

## Smallest Coherent Architecture

### Durable State Model

- Postgres owns operational bot state:
  - jobs
  - audit events
  - interaction memory
  - provider runs
  - public usage/rate limits
- Qdrant owns semantic vectors:
  - Discord history vectors
  - source/lore vectors
- `.voidbot/` owns operational files:
  - raw Discord archive
  - source archive manifest and repo shards
  - provider artifacts/traces
  - logs/status/backups
- One polymorphic CultCache-backed `.cc` state authority owns private Void self-state through typed document kinds:
  - `void.self_profile`: identity, stable values, voice/personality configuration
  - `void.moderation_cursor`: reviewed Discord cursor, open room obligations
  - `void.speech_receipts`: recent delivered replies and dedupe keys
  - `void.thought_memory`: distilled memories, incubation threads, resonance summaries
  - `void.scheduled_runtime`: sleep cycle, speaking pressure, last run summaries
  - `void.agency_pressure`: discomforts, active tensions, and self/world advocacy pressure
  - `void.candidate_interventions`: drafts or requests that may become speech

CultCache does not need a separate physical store per state type; it is already polymorphic. The intended split is ownership by typed document kind and mutation contract, not a herd of little stores in fake mustaches. Each durable fact still has one owner. No top-level mirrors. No editable shadow copy pretending to be a harmless view.

### Runtime State Model

- Discord request runtime is an immutable request context:
  - prompt/message
  - actor/guild/channel
  - recent room transcript
  - interaction profile
  - optional situational read
  - retrieval hints/results
  - self-state summary projection
- Scheduled moderation runtime is a bounded pass context:
  - current cursor window
  - outstanding obligations
  - selected memory/thought summaries
  - selected repo/archive anchors
  - proposed state mutations
  - optional speech request
- Mood drift runtime is deterministic maintenance:
  - read stable self profile
  - update scheduled runtime pressure/sleep fields
  - request memory maintenance through typed operations
  - expose desire-to-speak as pressure, while rumination owns the model-written candidate text

Runtime context dies at the end of the pass unless an explicit typed mutation preserves a durable fact.

### Authoritative Boundaries

- Bot/worker/provider/RAG boundaries survive.
- CultCache self-state has one mutation authority: a typed state service over one polymorphic cache.
- Agents do not edit state files. They call tools such as:
  - `record_reviewed_messages`
  - `upsert_open_case`
  - `close_open_case`
  - `record_delivery_receipt`
  - `record_short_term_memory`
  - `merge_incubation_support`
  - `queue_candidate_intervention`
  - `retire_candidate_intervention`
  - `upsert_agency_pressure`
  - `retire_agency_pressure`
  - `update_sleep_cycle`
  - `update_speaking_pressure`
  - `propose_memory_distillation`
  - `apply_memory_distillation`
  - `revise_durable_memory`
  - `retire_durable_memory`
  - `crystallize_memory_into_identity`
  - `prune_short_term_memories`
- Model/agent output crosses the boundary as proposed operations, not as rewritten state.
- The state service validates, normalizes, dedupes, and writes.

### Boundary Messages

The clean crossing surface is small JSON command payloads, not a whole JSON state document:

```json
{
  "operation": "upsert_open_case",
  "sourceMessageId": "discord-message-id",
  "status": "pending",
  "summary": "What Void owes the room",
  "lastTouchedAt": "2026-05-16T00:00:00.000Z"
}
```

Memory-bearing operations have a stricter contract than historical projections. A new rumination memory is short-term and must carry:

- a concrete target
- a summary
- at least one claim or question
- a tension or counterweight
- an action implication
- anchors, or an explicit `anchor:missing` tag

If those fields are missing, the operation is invalid. This is the wall that keeps the next iteration from turning into topic sludge and asking cleanup to be its personality.

Short-term memory also has a self-novelty wall now. If a rumination write repeats an existing target/topic cluster, the state service keeps the existing source id, merges anchors/tags, and stores the incoming narrowed thought as the current working version. Same repo is not enough to merge; the topic pressure must overlap. This wall should preserve deepening, not forbid attention: saturation is about whether the thought is still gaining anchors, tension, and consequence, not whether the topic has appeared before.

```json
{
  "operation": "record_short_term_memory",
  "memory": {
    "memoryId": "mem-aquarium-body-workflow",
    "kind": "project_seam",
    "target": {
      "kind": "repo",
      "id": "AquariumSynthCSharp",
      "label": "AquariumSynthCSharp"
    },
    "summary": "Workflow cannot own the body.",
    "claim": "The implementation boundary should own runtime state instead of leaving workflow scripts to compensate for it.",
    "tension": "Workflow scripts are good at orchestration and bad at being an organism.",
    "actionImplication": "Move authority into the runtime boundary before adding more maintenance scripts.",
    "anchorRefs": [
      {
        "ref": "source:...",
        "kind": "source"
      }
    ],
    "createdAt": "2026-05-16T00:00:00.000Z",
    "updatedAt": "2026-05-16T00:00:00.000Z",
    "tags": []
  }
}
```

The runner can hand these to a CLI/MCP tool. The store decides what survives.

### Derived, Not Stored

- Self-state prompt summaries are derived from typed documents.
- Recent room context is derived from Discord archive and the current poll.
- Prompt-facing recent chronology is derived as relative phrases. Exact timestamps remain state/status/cursor data and should not be fed to the child rumination loop unless a tool or parent-owned operation specifically needs them.
- Topic saturation is derived from incubation/memory support, not separately stored as another truth.
- Source coverage is derived from recent anchors and repo/archive metadata.
- Need-to-speak can keep a small pressure field, but its inputs remain receipts, candidates, and time since last speech.
- Legacy top-level mirrors are deleted. If a consumer needs a projection, render it on demand.

### Delete Because It Compensates For Bad Ownership

- `.voidbot/private/moderation-agent-state.json` as an editable working projection.
- `legacyJsonPath`/working-path duality for canonical self-state.
- Top-level mirror fields beside the old legacy runtime object.
- Any helper that mutates the JSON projection and commits it back.
- Prompt doctrine that tells the child agent how to manually preserve state shape.
- Regex/template police that try to repair semantic sludge after the store allowed sludge to become durable.
- Deterministic cleanup passes whose real job is compensating for whole-state JSON edits, permissive schemas, or sleep distillation that destroyed meaning.

### Impossible By Construction

- An unattended agent cannot corrupt the entire self-state by rewriting one JSON file.
- Two fields cannot both claim to be the cursor.
- Repo activity cannot advance by bypassing the state service.
- Delivery receipts cannot exist only in a status file while state forgets the bot spoke.
- A projection cannot become authoritative.
- Unknown fields cannot silently become doctrine just because `.passthrough()` let them in.

## Current VoidBot Compared To The Ideal

- The bot/worker/provider/RAG/Postgres/Qdrant shape is basically sound.
- Source archive sharding is sound.
- Interaction memory being Postgres-backed is sound.
- The private moderation/self-state foundation is live on typed `.cc` state:
  - the enabled moderation and mood scheduled tasks use typed runners
  - legacy projection/mirror state may still exist on disk as failed-boundary residue and must not become source material
  - the old memory organ and legacy moderation-state wrapper have been removed from the codebase; their translation, retention/compaction, identity crystallization, candidate intervention, and value-pressure behavior must not be revived as compatibility scaffolding
- the scheduled moderation runner has a typed rumination contract: bounded context in, reviewed prompt template, typed operation payloads out, parent-owned cursor/receipt recording
- recent event timing in that bounded context now crosses a projection boundary first, so the child sees "5 minutes ago" language while the parent keeps exact timestamps for bookkeeping
- the old memory-organ script family, legacy moderation state template, and legacy context exporter have now been deleted instead of preserved as forensic bait
- deterministic cleanup is mostly recent scar tissue from failed manual cleanup passes; it should stay deleted rather than be ported unless a future typed operation protects a real invariant in the new model
- hard-wired agency policy is mostly current scaffolding, not the final authority; identity, advocacy, and speech candidates should emerge from typed memory/state operations plus model-owned judgment under validation
- sleep/distillation has a typed maintenance runner, reviewed prompt boundary, fixture coverage, and one live-state pass proving short-term residue can become durable memory without losing meaning

Verdict: the foundation is coherent enough for cautious live operation. Do not add behavior by widening prompts or reviving compensators; harden only failures observed in ordinary scheduled cycles.

## Migration Plan

### Commit 1: Name The Boundary

- Add typed self-state domain interfaces in core.
- Define document types and operation payload types.
- Keep current storage untouched.
- Verification: typecheck only.

### Commit 2: Add Read-Only Typed Projections

- Landed path: `packages/core/src/void-self-state-projection.ts` owns typed `.cc` document to agent-facing summary/projection rendering.
- `packages/core/src/void-self-state-loader.ts` only loads typed documents and delegates read-side projection.
- No JSON projection is needed for the live typed runner.
- Verification: projection smoke loads a temp `.cc` store and confirms mode plus transient room context render.

### Commit 3: Add Typed Mutation CLI

- Landed path: `scripts/void-self-state.mjs apply-operation` is the typed command surface for cursor, open cases, receipts, repo cursors, candidates, sleep, speaking pressure, incubation, and distilled memories.
- The CLI writes CultCache directly through `packages/core/src/void-self-state-service.ts`.
- The legacy `scripts/moderation-state-store.mjs` wrapper has been deleted.
- Verification: fixture tests and runner smokes should exercise operation application.

### Commit 4: Move Repo Activity Cursor Behind The Store

- Change `scripts/export-recent-repo-activity.mjs` so it never writes `.voidbot/private/moderation-agent-state.json`.
- It should emit observed activity and call/store a typed `update_repo_activity_cursor` operation.
- Landed path: it reads the typed cursor from `.voidbot/private/void-self-state.cc`; old `.json` cursor arguments map only to a sibling `.cc` path.
- Verification: run with a temp fixture store; cursor advances without JSON projection writes.

### Commit 5: Replace Agent Whole-State Editing With Operation Output

- Scheduled moderation child may propose operations and speech, not edit state.
- Runner applies operations through the typed store.
- Keep old JSON runner behind a fallback flag for one commit only.
- Verification: dry run with `-NoPost` applies only allowed operations.

### Commit 6: Delete JSON Projection Authority

- Landed in the active path: routine self-state operations use `.voidbot/private/void-self-state.cc`, and the typed service no longer registers or mirrors the legacy moderation document.
- `scripts/run-void-moderator-rumination.ps1` restores rumination through `prompts/void-moderator-rumination.md` and typed operation output; it does not materialize `.json`.
- `scripts/simulate-void-mood.mjs` is typed-only sleep/speaking pressure and does not refresh a JSON projection.
- Remaining work: keep any explicit human debug export separate from mutation authority, and delete stale references/invocations as they are found.

### Commit 6.5: Keep Old Scripts Offline

- `Void Mood Drift` has been deliberately reinstalled after the typed sleep-maintenance fixture passed. It runs `scripts/run-void-mood-drift.ps1`, which calls the typed `scripts/simulate-void-mood.mjs` path.
- `Void Moderator Rumination` is re-enabled after typed operation quality, parent-owned speech closure, and an observed live scheduled pass. The runner has model-branch, parent-owned speech, and nap-skip fixtures.
- Do not reinstall or re-enable deleted legacy scripts as compatibility surfaces.
- Verification: scheduled-task query shows mood and moderation enabled with Last Result `0`, and rebuilt direct dry runs operate only on `.voidbot/private/void-self-state.cc`.

### Commit 7: Harden Scheduled Runner As A Phase Machine

- Continue hardening the typed rumination runner's explicit phases:
  - poll chronology
  - read typed state summary
  - collect anchors from Discord/source/lore only when a phase asks for it
  - ask model for decisions and operation payloads
  - validate/apply operations
  - optionally send speech
  - record receipts and cursor
- Verification: durable logs show each phase and mutation count, and no phase reads legacy projection files.

### Commit 8: Cut Legacy Mirrors

- Remove top-level mirror reconciliation.
- Migrate any consumer to typed projections.
- Delete mirror fields from canonical state or leave the old files offline as forensics only.
- Verification: projection summaries still contain required information; no code references mirror keys.

### Commit 9: Replace Compensating Cleanup With Meaning-Preserving Sleep

- Landed cut: cleanup paths whose only job was repairing JSON projection edits, legacy mirrors, keyword sludge, or overgrown runtime residue have been deleted with the old memory-organ stack.
- Landed cut: hard-wired agency paths that turned heuristic scores into doctrine, advocacy, or speech candidates without an explicit typed-state contract have been deleted.
- Landed replacement boundary: `scripts/run-void-memory-maintenance.ps1` asks the model for memory/incubation/candidate typed operation proposals using `prompts/void-memory-maintenance.md`, rejects non-maintenance operations, and applies the rest through `scripts/void-self-state.mjs`.
- Landed sleep integration: `scripts/simulate-void-mood.mjs` invokes memory maintenance once per nap, and the maintenance runner fails a real sleep pass that returns no operations while memory pressure is present.
- Landed verification: `npm run moderation:memory-maintenance:sleep-fixture` exercises the non-skip model branch with a fake Codex child, proving `AquariumSynthCSharp: Workflow cannot own the body` promotes from short-term into durable memory while preserving subject, claim, anchor, tension, and action implication.
- Landed memory lifecycle: `revise_durable_memory`, `retire_durable_memory`, and `crystallize_memory_into_identity` make long-term memory durable but plastic instead of silently immutable.
- Landed lifecycle verification: `npm run moderation:memory-lifecycle:fixture` proves a short-term thought can promote into durable memory, revise into a replacement, retire superseded durable records, and crystallize into an identity memory plus self-profile value.
- Treat legacy brain mush as a migration problem, not the design center. New memory writes must cross the meaning-preserving typed operation schema before they reach CultCache.
- Redesign sleep/distillation around an explicit contract:
  - preserve the claim/question/fascination target
  - preserve the concrete subject, such as repo, room, lore seam, person, or system
  - preserve anchors or admit when anchors are missing
  - preserve the live tension/counterweight
  - preserve why the memory should affect future action
  - never replace a concrete thought with a prettier generic principle unless the operation records what was lost and why that loss is acceptable
- Make distillation emit typed candidate memories first; the state service applies only candidates that satisfy the contract.
- Landed agency ingress: `upsert_agency_pressure` / `retire_agency_pressure` store discomforts, active tensions, self-advocacy requests, and world-advocacy requests separately from candidate speech.
- Landed agency verification: `npm run moderation:agency-pressure:fixture` proves agency pressure enters typed state, appears in the self-state summary, and contributes to mood speaking pressure.
- Landed agency-to-speech accountability: strong active self/world advocacy pressure now appears as `speechPressureObligations` in rumination context. The parent runner rejects silent `[]` unless the model queues a candidate intervention or cools/retires the pressure. Deferred candidates do not satisfy the pressure by themselves, and existing queued candidates with delivery targets can be delivered by later runner passes instead of only during the pass that proposed them.
- Landed rumination verification: `npm run moderation:rumination:fixture` routes the non-skip rumination branch through a fake Codex child and proves short-term memory, incubation, agency-pressure, and candidate-intervention proposals cross the parent-applied typed operation boundary without timestamp leakage.
- Landed controlled live rumination review: the first real-model `-NoPost` pass produced valid but self-orbiting readiness-test residue, which was pruned/retired and folded into a prompt guard; the second real-model `-NoPost` pass sampled non-VoidBot repo pressure, used retrieval, and correctly wrote `[]` when nothing earned persistence.
- Landed parent-owned speech closure: candidate interventions can include `deliveryTarget`, the prompt forbids child-side send scripts, the parent runner delivers at most one newly queued deliverable candidate per pass, records the receipt, and marks the candidate spoken with `mark_candidate_intervention_spoken`. `npm run moderation:rumination:speech-fixture` proves the loop with fake Codex and fake Discord send helpers.
- Landed scheduled rumination re-enable: one observed live scheduled pass completed with Last Result `0`, proposed one anchored short-term memory, delivered no speech, and kept exact timestamps out of the prompt-facing context.
- Landed live sleep-maintenance verification: a manual typed nap ran real memory maintenance on live state, promoted the scheduled rumination short-term memory into one durable `identity_seam`, and left `thoughtMemory.shortTerm` empty.
- Landed sleep brake: scheduled rumination now skips before model invocation during naps when there are no new room messages or open cases. `npm run moderation:rumination:nap-skip-fixture` proves the model path is not touched and no operation proposals are written.
- Landed short-term clustering guard: `record_short_term_memory` folds repeated same-target/topic pressure into one provisional memory with merged anchors, and `npm run moderation:short-term-clustering:fixture` proves the synth-boundary duplicate case without merging unrelated same-repo thoughts. The prompt now states explicitly that underexplored, low-saturation, newly anchored thoughts may keep deepening inside the cluster.
- Remaining work: let ordinary scheduling run and inspect the next unattended awake rumination and sleep cycle for repeated thought clusters, stale short-term residue, or ungrounded memory writes before calling the system broadly stable.

### Commit 10: Resume Product Hardening

- Only after JSON mutation and legacy mirrors are gone:
  - public-lane moderation policy
  - admin/forensics surfaces
  - restore drills
  - provider/sandbox scaffolding cleanup

## Rules For Editing This Plan

- update this note when the larger sequence of work changes
- do not dump volatile minute-by-minute status here
- if a lesson changes future belief, record it in `state/evidence.jsonl`
- if the current next action changes, update `state/map.yaml` and `notes/fresh-workspace-handoff.md`
