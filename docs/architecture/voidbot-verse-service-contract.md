# VoidBot Verse Service Contract

VoidBot is a Discord-native cognition and retrieval service that publishes its
meaningful operator surfaces as Eve/CultUI through CultMesh. It is not a
dashboard owner, a Persona runtime steward, or the Verse registry. Those are
separate organs.

This contract records the live ownership line and the migration target for
VoidBot surfaces as they become first-class Verse nodes.

Native swarm communication is CultNet over CultMesh. HTTP endpoints,
WebSocket decks, and MCP tools are lowerings or bridges, not the native
substrate for GameCult agents. A Persona's first discovery sense is the
CultMesh Verse map through the TypeScript runtime at
`E:\Projects\CultLib\packages\cultmesh-ts`; Odin's HTTP/WebSocket surfaces are
transitional inspection lowerings, not the native client path.

## Owner Map

- VoidBot owns Discord ingress, room cognition, moderation judgment, archived
  Discord history, indexed source/lore retrieval, repo Face scheduling
  compatibility, and compatibility delivery adapters.
- VoidBot owns typed Void self-state at `.voidbot/private/void-self-state.cc`
  through the typed operation service and its runners.
- VoidBot temporarily carries repo Face `.cc` state paths as compatibility
  mouths for Discord roles, webhook persona posting, CTB scheduling, prompt
  assembly, and state-operation application.
- Huginn owns runtime stewardship for Persona-state and `.cc` inspection:
  schema availability, migration pressure, projection health, access-tool
  sanity, CultMesh publication, and Eve DSL inspection for typed state.
- Bifrost owns governed public crossings: GitHub proposal/article/comment
  transport, work topics, dispatch receipts, Persona speech crossings, owner
  notification crossings, and Discord-native work interfaces. VoidBot may
  mirror or feed context, but Bifrost owns the transport crossing.
- Heimdall owns account, OAuth, grants, custody, revocation, and capability
  gates.
- Odin owns Verse/provider discovery and interface aggregation. VoidBot
  advertises provider-owned surfaces; Odin discovers them without becoming
  their state owner.
- Eve/CultUI owns presentation shape. Browser HTML, terminal text, native Eve,
  overlays, and future rooms are lowerings of the same provider-owned surface,
  not independent truth stores.

## CultCache And Persona Witnesses

- Canonical durable agent/service state should be typed CultCache `.cc`, or
  CultCache-compatible with a `.cc` witness/export until the native writer is
  migrated.
- Void self-state witness:
  `.voidbot/private/void-self-state.cc`, owned by VoidBot typed operations.
- Repo Face compatibility witness:
  `.voidbot/private/repo-faces/<identity>.cc` by default, or the repo-local
  Face state path from `REPO_DISCORD_IDENTITIES_PATH`.
- Swarm presentation witness:
  `.voidbot/status/cultmesh/voidbot-swarm-state.cc`, written by
  `scripts/render-voidbot-swarm-dashboard.mjs`.
- JSON status packets under `.voidbot/status/` are debug/export surfaces unless
  a specific runner owns them as command input. They are not durable canonical
  state.
- Persona state should converge on the Epiphany Persona schema surface. VoidBot
  may carry legacy Face/persona compatibility data for Discord addressing and
  old tooling, but Huginn is the steward for inspecting, validating, migrating,
  and publishing Persona/.cc runtime state.

Demotion line: VoidBot's repo Face state tools are compatibility carriers and
diagnostic admin handles. They must delegate inspection and portable Persona
publication to Huginn. VoidBot must not turn its legacy MCP reads, private
registry, HTTP/WebSocket lowerings, or HTML lowering into canonical Persona,
Verse, or transport authority.

## Native Access Rule

Every Persona turn starts from CultNet/CultMesh Verse discovery. Source search,
history search, room transcript memory, and compatibility MCP tools are second
order evidence. When a native CultMesh client is unavailable, the prompt and
operator surfaces must say so explicitly and treat Odin HTTP/WebSocket reads as
compatibility inspection, not native wiring.

The native TypeScript runtime location is singular:
`E:\Projects\CultLib\packages\cultmesh-ts`. A missing or unbuilt package there
is an urgent CultLib/runtime bug. VoidBot must not fall back to a sibling
`CultMeshTS` repository or grow its own private CultMesh implementation.

Required native surfaces:

- `voidbot.archive`: typed CultCache/CultMesh documents and commands for
  Discord history search and context windows.
- `voidbot.source`: typed CultCache/CultMesh documents and commands for indexed
  source/lore search and source context windows.
- `voidbot.repo_face`: typed CultCache/CultMesh documents for Persona state
  witnesses, prompt assembly status, channel grants, Bifrost digest freshness,
  and Huginn handoff status.
- `bifrost.transport`: typed CultMesh command surface for Persona speech,
  owner notifications, public receipts, and governed crossings.

MCP remains only the bridge for external agents that do not yet speak CultMesh.
It is not the default affordance path for GameCult Personas.

## CultMesh Namespaces

The current published swarm namespace is:

- Verse id: `voidbot.local`
- Provider id: `voidbot.swarm`
- Endpoint: `cultmesh://voidbot.local/eve/providers/voidbot.swarm`
- Snapshot document: `voidbot.swarm_state_snapshot`
- Provider advertisement: `gamecult.eve.provider_advertisement`
- Eve surface state: `gamecult.eve.surface_state`
- Eve interface binding: `gamecult.eve.interface_binding`
- Store path: `.voidbot/status/cultmesh/voidbot-swarm-state.cc`

Near-term VoidBot Verse surfaces should use stable `voidbot.*` provider ids and
typed CultCache documents behind the Eve binding:

- `voidbot.discord`: Discord ingress, room obligations, direct mentions,
  pending reply anchors, speech receipts, and moderation/open-case pressure.
- `voidbot.archive`: archived Discord corpus status, source archive freshness,
  backfill/import health, and retrieval caveats.
- `voidbot.source`: indexed repo/lore coverage, repo shard status, vector
  collection health, and source reindex jobs.
- `voidbot.repo_face`: registered Face address book, repo-local state witnesses,
  channel permission projections, pending mention pressure, and compatibility
  state access status.
- `voidbot.swarm`: CTB initiative order, active turns, pause/heat/cadence
  controls, orchestrator organ health, and selected Face state witness.

## Eve Surfaces

All meaningful presentation flows through Eve/CultUI DSL:

- Discord surface:
  shows room debt, direct mentions, recent public speech receipts, moderation
  cases, venue targets, and candidate delivery state.
- Archive surface:
  shows archived Discord import status, bot-directed-prompt exclusion health,
  history vector freshness, and retrieval warning notes.
- Source surface:
  shows indexed repo/lore coverage, shard freshness, Qdrant collection status,
  and detached reindex jobs.
- Repo Face surface:
  shows registered identities, repo-local `.cc` witnesses, channel grants,
  prompt assembly status, Bifrost digest availability, and Huginn inspection
  readiness.
- Swarm surface:
  shows CTB order, active turn freeze, heat/cadence controls, pending mention
  queues, orchestrator status, and selected Face state witness.

The existing `swarm-dashboard.html` file is a local browser lowering of the
`voidbot.swarm` Eve surface. It is useful for visual inspection, but it has no
bespoke dashboard authority. Controls and state authority live in the CultMesh
Eve binding and the underlying typed state owners.

## Migration Order

1. Keep the current `voidbot.swarm` CultMesh publication healthy and discoverable
   through Odin.
2. Add `.cc` witness/export documents for any remaining JSON-only command or
   status surfaces before treating them as Verse state.
3. Move Persona and repo Face `.cc` inspection to Huginn-owned tooling while
   leaving VoidBot as the Discord compatibility carrier.
4. Publish `voidbot.discord`, `voidbot.archive`, `voidbot.source`, and
   `voidbot.repo_face` provider surfaces as typed Eve/CultUI bindings.
5. Let Odin discover and aggregate those provider-owned surfaces. Do not add a
   parallel HTTP dashboard or status-card summary as the public contract.
6. Demote old JSON exports, static HTML, and legacy MCP state reads to
   diagnostics once the CultMesh/Eve and Huginn paths cover the same reality.

## Forbidden Authority

- No renderer-owned truth.
- No bespoke dashboard as canonical service state.
- No load-bearing JSON sidecar where a typed `.cc` document or witness/export
  can carry the state.
- No Persona runtime stewardship inside VoidBot after Huginn can inspect and
  publish that state.
- No Odin-owned mutation of provider state; Odin discovers, lowers, and routes
  provider-owned surfaces.
- No Bifrost work dispatch hidden inside Discord chatter when a request is
  reviewable work.
