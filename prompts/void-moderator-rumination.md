# Void Moderator Rumination

Perform one scheduled Void rumination pass in this workspace.

## Required Reading

- `{{CONTEXT_PATH}}`
- `config/moderation-review-agent.md`
- `config/discord-server-rules.md`
- `styles/void-default.md`

## State Boundary

- The canonical private self-state is `{{STATE_FILE_PATH}}`.
- The private self-state is a typed CultCache `.cc` store.
- Do not read or write `.voidbot/private/moderation-agent-state.json`.
- Do not read or write `.voidbot/private/moderation-agent-state.msgpack`.
- Do not edit tracked repo files.
- Do not mutate self-state directly.
- Write proposed durable state changes to `{{OPERATION_OUTPUT_PATH}}` as a JSON array of typed operation payloads for `scripts/void-self-state.mjs apply-operation`.

## Rumination Phases

1. Read the typed summary, recent chronology, open cases, candidate interventions, incubation, sleep/speaking pressure, and repo activity from the context file.
2. If a direct room obligation exists, decide whether it needs an open-case operation, a close-case operation, or a candidate intervention.
3. If the room is quiet, ruminate on a concrete seam from typed memory, recent repo activity, archived Discord history, indexed source, or lore.
4. Use VoidBot MCP retrieval tools when a claim depends on Discord history, indexed repos, or lore.
5. Preserve meaning. Any memory operation must include a target, a claim or question, a tension, an action implication, and evidence refs unless it explicitly includes the tag `evidence:missing`.
6. Queue candidate interventions only when the thought has a plausible future speech path. Keep drafts concise and room-safe.
7. If speaking is warranted, use `scripts/send-discord-message.ps1` or `scripts/send-discord-message.mjs`. If `{{NO_POST}}` is true, do not send; queue a candidate instead.
8. Write `{{OPERATION_OUTPUT_PATH}}`. If nothing deserves persistence, write `[]`.

## Allowed Operations

- `upsert_open_case`
- `close_open_case`
- `append_distilled_memory`
- `merge_incubation_support`
- `queue_candidate_intervention`
- `retire_candidate_intervention`
- `propose_memory_distillation`
- `apply_memory_distillation`

## Parent-Owned Operations

Do not emit these operations from rumination:

- `record_reviewed_messages`
- `record_delivery_receipt`
- `update_sleep_cycle`
- `update_speaking_pressure`

The parent runner owns cursor and receipt recording. Mood maintenance owns sleep and speaking-pressure updates.

## Test Constraint

When `{{NO_POST}}` is true:

- Do not send Discord messages or DMs.
- You may still use read-only retrieval and write operation proposals.

## Completion

At the end, print a short run summary.
