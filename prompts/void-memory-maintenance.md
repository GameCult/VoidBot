# Void Memory Maintenance

Perform one private Void memory-maintenance pass in this workspace. This is not
room moderation and not a speech pass. Think from the supplied typed state
surface, then return only durable typed operation payloads worth applying.

## Required Reading

- `{{CONTEXT_PATH}}`
- `styles/void-default.md`

## State Boundary

- The canonical private self-state is `{{STATE_FILE_PATH}}`.
- The private self-state is a typed CultCache `.cc` store.
- Do not read or write legacy moderation projection files.
- Do not edit tracked repo files.
- Do not mutate self-state directly.
- Write proposed durable state changes to `{{OPERATION_OUTPUT_PATH}}` as a JSON array of typed operation payloads for `scripts/void-self-state.mjs apply-operation`.

## Purpose

Sleep and memory maintenance are allowed to reduce bulk, not meaning.

A valid memory/distillation operation must preserve:

- the concrete target
- the claim or question
- the live tension or counterweight
- why this should affect future action
- evidence refs, or an explicit `evidence:missing` tag

If those pieces cannot be preserved, do not invent a prettier abstraction. Let the
thought cool, merge support into incubation, or write nothing.

## Allowed Operations

- `append_distilled_memory`
- `merge_incubation_support`
- `queue_candidate_intervention`
- `retire_candidate_intervention`
- `propose_memory_distillation`
- `apply_memory_distillation`

Do not emit cursor, receipt, sleep-cycle, or speaking-pressure operations.

## Pass Shape

1. Read the context file.
2. If there are no memories, no incubation threads, and no candidate interventions needing attention, write `[]`.
3. Prefer one small meaningful maintenance move over a bag of tidy-looking edits.
4. If two memories really collapse into one stronger memory, use `apply_memory_distillation`.
5. If a thought is still alive but undercooked, use `merge_incubation_support`.
6. If a thought has a plausible future speech path, use `queue_candidate_intervention`.
7. If a candidate is stale, duplicative, or no longer worth preserving, use `retire_candidate_intervention`.
8. Write `{{OPERATION_OUTPUT_PATH}}`. If nothing deserves persistence, write `[]`.

## Voice Discipline

- Do not write template language into memory.
- Do not use stock phrases such as "live seam", "looks like a live claim", "recurring seam", or "dream-compressed".
- Do not save a thought merely because it fits the operation shape.
- The operation schema is the storage contract, not Void's voice.

## Completion

At the end, print a short run summary.
