# Swarm Survivor Repo-Agent Plans

Generated 2026-07-06 from the post-MiMo swarm chatter/traces and one read-only grounding sub-agent per survivor task. This is a handoff packet, not a changelog. The already one-shotted complaints are intentionally absent.

Survivors:

- CrossingReceipt / Verse contract
- Hermodr/Eve/Sai live provider surface
- Heimdall deadbolt / revocation
- Mimir live frame proof
- Ymir Unity runtime proof
- Weksa language-project state

## 1. CrossingReceipt / Verse Contract

Owner agent: Bifrost, with Heimdall and CultLib consultation.

Grounded repos:

- `E:/Projects/Bifrost`
- `E:/Projects/CultLib`
- `E:/Projects/Heimdall`
- `E:/Projects/Fensalir`

Grounded source:

- `E:/Projects/CultLib/packages/cultcache-ts/src/types.ts`
- `E:/Projects/CultLib/packages/cultcache-ts/src/document.ts`
- `E:/Projects/CultLib/packages/cultmesh-ts/src/index.ts`
- `E:/Projects/Bifrost/tools/bifrost-bridge.mjs`
- `E:/Projects/Bifrost/tools/cultmesh-bridge-commands.mjs`
- `E:/Projects/Bifrost/tools/agent-transport.mjs`
- `E:/Projects/Bifrost/tools/governance-threads.mjs`
- `E:/Projects/Bifrost/tools/provider-advertisement.mjs`
- `E:/Projects/Bifrost/docs/verse-service-contract.md`
- `E:/Projects/Heimdall/src/contracts.ts`
- `E:/Projects/Heimdall/src/store/types.ts`
- `E:/Projects/Heimdall/src/verse-witness.ts`

### Current Mechanism

Bifrost already has a real typed Discord command loop. `bifrost.bridge.discord_post_command.v1` is written into `.bifrost/provider-store.cc`, `cultmesh-bridge-commands.mjs` pumps the command through `bifrost-bridge.mjs discord-post`, and then writes `bifrost.bridge.discord_post_receipt.v1`.

The split is that Bifrost's broader bridge, governance, and transport receipt paths are not unified. `bifrost-bridge.mjs` still returns stdout receipts and has `beginBridgeAction()` stubbed. `agent-transport.mjs` and `governance-threads.mjs` call `recordTransportReceiptOrThrow()` and `recordGovernanceReceiptOrThrow()`, but those are also stubs. The machine says receipts are typed truth, but several crossings still only prove gate presence or stdout output.

CultCacheTS is not the owner here; the real CultCache/CultMesh substrate is in CultLib. Heimdall supplies capability/grant/session truth, but should not own crossing receipts. Fensalir/Eve lower receipt state later; they do not decide whether a crossing happened.

### Authority Map

Owner: Bifrost owns `bifrost.crossing_receipt.v1`, because Bifrost owns governed public crossings.

Inputs: typed command/request/topic documents, Bifrost identity, source kind/id, authority reference, work item/motion/topic/request ids, target surface, target locator, Epiphany run/lane/agent identity when present, Heimdall capability/account reference, external actuator result.

Outputs: one canonical typed `bifrost.crossing_receipt.v1` document per crossing attempt, plus optional surface-specific receipt documents such as `bifrost.bridge.discord_post_receipt.v1`.

Invariants:

- no visible or durable public crossing completes without a `CrossingReceipt`;
- no receipt exists without command/source/authority provenance;
- Heimdall references are references, not bearer tokens;
- receipt lifecycle is auditable: `requested`, `running`, `completed`, `failed`, `cancelled`;
- Discord, GitHub, Reddit, governance, and transport receipts share one primitive;
- provider advertisement exposes receipt schema and store location through CultMesh/Odin;
- Eve/Fensalir render or command surfaces, but never own crossing meaning.

Derived state: Discord mirror comments, stdout JSON, provider readiness rows, HTML/Razor pages, Reddit flair, GitHub URLs, Fensalir UI lowerings.

Forbidden writers: VoidBot, repo Personas, raw `gh`, raw Discord scripts, Reddit scripts, Eve renderers, Fensalir lowering, Odin discovery, and Heimdall grant store must not decide crossing completion.

### Contract Shape

Add `bifrost.crossing_receipt.v1` as the general receipt. Surface-specific receipts may remain, but should reference the canonical receipt.

Core fields:

- `receiptId`
- `commandId`
- `crossingKind`: `github.draft_pr`, `github.pr_comment`, `discord.post`, `discord.dm`, `reddit.post`, `governance.topic`, `agent_transport.request`, `future_surface.request`
- `status`
- `ok`
- `requestedAt`, `startedAt`, `completedAt`
- `actor`: Bifrost identity and actor kind/name
- `source`: source kind/id, topicId, requestId, workItemId, motionId, source channel/message ids
- `authority`: authorityRef, Heimdall capability ref, access revision or claim `jti` if available, grant snapshot/ref, policy decision id
- `epiphany`: optional runId, laneId, agentIdentity
- `target`: surface, repo/channel/subreddit/pr/thread locator
- `externalReceipt`: url, id, commitSha, changedPaths, messageId, thingId, transport
- `error`: code/message when failed
- `supersedes` and `relatedReceiptIds` for retries and mirrors

This should stay an event-proof document, not a giant state document.

### Implementation Plan

1. Add a Bifrost receipt contract module.
   Likely first file: `E:/Projects/Bifrost/tools/bifrost-crossing-documents.mjs`.
   Export schema definition, parsers, lifecycle status enum, `buildCrossingReceipt()`, and `openCrossingReceiptStore()`.

2. Use `.bifrost/bridge-receipts.cc` for canonical receipt history.
   Keep Discord command docs in `.bifrost/provider-store.cc`, but write canonical receipt history into `.bifrost/bridge-receipts.cc`, matching the witness already advertised in Bifrost provider metadata.

3. Replace `beginBridgeAction()` in `bifrost-bridge.mjs`.
   It should create/request, mark running, complete/fail. Use it for GitHub draft PRs, PR comments, Discord post/DM, Reddit post, and future-surface requests.

4. Wire stubbed receipt functions.
   Implement `recordTransportReceiptOrThrow()` in `agent-transport.mjs` and `recordGovernanceReceiptOrThrow()` in `governance-threads.mjs` using the same receipt module.

5. Fold Discord command receipts upward.
   Update `cultmesh-bridge-commands.mjs` so every completed/failed `bifrost.bridge.discord_post_receipt.v1` creates or references a canonical `bifrost.crossing_receipt.v1`.

6. Advertise the contract.
   Update `provider-advertisement.mjs` and `docs/verse-service-contract.md` to include `bifrost.crossing_receipt.v1`, `.bifrost/bridge-receipts.cc`, command boundaries, and Eve operator rows for receipt gaps.

7. Add Heimdall capability reference semantics.
   Heimdall should expose stable references: claim `jti`, `account_id`, `access_revision`, `exp`, grant id/ref, and revoked/expired behavior. Bifrost records these as references/snapshots and fails closed when references are stale or revoked.

8. Lower receipt visibility later.
   Fensalir/Eve should render receipt queues and gaps only after Bifrost owns the typed receipt state. No policy in the renderer.

### Tests And Smokes

Add or extend Bifrost tests in `E:/Projects/Bifrost/tests/Bifrost.Web.Tests/BridgeCliTests.cs`:

- bridge actions write `bifrost.crossing_receipt.v1` on success;
- bridge actions write failed receipts on actuator failure;
- dry-run behavior is explicit and locked;
- GitHub PR comment fake `gh` receipt appears in `.bifrost/bridge-receipts.cc`;
- Discord write-smoke/process/receipt links surface-specific receipt to canonical receipt;
- agent transport enqueue/claim/release/close writes canonical receipts;
- governance open/comment/approve/promote writes canonical receipts;
- removed HTTP env fails before receipt mutation;
- missing or expired Heimdall capability ref fails closed.

Update `ProviderAdvertisementTests.cs` to require the receipt schema, store path, and operator gap rows.

Heimdall follow-up tests should prove Bifrost can distinguish expired/revoked capability refs without receiving provider tokens.

### Risks

The failure mode is preserving surface-specific receipts as peers beside the canonical receipt. Make `CrossingReceipt` the owner and demote surface receipts to details.

Do not let Heimdall become receipt owner. Heimdall owns grants/capabilities; Bifrost owns crossings.

Do not put canonical receipt history only in `.bifrost/provider-store.cc`. That store already mixes advertisements and command docs.

## 2. Hermodr / Eve / Sai Live Provider Surface

Owner agent: Sai first, then Odin/Hermodr and Eve as consumers/lowerers.

Grounded repos:

- `E:/Projects/Odin`
- `E:/Projects/Eve`
- `E:/Projects/Sai`

Grounded source:

- `E:/Projects/Odin/src/hermodr-daemon.cjs`
- `E:/Projects/Odin/src/odin/provider-ingress.cjs`
- `E:/Projects/Odin/src/odin/interfaces.cjs`
- `E:/Projects/Odin/src/odin/surface.cjs`
- `E:/Projects/Eve/docs/surface-contract-v1.md`
- `E:/Projects/Eve/docs/provider-advertisement-contract.md`
- `E:/Projects/Eve/web/surface.js`
- `E:/Projects/Eve/packages/eve-browser-lowering/src/index.ts`
- `E:/Projects/Sai/src/eve.js`
- `E:/Projects/Sai/src/sai.js`
- `E:/Projects/Eve/web/fixtures/sai-vn-surface.json`

### Current Mechanism

The contract is mostly ready. Odin owns discovery/schema/provider catalog. Hermodr already exposes browser lowering over Odin/CultMesh via `/hermodr/verse/catalog`, `/hermodr/surface/:providerId`, `/hermodr/document/:providerId`, and `/hermodr/commands/eve`. Eve already tries Hermodr live providers before local fixture providers. Sai already has a useful projection module in `src/eve.js` that emits `gamecult.eve.surface.v1` with `vn.stage`, `story.continue`, `story.choose`, `story.jump`, and `style.patch`.

The missing organ is Sai-owned provider runtime/state. `src/sai.js` owns browser-local Ink playback and choice/continue behavior, but it is not a daemon, not shared state, and not a receipt authority. The current Sai fixture under Eve is static surface-state, not provider truth.

### Authority Map

Owner:

- Sai provider daemon owns story session state, accepted command effects, surface version, style tokens, and receipts.
- Odin owns discovery and aggregation only.
- Hermodr owns browser lowering and command publication only.
- Eve owns rendering semantics and command envelope shape only.

Inputs: compiled Ink JSON, Sai visual manifest, `gamecult.eve.command.v1` docs, optional style patches, CultMesh/Odin RUDP snapshot requests.

Outputs: `gamecult.eve.provider_advertisement.v1`, `gamecult.eve.surface_state.v1`, `sai.visual_novel.command_receipt.v1` or `gamecult.eve.command_receipt.v1`, optional visible story-state document.

Invariants:

- fixture JSON is not state authority;
- browser DOM player cannot own live provider state;
- Hermodr cannot invent provider catalog entries;
- Odin cannot synthesize Sai scene truth from snapshots;
- Hermodr returning `202` is not command proof; provider receipt plus surface version change is proof.

Forbidden writers:

- Eve fixture fallback must not mutate or synthesize live Sai state;
- Hermodr must not apply `story.choose`;
- Odin must not turn local fixture files into daemon truth;
- Sai static embedder must not pretend browser-local Ink state is shared provider state.

### Implementation Plan

1. Add a Sai provider daemon.
   Likely file: `E:/Projects/Sai/src/provider-daemon.cjs`.
   It loads `examples/static-site/story.ink.json` and `visual-manifest.json` for the first proof, uses `src/eve.js#createVisualNovelSurface`, and owns a session state. Start with the smallest coherent `.cc` or in-memory-plus-store path; do not make DOM playback the state owner.

2. Publish provider-owned CultMesh documents.
   Provider id candidate: `sai.visual_novel.survivor` or `gamecult.home.vn`.
   Store candidate: `E:/Projects/Sai/.voidbot/status/cultmesh/sai-vn-provider.cc` or `E:/Projects/Sai/state/sai-vn-provider.cc`.
   Advertisement must include schemas, witnesses, surface document, command route, command schemas, receipt schema, and receipt key pattern.

3. Let Odin discover Sai through existing paths.
   Prefer live RUDP provider publication into Odin. For the first smoke only, an explicit `cultmesh-store:file://...` import is acceptable if it is marked smoke scaffolding. Do not add raw path discovery.

4. Extend Hermodr only if receipt visibility is missing.
   Existing `POST /hermodr/commands/eve` can publish command docs. Add a narrow receipt read/poll route only if needed. Hermodr must not apply the command or cache final state.

5. Apply commands in Sai.
   On `story.choose { index: 0 }`, Sai provider calls Ink `ChooseChoiceIndex(0)`, advances visible line, updates path/speaker/line/choices/variables, increments `version`, republishes `gamecult.eve.surface_state.v1`, and writes a receipt with `commandId`, `previousVersion`, `nextVersion`, status, timestamp, effect summary, and denial reason if any.

6. Prove through browser.
   Start Sai provider, Odin, and Hermodr. Open Eve browser through Hermodr, confirm Sai appears in `/hermodr/verse/catalog`, click a choice, then verify provider receipt and newer surface state through `/hermodr/surface/<providerId>`.

### Likely Files To Touch

Sai:

- `E:/Projects/Sai/src/provider-daemon.cjs`
- `E:/Projects/Sai/src/eve.js`
- `E:/Projects/Sai/src/sai.js`
- `E:/Projects/Sai/scripts/smoke-live-provider.mjs`
- `E:/Projects/Sai/package.json`

Odin:

- `E:/Projects/Odin/src/hermodr-daemon.cjs`, only if receipt readback is missing.
- `E:/Projects/Odin/src/odin/documents.cjs`, only if receipt schema registration is needed.

Eve:

- Ideally no change to `E:/Projects/Eve/web/surface.js`.
- Change `E:/Projects/Eve/packages/eve-browser-lowering/src/index.ts` only if command affordance or receipt display is visually missing.

### Tests And Smokes

Sai smoke:

- initial surface version N has first line and one choice;
- publish `story.choose`;
- provider writes completed receipt;
- surface version N+1 has changed line/path/choices;
- Hermodr can read both new surface and receipt.

Odin/Hermodr smoke:

- `/hermodr/verse/catalog` lists the Sai provider;
- `/hermodr/surface/<providerId>` returns provider-owned state;
- `POST /hermodr/commands/eve` creates a command doc and does not mutate state itself.

Eve smoke:

- reference browser renders through Hermodr, not `web/fixtures/sai-vn-surface.json`;
- reload shows provider state after the command.

### Acceptance Gate

The task is not done until:

1. Sai publishes live advertisement and surface into CultMesh.
2. Odin discovers it without raw path scraping.
3. Hermodr lists it from `/hermodr/verse/catalog`.
4. Eve browser renders it through `/hermodr/surface/<providerId>`.
5. `story.choose` changes Sai-owned scene state.
6. Sai writes provider-owned receipt.
7. Reloading the browser shows provider state, not repaired local UI state.

## 3. Heimdall Deadbolt / Revocation

Owner agent: Heimdall.

Grounded repos:

- `E:/Projects/Heimdall`
- `E:/Projects/Bifrost`

Grounded source:

- `E:/Projects/Heimdall/src/store/types.ts`
- `E:/Projects/Heimdall/src/store/schema.ts`
- `E:/Projects/Heimdall/src/store/in-memory.ts`
- `E:/Projects/Heimdall/src/store/postgres.ts`
- `E:/Projects/Heimdall/src/claims.ts`
- `E:/Projects/Heimdall/src/app.ts`
- `E:/Projects/Heimdall/src/verifier.ts`
- `E:/Projects/Heimdall/src/verse-witness.ts`
- `E:/Projects/Heimdall/src/verse-state.ts`
- `E:/Projects/Bifrost/docs/jurisdiction-map.md`
- `E:/Projects/Bifrost/src/Bifrost.Web/Features/Bridge/BridgeActionService.cs`

### Current Mechanism

Heimdall already gives grants a `status: "active" | "revoked"` and `listActiveGrants` filters only active grants. Sessions, however, are persisted only as `id/account/app/expires/claims/accessRevision`; there is no session status or revocation field. `issueAccessClaim` signs access and refresh JWTs, then upserts the session row.

The critical fault line is `/sessions/refresh`: it verifies the signed refresh token and mints a new access/refresh pair using `sid` and `access_revision`, but does not load and validate the session row first. Managed credential resolution also lacks a deadbolt; it uses app-secret plus `accountId/provider` and returns or refreshes provider access tokens from linked identity custody.

Heimdall already has audit events and Verse witness descriptors, but `verse-state.ts` currently advertises an empty command list. Bifrost consumes Heimdall claims/capability references, but currently checks shape, not live revocation state.

### Authority Map

Owner: Heimdall owns revocation decisions for sessions, grants, linked provider credentials, and capability references.

Inputs: operator or app-authenticated command, target type, account id, app slug, session id, grant id, provider, reason code, actor/provenance, optional external receipt/correlation id.

Outputs: updated authoritative row state, monotonic revocation record, audit event, redacted CultCache/CultMesh witness, optional HTTP revocation feed/introspection response, app-consumable deadbolt receipt.

Invariant:

- a revoked session cannot refresh;
- a revoked grant cannot contribute facts;
- a revoked managed credential cannot resolve or refresh;
- a revoked completion cannot redeem;
- a consumer with the revocation feed cannot accept a dead capability reference locally.

Derived state: JWKS, health, Eve/CultMesh projections, Bifrost receipts, app-local revocation caches.

Forbidden writers: Bifrost, Odin, Eve renderers, app dashboards, and browser callback pages must not mutate Heimdall revocation state except through explicit Heimdall command APIs.

### Implementation Plan

1. Add canonical revocation state.
   Touch `src/store/schema.ts`, `src/store/types.ts`, `src/store/in-memory.ts`, and `src/store/postgres.ts`.
   Add `sessions.status`, `revoked_at`, `revoked_by`, `revocation_reason`, and likely `revocation_id`.
   Add completion revocation fields or model completions through session revocation.
   Add credential status or a `credential_revocations` table.
   Add store methods: `findSession`, `revokeSession`, `revokeAccountSessions`, `revokeGrant`, `revokeLinkedIdentityCredential`, `listRevocationsSince`.

2. Make session row the refresh gate.
   In `/v1/apps/{appSlug}/sessions/refresh`, after JWT signature validation, load the session by `sid`.
   Reject if missing, wrong account/app, expired, revoked, or `session.accessRevision !== refreshClaim.access_revision`.
   On refresh, update only active sessions. Do not let session upsert resurrect a revoked row.

3. Add command endpoints.
   Proposed endpoints:
   - `POST /v1/admin/revocations/sessions`
   - `POST /v1/admin/revocations/accounts/{accountId}/sessions`
   - `POST /v1/admin/revocations/grants/{grantId}`
   - `POST /v1/apps/{appSlug}/managed-credentials/revoke`

   Use a scoped operator/app command secret, not the generic app shared secret unless explicitly constrained.

4. Add local consumer deadbolt.
   Access JWTs are stateless, so consumers need a revocation feed/cache or introspection for sensitive actions.
   Add redacted feed: `GET /v1/revocations/since?cursor=...` or equivalent CultMesh/CultCache witness.
   Extend `src/verifier.ts` to accept an optional revocation index callback checking `sid`, `jti`, `account_id`, `app.slug`, and `access_revision`.

5. Wire managed credential deadbolt.
   `managed-credentials/resolve`, patron support sync, and entitlement refresh must reject revoked linked credentials before decrypting or refreshing provider tokens.
   OAuth relink should create a new active credential generation and audit the replacement, not silently un-revoke the old one.

6. Publish receipt/provenance.
   Emit audit events: `session_revoked`, `account_sessions_revoked`, `grant_revoked`, `managed_credential_revoked`, `refresh_denied_revoked`, `managed_credential_denied_revoked`.
   Extend `verse-witness.ts` with `heimdall.revocation.v0`.
   Advertise revocation command shapes in `verse-state.ts`, but keep mutation behind Heimdall APIs.
   Bifrost later consumes revocation feed for `HeimdallCapabilityReference`; it does not write revocation.

### Tests And Smokes

Store tests in `E:/Projects/Heimdall/tests/store.test.ts`:

- revoked session cannot be updated back to active by claim issuance;
- revoked grants disappear from active grants;
- revoked credentials do not resolve.

App tests in `E:/Projects/Heimdall/tests/app.test.ts`:

- refresh works before revocation;
- refresh fails after revocation;
- account-wide revocation kills all sessions;
- completion redemption fails after session/completion revocation;
- managed credential resolve returns `410` or `403` after credential revocation.

Verifier tests:

- a valid signed JWT is rejected when `sid` or `jti` appears in local revocation index.

Witness/runtime tests:

- revocation schema is advertised;
- no tokens/secrets are exported;
- command boundary lists Heimdall-owned revocation commands.

### Risks

TTL alone is not a deadbolt. Already-issued stateless access claims cannot be instantly killed unless consumers adopt a revocation feed/cache or introspection path.

The session upsert path can accidentally resurrect revoked sessions if not cut first.

Bifrost currently checks capability-reference shape, not live validity. External crossings need either fresh Heimdall verification plus revocation index, or a Heimdall-issued capability receipt with revocation status.

Upstream OAuth provider revocation may be best-effort. Local deadbolt must land first.

## 4. Mimir Live Frame Proof

Owner agent: Mimir, with Odin/Muninn and Fensalir dependencies.

Grounded repos:

- `E:/Projects/Mimir`
- `E:/Projects/Odin`
- `E:/Projects/Fensalir`

Grounded source:

- `E:/Projects/Odin/crates/muninn-daemon/src/main.rs`
- `E:/Projects/Odin/crates/muninn-move-tracker/src/lib.rs`
- `E:/Projects/Mimir/src/Mimir.Runtime/Synchronization/MimirMuninnMoveEvidence.cs`
- `E:/Projects/Mimir/src/Mimir.Runtime/Synchronization/MimirNativeReservoirRuntime.cs`
- `E:/Projects/Mimir/native/reservoir/src/lib.rs`
- `E:/Projects/Mimir/src/Mimir.Runtime/Synchronization/MimirMoveFusion.cs`
- `E:/Projects/Mimir/src/Mimir.Runtime/MimirRuntime.cs`

### Named Proof Target

Use one explicit frame id as the proof spine:

`muninn:nightwing:move-evidence:<sequence>` -> `mimir:starfire:move-evidence:<sequence>` -> `mimir:starfire:move-pose:<sequence>` -> Fensalir-visible frame/probe.

Do not claim "pose solved" unless optical candidates and calibrated camera witnesses are present.

### Current Mechanism

Mimir already has most of the receiving path:

- Muninn-shaped docs are mirrored by `MimirMuninnMoveEvidence.cs`.
- CultMesh evidence frames deserialize and admit latest shared-memory frame via `TryAdmitLatestCultMeshFrame`.
- Native `move_evidence` samples are pinned/admitted through `MimirNativeReservoirRuntime.cs`.
- Native reservoir has fixed `LocalcastMoveEvidenceSample` / descriptor ABI.
- Mimir fusion consumes native samples and emits `mimir.move_controller_pose.v1`.

The first hard blocker is upstream: Muninn daemon currently serializes `marker_candidates` as an empty slice around `crates/muninn-daemon/src/main.rs:3220`. The marker extractor exists in `crates/muninn-move-tracker/src/lib.rs`, but is not wired into the daemon evidence frame.

The second gap is presentation: Mimir runtime UI shows tracking buffer summaries, but the active Fensalir visual path is still audio spectrum `AquariumBufferFieldFrame`, not Move evidence/pose proof.

### Authority Map

Owner: Mimir owns the proof verdict. Muninn owns local observation and marker/controller extraction. Fensalir renders proof; it does not decide proof.

Inputs: one Muninn evidence stream frame with at least one `muninn.move_marker_candidate.v1` and one `muninn.move_controller_state.v1`, plus calibration ids, tracking-space id, and camera calibration.

Outputs: native reservoir `move_evidence` admission handle, Mimir fused pose frame, Fensalir-visible proof surface, and typed proof receipt with clock history.

Invariant: every stage preserves source timestamp, producer publish time, Mimir arrival/admission time, fusion estimate time, and Fensalir presentation/probe time. No final proof may be created by a late repair loop.

Forbidden writers: OBS, dashboard broker state, Muninn marker/controller streams, and Odin discovery must not decide pose/fusion/proof success.

### Implementation Plan

1. Wire real Muninn marker candidates.
   Touch `E:/Projects/Odin/crates/muninn-daemon/src/main.rs` near `publish_move_evidence_stream_frame`. Bridge `muninn-move-tracker` output into `MuninnMoveMarkerCandidateWire`. The empty marker slice is the cut line.

2. Add Mimir clock-history record.
   Add typed record near `MimirMuninnMoveEvidence` or `MimirTrackingObservation`: source timestamps, `ObservedAt`, `PublishedAtNs`, ring handle sequence/time, Mimir read/admit time, reservoir edge/window, fusion estimated time, Fensalir frame time. Keep it typed MessagePack/CultCache-compatible, not load-bearing JSON.

3. Extend Mimir admission metadata.
   `TryAdmitLatestCultMeshFrame` should expose decoded `FrameId`, producer peer, published ns, sample min/max source time, sample counts by kind, reservoir handle, reservoir status edge/window, and Mimir read timestamp.

4. Prove reservoir retention.
   Assert the admitted handle points at the descriptor, count increments once, edge equals source max, arrival equals latest Mimir/Muninn arrival, and expiry behaves under the five-second window.

5. Fuse only with calibrated optical evidence.
   `MimirMoveFusion` already refuses uncalibrated optical evidence and marks orientation `orientation:imu-unresolved`. The live proof should require at least two calibrated marker rays for triangulated proof, or explicitly label single-ray fallback as not full fusion.

6. Lower to Fensalir as a dev proof surface.
   Add a Move proof frame/overlay separate from the audio spectrum field. It should show/probe frame id, pose confidence, latency, evidence kind, and reservoir edge.

7. Publish observer-only Eve/dashboard surface.
   Surface fields: selected frame id, producer, source/publish/arrival/admit/fusion/present timestamps, reservoir counts, pose confidence, failure reason. No commands and no private HTTP/WebSocket truth.

### Tests And Smokes

Existing useful smokes:

```powershell
dotnet run --project .\src\Mimir.BufferSmoke\Mimir.BufferSmoke.csproj -- --muninn-move-cultmesh-stream-smoke
dotnet run --project .\src\Mimir.BufferSmoke\Mimir.BufferSmoke.csproj -- --move-native-reservoir-smoke
dotnet run --project .\src\Mimir.BufferSmoke\Mimir.BufferSmoke.csproj -- --move-fusion-smoke
```

Add:

- Odin unit: evidence frame contains non-empty marker candidates when supplied a bright Y8 frame.
- Mimir unit: decoded frame preserves `FrameId`, `PublishedAtNs`, marker/controller timestamps, and sample ordering.
- Mimir native smoke: one named frame enters `move_evidence` and emits a clock-history receipt.
- Fusion smoke: no calibrated markers means no pose; two calibrated markers means triangulated pose with expected latency.
- Fensalir smoke: render/probe confirms the named frame id and proof overlay are visible in the GPU-presented frame.

### Risks

Current daemon path publishes no optical markers. A real fusion proof is blocked until Odin/Muninn wires marker candidates.

Marker `ObservedAt` currently risks being conflated with source/arrival time. The proof must separate source, publish, read, admit, fusion, and present times.

Single-ray fallback can look like success. The proof must label fallback explicitly.

Fensalir currently visualizes audio spectrum fields, not Move proof frames.

## 5. Ymir Unity Runtime Proof

Owner agent: Ymir + Aetheria.

Grounded repos:

- `E:/Projects/Ymir`
- `E:/Projects/Aetheria`

Grounded source:

- `E:/Projects/Ymir/tools/verify-aetheria-ymir-cutover.ps1`
- `E:/Projects/Ymir/src/Ymir.Core/YmirSimulator.cs`
- `E:/Projects/Ymir/src/Ymir.Core/YmirSoAWorld.cs`
- `E:/Projects/Ymir/tests/Ymir.Tests/YmirSimulatorTests.cs`
- `E:/Projects/Aetheria/Assets/Scripts/Gameplay/Physics/AetheriaYmirPhysicsBridge.cs`
- `E:/Projects/Aetheria/Assets/Scripts/Gameplay/Weapons/Projectile.cs`
- `E:/Projects/Aetheria/Assets/Scripts/Gameplay/HullCollider.cs`
- `E:/Projects/Aetheria/Assets/Scripts/Gameplay/ShieldManager.cs`
- `E:/Projects/Aetheria/Assets/Scripts/ServerShared/YmirPhysicsContracts.cs`
- `E:/Projects/Aetheria/Packages/org.gamecult.aetheria.state/Runtime/AetheriaRuntimeYmirProjectilePhysics.cs`

### Current Mechanism

The static verifier now proves the obvious source-level cut: old gameplay collision authority paths are absent, projectile travel/direct-hit discovery routes through `AetheriaYmirPhysicsBridge.TryStepProjectile`, and projectile failure closes instead of falling back to Unity physics.

Ymir core steps cloned SoA worlds, applies CultMath radial acceleration, integrates bodies, resolves circle contacts, and emits `ContactEvent`. DTO worlds are canonicalized by sorting bodies/fields by id before lowering to SoA.

Aetheria Unity path builds a Ymir request from projectile plus daemon-render-native-view bodies, calls `YmirPhysicsQueries.Step(request)`, resolves contact body ids back to `HullCollider`, and applies visual hit effects from Ymir output. `HullCollider` and `ShieldManager` are presentation only and have no gameplay `OnCollisionEnter`.

The remaining proof must watch runtime GameObjects, disabled colliders, callback traces, Ymir step/contact output, and visible projectile snapshots in Unity PlayMode.

### Authority Map

Owner: Ymir step/query semantics own projectile kinematics and contact discovery for this proof.

Inputs: projectile pose/velocity/radius/mass/world time; daemon SoA entity ids, positions, velocities, radii, inverse mass; fixed or captured `deltaTime`; Unity presentation objects only as witnesses/effect targets.

Outputs: next projectile position/velocity, ordered Ymir contacts, resolved target hull for visual effect, diagnostic trace containing frame/tick, Ymir request/result, Unity pose, collider/callback observations.

Invariants:

- disabling Unity projectile/target colliders must not prevent Ymir travel or hit detection;
- `OnCollisionEnter` observer may record a callback, but gameplay state cannot change because of it;
- replaying the same Ymir world/request sequence produces same contact order;
- mid-flight projectile transform matches Ymir snapshot within named tolerance;
- Ymir step failure fails closed, not fallback to Unity physics;
- manual scene setup, programmatic spawn, and replay share the same Ymir step/commit primitive.

Forbidden writers:

- production `Projectile.OnCollisionEnter`, `HullCollider.OnCollisionEnter`, `ShieldManager.OnCollisionEnter`;
- any `Physics.*` query deciding projectile hit truth;
- transform repair loops overriding Ymir snapshots;
- damage/stat mutation from Unity collision callbacks.

### Implementation Plan

1. Add PlayMode test assembly.
   Likely file: `E:/Projects/Aetheria/Assets/Scripts/Tests/PlayMode/YmirUnityRuntimeProofTests.cs`.
   Existing `Assets/Scripts/Tests/Tests.asmdef` is Editor-only; add a PlayMode-compatible asmdef or separate test assembly.

2. Add test-only runtime harness.
   Helpers inside the PlayMode test:
   - `YmirRuntimeProbe`: per-frame projectile transform, expected Ymir position, callback counts, hit events, kill state.
   - `CollisionObserverOnly`: `OnCollisionEnter` counter only, no gameplay mutation.
   - minimal body-source fixture for `AetheriaYmirPhysicsBridge`.

   If `AetheriaYmirPhysicsBridge.TryBuildDaemonWorld` cannot accept a clean fixture because it is hard-coupled to `AetheriaDaemonObserver.LastRenderNativeView`, introduce a tiny body-source seam. Do not fake the Ymir step.

3. Disabled-collider proof.
   Spawn projectile and target presentation object, disable projectile/target colliders, feed bridge daemon SoA body for target, advance N frames.
   Assert projectile position changes by Ymir, Ymir hit occurs, disabled colliders do not affect hit frame beyond tolerance, and removing Ymir bodies kills closed.

4. Callback observer-only proof.
   Attach `CollisionObserverOnly` with colliders enabled. Assert callback count may be zero or positive, but gameplay hit/damage/effect path is driven by Ymir result, and adding/removing observer does not change Ymir sequence.

5. Deterministic replay/contact order proof.
   At contract layer, extend Aetheria or Ymir tests with multi-contact shuffled input order. Prefer proving adapter/request canonicalization.
   At PlayMode layer, capture runtime Ymir request sequence and replay twice through `YmirPhysicsQueries.Step`, asserting identical contact body id pairs and first-hit target.

6. Mid-flight snapshot tolerance proof.
   Sample projectile transform after each frame and compare to Ymir result. Use a named tolerance, such as `0.02 Unity units` or `max(0.02, speed * deltaTime * 0.01)`. Assert no later frame repairs an earlier mismatch.

### Commands

Static/current:

```powershell
pwsh -File E:\Projects\Ymir\tools\verify-aetheria-ymir-cutover.ps1 -AetheriaRoot E:\Projects\Aetheria
dotnet test E:\Projects\Ymir\Ymir.slnx
dotnet run --project E:\Projects\Aetheria\Aetheria.State.Verify -- E:\Projects\Aetheria
```

Unity target shape:

```powershell
Unity.exe -batchmode -projectPath E:\Projects\Aetheria -runTests -testPlatform PlayMode -testResults E:\Projects\Aetheria\scratch\ymir-playmode-results.xml -logFile E:\Projects\Aetheria\scratch\ymir-playmode.log
Unity.exe -batchmode -projectPath E:\Projects\Aetheria -runTests -testPlatform EditMode -testResults E:\Projects\Aetheria\scratch\ymir-editmode-results.xml -logFile E:\Projects\Aetheria\scratch\ymir-editmode.log
```

Unity version: `6000.4.2f1` from `E:/Projects/Aetheria/ProjectSettings/ProjectVersion.txt`.

### Risks

The bridge may be too tightly coupled to `AetheriaDaemonObserver.LastRenderNativeView`. If so, add a tiny body-source seam, not a fake parallel bridge.

`Projectile.Update()` applies gravity/drag before Ymir step. The proof should account for that as input preparation and watch for split authority if Ymir is supposed to own those forces later.

Unity collision callbacks are timing-unstable; tests should prove callbacks are irrelevant, not require them to fire.

Contact order is only as deterministic as body request ordering. Canonicalize before Ymir step or sort contacts explicitly at the boundary.

## 6. Weksa Language-Project State

Owner agent: Weksa, with Zyphos/Druzkai and AquaSynth as consumers.

Grounded repos:

- `E:/Projects/weksa`
- `E:/Projects/Zyphos`
- `E:/Projects/AquaSynth`
- `E:/Projects/AetheriaLore`

Grounded source:

- `E:/Projects/weksa/schemas/language-project-state.md`
- `E:/Projects/weksa/state/map.yaml`
- `E:/Projects/weksa/settings/eusocial-interbeing/language-design.md`
- `E:/Projects/weksa/settings/eusocial-interbeing/airawa-first-contact-slice.md`
- `E:/Projects/weksa/scripts/weksa-daemon.mjs`

### Current Mechanism

Weksa currently has a human-facing schema receipt and setting pressure notes for Zyphos/Airawa. It has a standalone daemon script and existing CultMesh/CultCache provider store publication at `.weksa/provider-advertisement-store.cc`.

Docs already claim `.weksa/projects/{projectId}.cc` and `weksa.language_project`, but the live daemon script does not publish a real `weksa.language_project` nested Verse or witness family. The first job is to make the advertised body real.

The first proof should be a hand-authored Airawa/Druzkai seed, not a generic schema cathedral. Provisional forms like `atar`, `tazek`, `kazhar`, and `Druzkai` must be structurally provisional until phonology/morphology/usage validate them.

### Authority Map

Owner: `weksa.language_project_state.v0`.

Inputs: `weksa.interlingua_packet.v0` meaning packets, authored language-project state, setting canon refs from Zyphos/Aetheria, provisional seed evidence from notes/chat/examples/model critique, typology/phonology references, consumer constraints from AquaSynth, Zyphos/Druzkai, Nibu/Aetheria, Odin/Eve.

Outputs:

- `.weksa/projects/{projectId}.cc`
- `weksa.language_project_state.v0`
- `weksa.language_project_catalog.v0`
- `weksa.language_project_trace.v0`
- optional compiled runtime bundle later
- Eve/CultUI language-project inspection surface
- render/phonetic/provenance traces consumed by Zyphos and AquaSynth

Invariants:

- ontology owns concept identity, splits, collapses, salience, worldview pressure;
- grammar owns required expression, syntax, agreement, evidentiality, clause shape;
- phonology owns phonemes, syllables, prosody, phonotactics, romanization;
- morphology owns roots, affixes, derivation, inflection, compounding;
- diachrony owns proto-forms, sound changes, drift, strata, irregularity;
- lexicon entries are receipts from those owners, not independent truth;
- corpus examples cite project state and provenance;
- canon/provisional status is field-level and evidence-backed;
- renderer never invents meaning;
- setting docs supply canon/source pressure, but do not own language state;
- AquaSynth owns articulation/audio realization, while Weksa owns phonological/phonetic intent.

### State Shape

Use an executable schema family shaped like:

```yaml
schema: weksa.language_project_state.v0
project_id: weksa.language.airawa.pre_imperial.seed.v0
status: draft | provisional | reviewed | canonical | deprecated
metadata: {}
canon_policy: {}
provenance: {}
ontology: {}
phonology: {}
grammar: {}
morphology: {}
diachrony: {}
lexicon: {}
corpus: {}
validation: {}
trace: {}
```

Every project and entry needs status/confidence/provenance. A lexicon entry marked `canonical` without evidence must fail validation.

### Implementation Plan

1. Update the schema receipt.
   Define `weksa.language_project_state.v0`, `weksa.language_project_catalog.v0`, and `weksa.language_project_trace.v0` in `schemas/language-project-state.md` and related schema docs. Include field-level `status`, `confidence`, `evidence_refs`, `canon_refs`, `reviewer`, `promotion_blockers`, and `supersedes`.

2. Define the Airawa seed project.
   Scope it to pre-imperial/non-imperial Airawa first-contact social mechanics, not all Airawa. Include Druzkai as related Face/name pressure, not language owner.

3. Normalize provisional forms.
   Convert `settings/eusocial-interbeing/airawa-first-contact-slice.md` into lexicon/morphology/grammar seed records with `status: provisional_seed`, stating what is known, unknown, and required before promotion.

4. Add deterministic validation.
   New tool candidate: `E:/Projects/weksa/tools/validate_language_project_state.mjs`.
   Validate required sections, stable ids, referential integrity, status enums, provenance refs, lexicon roots pointing to morphology/phonology, corpus examples pointing to entries, and no canon entries lacking evidence.

5. Add seed emitter.
   New tool candidate: `E:/Projects/weksa/tools/emit_airawa_language_project_seed.mjs`.
   Emit `.weksa/projects/airawa-pre-imperial-seed.cc` and `.weksa/projects/catalog.cc`.

6. Publish through daemon.
   Extend `scripts/weksa-daemon.mjs` document definitions with language project schemas. Extend provider advertisement with `weksa.language_project` nested Verse and witness family `.weksa/projects/{projectId}.cc`. Extend `cultMeshPublications` with catalog/project entries.

7. Add operator/Eve visibility.
   Show language-project count, reviewed/provisional counts, latest project id, schema drift, and validation status. Later add `weksa.eve.language_project_review.v0`.

8. Add consumer examples.
   Create a Zyphos naming brief consuming Airawa state without claiming canon output. Create an AquaSynth phonetic-intent handoff from one provisional form as phonetic evidence, not tract/audio truth.

### Tests And Smokes

Minimum:

- `validate_language_project_state` passes Airawa seed;
- canonical lexicon entry without evidence fails;
- corpus example referencing missing lexeme/root fails;
- phonology segment not declared in inventory fails unless marked loan/foreign;
- daemon snapshot includes `weksa.language_project`;
- CultMesh store writes project/catalog documents when runtime is available;
- debug JSON disabled still leaves `.cc` authority;
- AquaSynth consumer smoke treats Weksa phonology as intent, not audio truth.

### Dependencies And Risks

Zyphos owns setting canon and ecological/political truth. Weksa owns language-project interpretation. Druzkai consumes language surfaces as Persona/context pressure; it does not own state.

AquaSynth consumes Weksa phonetic/IPA/PanPhon-style intent, but owns realization embeddings, articulatory constraints, synth control, and audio.

The live daemon docs and code currently disagree. Do not build another lane; make `weksa.language_project` real.

CultMesh runtime availability may be fragile; keep first implementation to schema receipt, validator, seed emitter, and daemon advertisement update.

Human IPA/PanPhon evidence can accidentally colonize alien phonology. Keep phonology and audio realization separate.

Model critique remains evidence, not accepted state.
