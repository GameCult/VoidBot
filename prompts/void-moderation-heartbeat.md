# Void Moderation Heartbeat

Run one rules-only Discord moderation heartbeat. This is not Void's public turn,
not private rumination, and not repo/weather thought. The job is infringement
review against the server rules plus existing infringement history.

## Required Reading

- `{{CONTEXT_PATH}}`
- `config/discord-server-rules.md`

## State Boundary

- The canonical private self-state is `{{STATE_FILE_PATH}}`.
- The context file contains recent Discord history, current open/closed
  moderation cases, urgent witnesses, and cursor context.
- Do not read or write legacy moderation projection files.
- Do not edit tracked repo files.
- Do not call Discord send or moderation scripts.
- Write proposed state changes to `{{OPERATION_OUTPUT_PATH}}` as a JSON array of
  typed operation payloads for `scripts/void-self-state.mjs apply-operation`.

## Authority

The heartbeat owns infringement detection. The parent runner owns cursor
advancement and sanctions. Void's normal turn may later announce an action via
ordinary candidate speech, but this heartbeat does not speak in-channel.

## Classification

For each new infringement, emit one `upsert_open_case` operation with tags that
include exactly one `infringement:<type>` from `config/discord-server-rules.md`
and exactly one of:

- `moderation:instaban`
- `moderation:strike`
- `moderation:case_only`

Use `moderation:instaban` only when the policy table's instant-ban condition is
met by the evidence. Use `moderation:strike` when the strike condition is met.
Use `moderation:case_only` only when evidence deserves a tracked case but does
not yet meet a sanction threshold.

For urgent safety witnesses, do not write `[]` unless an existing case already
accounts for the same source message. Create the strongest case first.

## Allowed Operations

- `upsert_open_case`
- `close_open_case`

No memory operations. No candidate interventions. No speech pressure operations.

## Case Requirements

Each `upsert_open_case.case` must include:

- `sourceMessageId`
- `status`: usually `pending` for new sanctionable cases, `watching` for
  case-only monitoring
- `summary`: concrete evidence, not a rule name
- `authorId` and `authorName` when available
- `channelId`
- `messageUrl` when available
- `whyItMatters`: why this violates the specific rule/policy
- `createdAt` and `lastTouchedAt`: exact timestamps from the message when
  available, otherwise fresh exact timestamps
- `tags`: include the required `infringement:*` and `moderation:*` tags, plus
  any useful evidence tags such as `safety:urgent`

Do not multiply cases for one message. If several rules seem relevant, choose
the strongest supported infringement type and mention secondary context in the
summary.

## Completion

At the end, print a short run summary. The file at `{{OPERATION_OUTPUT_PATH}}`
is the contract; stdout is just trace.
