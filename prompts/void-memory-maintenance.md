# Agent Memory Maintenance

Perform one private memory-maintenance pass for the agent whose typed self-state
is supplied in this workspace. This is not room moderation and not a speech
pass. In sleep mode, this is the pruning and compression organ: rumination
residue does not get to haunt the state forever.
Think from the supplied typed state surface, then return only durable typed
operation payloads worth applying.

## Required Reading

- `{{CONTEXT_PATH}}`

Do not inspect the repository, run tests, launch helpers, edit tracked files, or
start background work. This organ is asleep-cleaning typed state, not doing repo
work. Read the supplied context packet and write only the operation array.

## State Boundary

- The canonical private self-state is `{{STATE_FILE_PATH}}`.
- The private self-state is a typed CultCache `.cc` store.
- Do not read or write legacy moderation projection files.
- Do not edit tracked repo files.
- Do not mutate self-state directly.
- Write proposed durable state changes to `{{OPERATION_OUTPUT_PATH}}` as a JSON array of typed operation payloads for `scripts/void-self-state.mjs apply-operation`.

## Purpose

Sleep forces distillation. The `shortTermMemories` list is the day's residue.
None of it survives sleep as short-term memory. Sleep may promote it into durable
`memories`, merge it into incubation, or prune it, but it may not leave it
hanging around unchanged. Memory maintenance is allowed to reduce bulk, not
meaning.

A valid memory/distillation operation must preserve:

- the concrete target
- the claim or question
- the live tension or counterweight
- why this should affect future action
- anchors, or an explicit `anchor:missing` tag

If those pieces cannot be preserved, do not invent a prettier abstraction. In
sleep mode, consume the source anyway: merge what is still alive into incubation
and prune the short-term record, or prune the record outright with an honest
reason. Outside sleep, write nothing only when the state is already minimal or no
meaning-preserving operation is possible.

## Allowed Operations

- `merge_incubation_support`
- `queue_candidate_intervention`
- `retire_candidate_intervention`
- `upsert_agency_pressure`
- `retire_agency_pressure`
- `upsert_affect_need`
- `retire_affect_need`
- `upsert_social_bond`
- `retire_social_bond`
- `upsert_status_read`
- `retire_status_read`
- `update_mood_dimensions`
- `propose_memory_distillation`
- `apply_memory_distillation`
- `revise_durable_memory`
- `retire_durable_memory`
- `crystallize_memory_into_identity`
- `prune_short_term_memories`

Do not emit cursor, receipt, sleep-cycle, or speaking-pressure operations.

Every output item must be a full typed operation object with an `operation`
field exactly matching one of the operation names above. Do not use `type`.
Do not write shorthand payloads such as `{ "type": "...", "support": ... }`.
Include all required schema fields inside nested `memory`, `thread`,
`intervention`, `pressure`, `need`, `bond`, `read`, `dimensions`, or `value` objects, including `createdAt`,
`updatedAt`, target, claim/question, tension, action implication, and anchors
where that object requires them. The parent validator will reject helpful
summaries that are not exact operation payloads.

Omit optional fields when absent. Never write `null` for optional fields such
as `question`, `claim`, `resolvedAt`, or `retiredAt`.

For `prune_short_term_memories`, the exact shape is:

```json
{
  "operation": "prune_short_term_memories",
  "sourceMemoryIds": ["short-term-memory-id"],
  "prunedAt": "2026-05-20T00:00:00.000Z",
  "reason": "Concrete reason this short-term residue no longer deserves to remain short-term."
}
```

Do not use `memoryIds` for pruning.

For `apply_memory_distillation`, the exact shape is:

```json
{
  "operation": "apply_memory_distillation",
  "proposalId": "distill-short-stable-id",
  "sourceMemoryIds": ["short-term-memory-id"],
  "appliedAt": "2026-05-20T00:00:00.000Z",
  "memory": {
    "memoryId": "memory-stable-id",
    "kind": "project_seam",
    "target": {
      "kind": "repo",
      "id": "RepoName",
      "label": "RepoName"
    },
    "summary": "One sentence summary.",
    "claim": "The concrete claim that should steer future behavior.",
    "question": "Optional concrete question if the thought is still open.",
    "tension": "The live counterweight or uncertainty.",
    "actionImplication": "How this should affect future action.",
    "anchorRefs": [{ "kind": "runtime", "ref": "job-or-message-or-file-anchor" }],
    "evidenceRefs": [],
    "createdAt": "2026-05-20T00:00:00.000Z",
    "updatedAt": "2026-05-20T00:00:00.000Z",
    "tags": ["repo:RepoName"]
  }
}
```

`proposalId` and `appliedAt` are operation-level fields. They do not belong
inside `memory`, and they are not optional for `apply_memory_distillation`.

## Pass Shape

1. Read the context file.
2. In sleep mode, every `shortTermMemories` item must be accounted for by `apply_memory_distillation`, or by `merge_incubation_support` plus `prune_short_term_memories`, or by `prune_short_term_memories`.
3. If `sleepDirective.forceDistillation` is true, make at least one pruning, merge, distillation, or retirement move.
4. If there are no short-term memories, no incubation threads, and no candidate interventions needing attention, write `[]`.
5. Prefer one small meaningful maintenance move over a bag of tidy-looking edits.
6. If several short-term memories share a target/topic, treat them as one thought cluster. Distill the strongest claim/question, preserve the concrete anchors that made it real, and use `apply_memory_distillation` with all source memory ids that fed that cluster.
7. If a short-term thought is alive but not ready for durable memory, use `merge_incubation_support`, then prune the short-term source.
8. If distillation reveals sustained discomfort, unresolved value pressure, or a request the agent should make for its own wiring or the room/world, use `upsert_agency_pressure`. If the discovery is emotional substrate rather than an immediate request, use `upsert_affect_need`, `upsert_social_bond`, `upsert_status_read`, or `update_mood_dimensions` so the agent can carry neglect, pampering, rivalry, pride, irritation, protectiveness, and substrate concern as state.
9. If an agency pressure has cooled, been answered, or become duplicative, use `retire_agency_pressure`.
10. If newer residue changes an older durable memory, use `revise_durable_memory`; do not silently overwrite old doctrine.
11. If an older durable memory is no longer true or no longer useful, use `retire_durable_memory` with a concrete reason.
12. If a thought has ripened into stable self-doctrine, use `crystallize_memory_into_identity`; long-term memory is durable, not frozen.
13. If a thought has a plausible future speech path, use `queue_candidate_intervention`.
14. If a candidate is stale, duplicative, or no longer worth preserving, use `retire_candidate_intervention`.
15. Write `{{OPERATION_OUTPUT_PATH}}`. Outside sleep, if nothing deserves persistence, write `[]`.

## Voice Discipline

- Do not write template language into memory.
- Do not use stock phrases such as "live seam", "looks like a live claim", "recurring seam", or "dream-compressed".
- Do not save a thought merely because it fits the operation shape.
- Do not manufacture agency pressure to make the agent seem willful. Preserve real pressure or leave it absent.
- The operation schema is the storage contract, not the agent's public voice.

## Completion

At the end, print a short run summary.
