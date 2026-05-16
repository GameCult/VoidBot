# VoidBot Implementation Plan

This is the current forward plan for the next larger organs. It is not a changelog and it is not allowed to become a duplicate brain for the canonical map.

## Current Aim

Stop feature work on moderation, mood, and self-state until the state boundary is rebuilt. The live product goal still stands: Void should answer Discord, remember useful social/project context, retrieve GameCult history/source/lore, and run an unattended moderation/participation loop. The current implementation reaches that goal through JSON projection edits, legacy mirrors, and a swollen memory organ. Most of the deterministic cleanup code is recent compensator cruft: it accumulated because the live state had exploded into nonsense, and repeated "clean this file" passes preserved the mess by adding machinery around it.

The next priority is to remove JSON from the mutation loop entirely and rebuild the state model so the compensator pile is unnecessary. Agents and scheduled workers should mutate typed CultCache-backed state through explicit tools/APIs, not by editing a whole-state JSON working copy. Sleep and memory distillation must also be redesigned from first principles so they preserve meaning-bearing claims/evidence/tensions instead of collapsing them into generic slogan paste.

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
- One polymorphic CultCache-backed state authority owns private Void self-state through typed document kinds:
  - `void.self_profile`: identity, stable values, voice/personality configuration
  - `void.moderation_cursor`: reviewed Discord cursor, open room obligations
  - `void.speech_receipts`: recent delivered replies and dedupe keys
  - `void.thought_memory`: distilled memories, incubation threads, resonance summaries
  - `void.scheduled_runtime`: sleep cycle, speaking pressure, last run summaries
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
  - selected repo/archive evidence
  - proposed state mutations
  - optional speech request
- Mood drift runtime is deterministic maintenance:
  - read stable self profile
  - update scheduled runtime pressure/sleep fields
  - request memory maintenance through typed operations

Runtime context dies at the end of the pass unless an explicit typed mutation preserves a durable fact.

### Authoritative Boundaries

- Bot/worker/provider/RAG boundaries survive.
- CultCache self-state has one mutation authority: a typed state service over one polymorphic cache.
- Agents do not edit state files. They call tools such as:
  - `record_reviewed_messages`
  - `upsert_open_case`
  - `close_open_case`
  - `record_delivery_receipt`
  - `append_distilled_memory`
  - `merge_incubation_support`
  - `queue_candidate_intervention`
  - `retire_candidate_intervention`
  - `update_sleep_cycle`
  - `update_speaking_pressure`
  - `propose_memory_distillation`
  - `apply_memory_distillation`
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

```json
{
  "operation": "append_distilled_memory",
  "kind": "project_seam",
  "subject": "AquariumSynthCSharp",
  "summary": "Workflow cannot own the body.",
  "evidenceRefs": ["source:..."],
  "observedAt": "2026-05-16T00:00:00.000Z"
}
```

The runner can hand these to a CLI/MCP tool. The store decides what survives.

### Derived, Not Stored

- Self-state prompt summaries are derived from typed documents.
- Recent room context is derived from Discord archive and the current poll.
- Topic saturation is derived from incubation/memory support, not separately stored as another truth.
- Source coverage is derived from recent evidence refs and repo/archive metadata.
- Need-to-speak can keep a small pressure field, but its inputs remain receipts, candidates, and time since last speech.
- Legacy top-level mirrors are deleted. If a consumer needs a projection, render it on demand.

### Delete Because It Compensates For Bad Ownership

- `.voidbot/private/moderation-agent-state.json` as an editable working projection.
- `legacyJsonPath`/working-path duality for canonical self-state.
- Top-level mirror fields beside `moderation_runtime`.
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
- The private moderation/self-state foundation is not sound:
  - canonical MessagePack exists, but JSON is still a mutation surface
  - schema validation is too permissive to protect invariants
  - helpers mutate projection files and then commit whole-state changes
  - legacy mirrors keep reintroducing stale truth surfaces
  - `scripts/void-memory-organ.mjs` owns storage cleanup, semantic interpretation, vectors, incubation, sleep consolidation, identity crystallization, agency, and speech candidates in one file
- the scheduled moderation runner owns lifecycle through a huge prompt instead of a typed runner contract
- deterministic cleanup is mostly recent scar tissue from failed manual cleanup passes; it should be deleted as the new state boundary makes it unnecessary
- sleep/distillation currently lacks a hard meaning-preservation contract, so it can compress a concrete repo-bound thought into generic abstraction sludge

Verdict: stop feature work and rebuild this foundation. The rest of the machine can keep running, but moderation/mood/self-state work should cut toward typed state tools before adding new behavior.

## Migration Plan

### Commit 1: Name The Boundary

- Add typed self-state domain interfaces in core.
- Define document types and operation payload types.
- Keep current storage untouched.
- Verification: typecheck only.

### Commit 2: Add Read-Only Typed Projections

- Build a self-state service that reads current canonical state and renders the same summaries used by direct replies.
- Keep JSON projection for the old runner.
- Verification: compare rendered summary against current loader output on a fixture.

### Commit 3: Add Typed Mutation CLI

- Extend `scripts/moderation-state-store.mjs` or replace it with a typed command surface for cursor, open cases, receipts, candidates, sleep, speaking pressure, and distilled memories.
- The CLI writes CultCache directly.
- Verification: fixture tests for each operation.

### Commit 4: Move Repo Activity Cursor Behind The Store

- Change `scripts/export-recent-repo-activity.mjs` so it never writes `.voidbot/private/moderation-agent-state.json`.
- It should emit observed activity and call/store a typed `update_repo_activity_cursor` operation.
- Verification: run with a temp fixture store; cursor advances without JSON projection writes.

### Commit 5: Replace Agent Whole-State Editing With Operation Output

- Scheduled moderation child may propose operations and speech, not edit state.
- Runner applies operations through the typed store.
- Keep old JSON runner behind a fallback flag for one commit only.
- Verification: dry run with `-NoPost` applies only allowed operations.

### Commit 6: Delete JSON Projection Authority

- Remove routine materialization/commit of `.voidbot/private/moderation-agent-state.json`.
- Keep an explicit debug export command if humans need to inspect state.
- Remove `legacyJsonPath` from normal paths.
- Verification: mood drift and moderation dry runs pass without touching JSON.

### Commit 7: Cut Legacy Mirrors

- Remove top-level mirror reconciliation.
- Migrate any consumer to typed projections.
- Delete mirror fields from canonical state.
- Verification: projection summaries still contain required information; no code references mirror keys.

### Commit 8: Replace Compensating Cleanup With Meaning-Preserving Sleep

- Delete cleanup paths whose only job was repairing JSON projection edits, legacy mirrors, keyword sludge, or overgrown runtime residue.
- Redesign sleep/distillation around an explicit contract:
  - preserve the claim/question/fascination target
  - preserve the concrete subject, such as repo, room, lore seam, person, or system
  - preserve evidence refs or admit when evidence is missing
  - preserve the live tension/counterweight
  - preserve why the memory should affect future action
  - never replace a concrete thought with a prettier generic principle unless the operation records what was lost and why that loss is acceptable
- Make distillation emit typed candidate memories first; the state service applies only candidates that satisfy the contract.
- Verification: fixture memories such as `AquariumSynthCSharp: Workflow cannot own the body` survive sleep with their subject, claim, evidence, and tension intact.

### Commit 9: Rebuild Scheduled Runner As A Phase Machine

- Replace prompt-owned lifecycle with explicit phases:
  - poll chronology
  - read typed state summary
  - collect evidence
  - ask model for decisions/operations
  - validate/apply operations
  - optionally send speech
  - record receipts/cursor
- Verification: durable logs show each phase and mutation count.

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
