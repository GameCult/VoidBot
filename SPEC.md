# VoidBot Spec

Status: Draft v0.1
Date: 2026-04-22
Owner: Meta

## 1. Summary

VoidBot is a Discord-native assistant with a provider abstraction layer.

In phase one, VoidBot supports an owner-only Codex workflow that is gated, explicit, and human-mediated. In later phases, the same bot can route non-owner traffic to a paid API provider or a local model without changing the Discord-facing contract.

The design goal is simple:

- build the bot infrastructure now
- keep subscription-backed Codex use restricted to the owner
- make multi-user AI access possible later by swapping providers
- preserve enough safety rails that the bot cannot casually become "remote shell, but with branding"

## 2. Goals

- Provide a Discord bot that can answer questions, retrieve relevant server context, and run structured workflows.
- Index approved Discord history into a searchable vector store for RAG.
- Support multiple providers behind one stable interface.
- Restrict the Codex-backed path to the owner account only.
- Keep tool use and command execution inside a strict sandbox.
- Preserve auditability for prompts, approvals, runs, and published responses.
- Allow a future OpenAI API provider to be added with minimal refactor.

## 3. Non-Goals

- Exposing the owner's ChatGPT/Codex subscription as a general multi-user backend.
- Allowing arbitrary shell execution from Discord messages.
- Indexing all Discord content by default, including DMs and private channels, without explicit configuration.
- Shipping polished personality tuning beyond loading a defined style pack.
- Building a full moderation platform before the MVP exists.

## 4. Product Principles

- Owner-only means owner-only. The Codex path must hard reject all non-owner requests.
- Providers are interchangeable, permissions are not. Discord permissions and provider permissions must be enforced separately.
- Human approval beats vibes. Any high-risk action requires a visible approval step.
- Retrieval should help the bot remember context, not quietly become surveillance software.
- Style is configurable. Capabilities are not.

## 5. Users And Trust Levels

### Roles

- Owner: the only Discord user allowed to submit jobs to the Codex-backed provider.
- Admin: can manage bot configuration, indexed channels, and provider availability.
- Member: can use public bot features only through providers explicitly enabled for member traffic.

### Trust Tiers

| Tier | Who    | Allowed Providers         | Allowed Actions                                      |
| ---- | ------ | ------------------------- | ---------------------------------------------------- |
| T0   | Member | `openai_api`, `local_llm` | ask, retrieve, approved low-risk tools               |
| T1   | Admin  | `openai_api`, `local_llm` | config, moderation, reindex, diagnostics             |
| T2   | Owner  | all providers             | owner-only Codex jobs, approvals, provider overrides |

## 6. Scope

### Phase 1

- Discord bot connection and routing
- owner-only Codex workflow
- RAG over configured server channels
- vector index maintenance
- strict sandbox runner
- audit logging
- style pack support

### Phase 2

- OpenAI API provider for non-owner traffic
- provider-based rate limits and budgets
- output moderation for public responses
- better admin controls

### Phase 3

- optional local LLM provider
- richer tools
- scheduled summaries and proactive tasks

## 7. Core Use Cases

### UC1: Owner asks VoidBot for a response with Codex help

1. Owner mentions VoidBot or uses a slash command.
2. VoidBot builds a context bundle from the current message, recent channel history, and RAG retrieval.
3. VoidBot packages the request as a queued owner-only job.
4. VoidBot posts the result in the same channel as a response to the Owner

### UC2: Member asks VoidBot a question before API funding exists

1. Member mentions VoidBot.
2. VoidBot replies with a configured fallback behavior:
3. either "provider unavailable"
4. or a local-model response if `local_llm` is enabled

No member traffic may route to the Codex provider.

### UC3: RAG retrieval over server history

1. VoidBot ingests messages from configured channels.
2. Messages are chunked, embedded, and stored with metadata.
3. Queries retrieve relevant chunks and summaries.
4. Providers receive only the context needed for the current task.

### UC4: Safe structured action

1. A user invokes a supported action such as summarize channel, search archive, or run a whitelisted workflow.
2. VoidBot maps the request to a predefined tool action.
3. The action runs in a sandbox profile with strict file, network, time, and command limits.

## 8. High-Level Architecture

```text
Discord Gateway
  -> Command Router
  -> Permission Engine
  -> Context Builder
  -> Job Queue
  -> Provider Adapter
  -> Sandbox Runner
  -> Storage Layer
      - relational DB
      - vector store
      - object storage for transcripts/artifacts
  -> Audit Log
```

### Components

- `discord-gateway`: receives events, slash commands, mentions, message edits, and reactions.
- `router`: maps incoming events to intents and workflows.
- `permission-engine`: enforces role, channel, provider, and action policies.
- `context-builder`: assembles prompt context from recent messages, retrieval results, style packs, and config.
- `job-queue`: manages long-running tasks, retries, and approval states.
- `provider-adapter`: normalizes requests to each model provider.
- `sandbox-runner`: executes approved tools and workflows inside constrained environments.
- `history-ingester`: writes message archives and embeddings.
- `audit-log`: records who asked what, what provider was used, what tools were invoked, and what was posted.

## 9. Provider Model

VoidBot must not let Discord-facing code know provider-specific details beyond declared capabilities.

### Provider Interface

Each provider should implement:

- `get_name()`
- `get_capabilities()`
- `is_enabled()`
- `is_allowed_for_actor(actor, guild_context)`
- `build_request(context_bundle, options)`
- `execute(request)`
- `estimate_cost(request)`
- `moderate_input(request)` if applicable
- `moderate_output(response)` if applicable
- `get_audit_redactions()`

### Required Provider Types

#### `owner_codex`

Purpose:

- owner-only Codex-backed workflow

Rules:

- may only accept requests from the configured owner Discord ID
- disabled for all other actors, even admins
- approval required before provider execution
- approval required before public posting
- should default to a manual or semi-manual bridge mode

Recommended initial mode:

- `manual_package`

In `manual_package` mode, VoidBot does not directly run Codex as a background service. It prepares a job bundle for the owner, who reviews and executes it manually, then approves the final post. This keeps the implementation closest to a workflow tool rather than a shared hosted endpoint.

Optional future mode:

- `local_exec_owner_only`

This mode should remain disabled by default and clearly marked experimental.

#### `openai_api`

Purpose:

- future multi-user provider for member and admin traffic

Rules:

- API key required
- cost controls required
- input and output moderation required for public use
- rate limiting required at guild, channel, and user level

#### `local_llm`

Purpose:

- cheap fallback or offline mode

Rules:

- no privileged tools by default
- lower trust output label

## 10. Discord Interaction Model

### Triggers

- mention trigger: `@VoidBot`
- slash commands
- optional message context menu actions

### Initial Commands

- `/ask`
- `/search-history`
- `/summarize-channel`
- `/queue-codex`
- `/approve-job`
- `/reject-job`
- `/provider-status`
- `/reindex-channel`
- `/set-style`

### Response Modes

- immediate ephemeral acknowledgement
- streamed progress updates where supported
- final public reply
- final private or admin-only reply for gated jobs

## 11. Style System

VoidBot should support style packs loaded from local prompt files.

Initial style pack:

- `void-default` for public-facing deployments

Style application rules:

- apply tone primarily to conversational framing
- keep commands, diagnostics, warnings, and technical instructions plain
- allow per-provider enable or disable flags
- allow guild-level default with channel-level override

## 12. RAG And History Indexing

### Ingestion Policy

- disabled by default until configured
- allowlist channels only
- no DMs in MVP
- private channels require explicit opt-in
- retain message metadata: guild, channel, author, timestamp, thread, reply chain, attachment refs

### Chunking

- chunk by semantic boundaries where possible
- preserve thread continuity
- store both raw text and normalized text
- tag chunks with source message IDs

### Embeddings

- provider-agnostic embedding interface
- re-embed when chunking strategy changes
- support batch backfills and incremental updates

### Retrieval

- query rewrite optional
- hybrid retrieval preferred later, vector-only acceptable in MVP
- max context budget enforced before provider call
- retrieval results should include source citations internally

## 13. Sandbox And Tool Safety

All nontrivial tool execution must happen inside a sandbox profile.

### Sandbox Profiles

- `read_only_lookup`
- `rag_maintenance`
- `owner_workflow`
- `public_low_risk`

### Minimum Safety Controls

- explicit allowlist of commands per profile
- filesystem scope restrictions
- network disabled unless a workflow explicitly requires it
- execution timeout
- memory and output limits
- no direct interpolation of raw user text into shell commands
- structured tool inputs only

### Approval Rules

- owner-only Codex jobs require owner approval before run
- any command with side effects requires approval
- any public post from an owner Codex job requires approval
- reindex and admin maintenance actions require admin or owner role

## 14. Data Model

### Core Entities

- `GuildConfig`
- `ChannelPolicy`
- `UserPolicy`
- `ProviderConfig`
- `MessageArchive`
- `EmbeddingChunk`
- `Job`
- `JobApproval`
- `ProviderRun`
- `ToolInvocation`
- `AuditEvent`
- `StylePack`

### Job States

- `queued`
- `awaiting_approval`
- `approved`
- `running`
- `awaiting_post_approval`
- `completed`
- `failed`
- `cancelled`

## 15. Storage

### Relational DB

Use for:

- configs
- job state
- approvals
- audit records
- message metadata

### Vector Store

Use for:

- embeddings
- semantic retrieval

### Object Storage

Use for:

- exported prompt bundles
- long transcripts
- generated artifacts
- moderation records where needed

## 16. Moderation And Policy Handling

### For Public Providers

- run input moderation before generation
- run output moderation before posting
- redact secrets and high-risk data in logs
- label bot responses clearly as AI-generated

### For Owner Codex Flow

- still log runs and approvals
- still support optional moderation hooks
- do not silently auto-post

## 17. Configuration

### Required Config

- bot token
- owner Discord user ID
- database DSN
- vector store config
- enabled providers
- style pack path
- indexed channel allowlist

### Future Config

- OpenAI API key
- provider budgets
- moderation thresholds
- per-guild rate limits
- sandbox profile overrides

## 18. Suggested Repo Layout

```text
VoidBot/
  SPEC.md
  README.md
  .env.example
  apps/
    bot/
    worker/
  packages/
    core/
    providers/
    rag/
    sandbox/
    config/
    shared/
  docs/
    architecture/
    decisions/
  scripts/
  tests/
```

## 19. MVP Milestones

### M1: Foundations

- repo scaffold
- config loader
- Discord connection
- DB schema
- audit log skeleton

### M2: Retrieval Spine

- message ingestion
- chunking
- embeddings
- retrieval API

### M3: Provider Abstraction

- provider interface
- `owner_codex` manual package mode
- `local_llm` optional stub

### M4: Safety And Workflow

- approvals
- sandbox profiles
- command allowlists
- public vs owner routing

### M5: UX

- slash commands
- progress updates
- citations in internal debug output
- style pack loading

### M6: API Upgrade Path

- `openai_api` provider
- moderation
- budgeting
- member access controls

## 20. Acceptance Criteria

- Non-owner requests can never hit the Codex provider.
- Owner Codex jobs require explicit approval before run and before public post.
- The bot can retrieve relevant history from configured channels.
- Tool actions run only inside declared sandbox profiles.
- Provider swapping does not require Discord command rewrites.
- Audit logs can answer who triggered a job, what provider handled it, and what was posted.

## 21. Open Questions

- Which stack should own the first implementation: TypeScript, Python, or mixed?
- Which vector store should be the default for local development?
- Should the first owner Codex mode export markdown bundles, JSON bundles, or both?
- Should message attachments be indexed in MVP or only linked as metadata?
- How much of the approval workflow should happen in Discord versus a local dashboard?

## 22. Recommendation

Start with:

- TypeScript bot and worker
- PostgreSQL for relational state
- a local vector store with an upgrade path
- `owner_codex` in `manual_package` mode only
- no public AI provider until the API key exists

That gets the plumbing built now without pretending the expensive part is free just because we squint at it hard enough.
