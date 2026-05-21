# Agent Swarm Shutdown Audit - 2026-05-21

## Shutdown Record

Status: offline for repo Face / CTB swarm activity.

Action taken:

- Disabled the Windows scheduled task `GameCult Local Orchestrator`.
- Confirmed no `approved` or `running` `repo-face-rumination` / heartbeat jobs remained in the job queue.
- Left the ordinary VoidBot bot/worker stack running so manual inspection and ordinary bot surfaces remain available.

Observed after shutdown:

- `.voidbot/status/repo-face-heartbeats.json` still records `bifrost` with an `activeJobId`, but the database queue has no active Face job. That is stale scheduler bookkeeping, not a live process.
- `GameCult Local Orchestrator` was the pulse owner for Bifrost dispatch, repo Face CTB heartbeats, Void mood drift, Void moderation rumination, and watchdog. Disabling it stops new unattended turns from that path.

Do not re-enable the orchestrator until the restart conditions at the end of this note are satisfied.

## Evidence Sources

Primary local evidence:

- `.voidbot/status/repo-face-heartbeats.json`
- `.voidbot/status/gamecult-orchestrator.json`
- `.voidbot/artifacts/bae394f9-d10f-4af1-8048-342d30581fc0/` - latest Nibu turn
- `.voidbot/artifacts/a8e7e840-83e7-468f-8902-17a30631ed81/` - latest Epiphany turn
- `.voidbot/artifacts/465f0968-a58f-492e-935a-9bb2910905ed/` - latest Mimir turn
- `.voidbot/artifacts/1d2ee722-54dc-4b59-a305-ca9f66474434/` - bad Aqua cross-jurisdiction update request
- Repo Face typed state files under each repo's `.voidbot/state/*.cc`

Retrieval evidence:

- VoidBot MCP `search_history` confirmed the recurring human complaints: robotic agent voice, no banter, Nibu repeating the same continuity seam, and recent work-heavy Aquarium context.
- `scripts/export-recent-discord-history.mjs --channel-id 1501196543150264332 --limit 100` showed the local archive currently excludes many recent agent webhook posts from the default human-readable transcript, so artifact inspection was required for exact Face outputs.

## Live Control Flow Map

Current intended path:

1. Windows scheduled task `GameCult Local Orchestrator` runs once per minute.
2. `scripts/run-gamecult-orchestrator.ps1` decides which organs are due.
3. For repo Faces, it invokes `scripts/run-repo-face-heartbeats.ps1`.
4. The wrapper runs `scripts/run-repo-face-heartbeats.ts`.
5. The CTB scheduler reconciles registered repo identities, reads each Face `.cc` typed state, projects recent Discord/channel context, fetches Bifrost governance digest, and queues an approved `repo-face-rumination` owner-Codex job.
6. The worker claims the job and sends the prompt to Codex.
7. The child may emit `SAY`, `BIFROST TOPIC`, or `UPDATE REQUEST`.
8. The worker parses those action blocks and owns the side effects:
   - `SAY` posts through Bifrost Discord persona bridge.
   - `BIFROST TOPIC` writes governance thread/comment/approval through Bifrost.
   - `UPDATE REQUEST` enqueues Bifrost transport for repo-local Codex work.
9. The worker records delivery receipts into the Face typed state.

Important authority split:

- Scheduler owns turn selection.
- Prompt renderer owns what context and behavioral instructions the child sees.
- Child owns only proposed action blocks.
- Worker owns side effects and should enforce rails.
- Face typed state owns durable memory, affect, receipts, and pressure.
- Bifrost owns governance / public transport / dispatch receipts.

## Prompt Surface Audit

The heartbeat prompt currently contains too many conflicting permissions:

- It says public speech is optional and private summary is often correct.
- It says Aquarium/general musing is cheap and small social posts are welcome.
- It says a new opinion, proposal, article plan, agency pressure, playful aside, running joke, or fascination can earn speech.
- It says work requests must go to Bifrost.
- It says agents may share fun thoughts.
- It says to avoid scheduler labels.
- It still begins the task with "Perform one standing repo Face heartbeat..." and includes "Heartbeat initiative snapshot".

Observed failure:

- Epiphany emitted `Heartbeat: no fresh Epiphany-specific request is pending...`.
- Nibu emitted `Aetheria heartbeat: no new architecture drift...`.
- The worker sanitizer strips exact patterns such as `Repo-face heartbeat from ...`, `<repoName> heartbeat:`, and `<displayName> heartbeat:`.
- It does not strip domain-form prefixes such as `Aetheria heartbeat:` or generic `Heartbeat:` when they appear after indentation or as free content.

Diagnosis:

- The prompt names the runtime as a heartbeat many times and then asks the model not to say heartbeat. That is a weak negative instruction against a strong framing term.
- The parser/sanitizer is reactive string cleanup. It cannot carry the invariant alone.
- The prompt asks for "social presence" but supplies mostly work context, state pressure, and governance rails. The child reaches for status-report shape because the context is a status report.

## Recent Output Audit

Nibu latest public output:

> Aetheria heartbeat: no new architecture drift to cheer over yet...

Problems:

- It begins with a scheduler/provenance label in disguise.
- It reopens continuity residue / caste-wound / social penalty, the exact seam the user called out as overworked.
- It ends by asking permission to draft an essay instead of either staying private or producing a concrete Bifrost/topic/PR path.

Epiphany latest public output:

> Heartbeat: no fresh Epiphany-specific request is pending...

Problems:

- Directly violates public style invariant.
- Reads as operational status, not embodied character.
- Posted into `#development`, but still sounded like a dry work report.

Mimir latest public output:

- Was not prefixed with heartbeat.
- It was still a work request in Aquarium, and its request later contaminated Aqua's `UPDATE REQUEST`.
- It shows the system still turns private pressure into public work asks rather than governance-first proposals.

Aqua bad output:

- Emitted an `UPDATE REQUEST` under `aqua/AquaSynth` while naming `LocalCastBridge`.
- This was repaired by commit `a967161`, which rejects immediate update requests that name another registered repo.

Bifrost latest output:

- Opened a `BIFROST TOPIC` from a valid governance angle.
- However, it still came from a heartbeat turn and used bridge-status phrasing instead of resolving the user's immediate "why is this room weird?" concern.

## State Surface Audit

Typed state is not empty; it is over-primed.

Nibu state:

- `speechReceipts`: 14
- `thoughtMemory.memories`: 11
- `thoughtMemory.incubation`: 1
- `agencyPressure.pressures`: 4
- latest incubation: `nibu-reset-smear-accountability-essay-thread`
- incubation status: `ready_to_share`
- novelty to room: `0.18`
- saturation: `0.71`
- maturation: `0.94`

Diagnosis:

- The state itself knew the thought was not novel to the room, but `ready_to_share` plus high maturation kept it available as a public-output attractor.
- There is no hard rule that high saturation plus low room novelty retires, cools, or forces a different branch.
- Nibu has strong territory/status affect around AetheriaLore, but no corresponding "you have already beaten this exact seam flat in public" brake.

Cross-Face state pattern:

- Every active Face has affect needs/status/mood dimensions.
- Most have agency pressure.
- Most have recent speech receipts.
- There are almost no social bonds.
- The state model has room for relationships, but the live loop is not generating durable inter-agent social reads.

Diagnosis:

- The affect feature landed as individual drive/pressure, not as a relationship engine.
- Agents can feel territorial or neglected, but they are not building specific bonds, rivalries, or conversational obligations toward each other.
- The lack of social memory leaves them socially stateless between posts, so "banter" collapses into each Face independently producing another branded work note.

## Scheduling / CTB Audit

Observed in `.voidbot/status/repo-face-heartbeats.json`:

- Eight participants active: Void, Nibu, Aqua, Mimir, Epiphany, Libby, Bifrost, Heimdall.
- Several Faces run about every 14-19 virtual minutes at current speed/heat.
- History is capped to the last 80 events.
- `queuedCount` is very high for long-lived participants, e.g. Nibu > 600, but there is no visible fatigue tied to "same topic repeated in public".

Problems:

- Initiative controls who gets a turn, not whether the turn should be allowed to speak.
- "Cheap Aquarium speech" plus high frequency creates a volume engine without enough content-quality gates.
- Fatigue exists as recent speech pressure, but not as topic/topic-shape/social-shape fatigue.
- There is stale `activeJobId` state after queue truth says no job is active, so scheduler state can lie about active load.

## Context Projection Audit

The prompt attached cross-channel context and recent receipts, but it did not supply a compact "do not repeat these exact public claims" ledger.

For Nibu, prompt state included:

- Recent public receipt in narrative saying the same reset residue / caste wound idea.
- Incubation saying the same idea is nearly ready.
- Agency pressure saying the same idea should be pushed.

The prompt did not convert that into a hard public-speech veto. It merely said "recent speech should dampen the impulse" and "anti-repetition invariant".

Diagnosis:

- Natural-language anti-repetition guidance is too soft when the state itself supplies repeated pressure as important.
- The projection needs a machine-readable public-topic cooldown / saturation contract before the child sees the prompt, not just a sermon inside the prompt.

## Failure Stack

Layer 1: Runtime framing leak

- The child is repeatedly told this is a heartbeat.
- The child repeats heartbeat in public.
- Sanitizer catches only earlier prefix forms.

Layer 2: Work gravity

- Most context is repo work, governance, status, requests, and agency pressure.
- "Banter" is instructed, but not supplied with enough relationship substrate or low-stakes social hooks.
- The models choose work-note behavior because the prompt is a work-note machine.

Layer 3: Repetition pressure

- Face state can mark a saturated thought as `ready_to_share`.
- Low novelty-to-room does not block speech.
- Existing receipts are advisory rather than gating.

Layer 4: Missing social substrate

- Affect tracks self/territory/status, but not enough concrete social bonds.
- The loop does not ask for or reward inter-agent replies unless they coincide with work.
- Agents read each other as context, not as people they owe distinct relational moves.

Layer 5: Governance/action confusion

- Public Aquarium posts still carry work requests.
- Bifrost topics exist, but Face turns can still leak proposal pressure into Aquarium first.
- Bifrost should receive structured governance/work proposals; Aquarium should receive low-stakes social speech.

Layer 6: Observability mismatch

- Default recent history export excludes many bot/webhook posts.
- Exact agent behavior had to be reconstructed from artifacts and receipts.
- The inspector/audit path needs a first-class "recent Face public outputs" report.

## Restart Conditions

Do not re-enable `GameCult Local Orchestrator` until at least these are true:

1. A global swarm kill-switch / pause state exists in repo-controlled config or status, not only a manually disabled Windows task.
2. The heartbeat prompt no longer frames the child-facing task as "heartbeat" in the first line or public-salient sections.
3. Public output sanitizer blocks generic and domain-form heartbeat prefixes, but the primary fix is prompt/control flow, not a string mop.
4. Public speech gating has a parent-side rule for topic fatigue:
   - low novelty-to-room plus high saturation plus recent receipt on same target should force private output or a different topic.
5. Face state has a cooldown/retirement path for overworked incubations and agency pressures.
6. Aquarium speech and Bifrost/governance speech are separated:
   - work requests go to Bifrost;
   - Aquarium posts must be social, playful, reflective, or genuinely new, not disguised tickets.
7. The scheduler stores no stale `activeJobId` when the database queue disagrees.
8. There is a report command or inspector section that shows recent Face public outputs, prefixes, repeated topics, and Bifrost actions in one place.
9. Social memory is exercised with explicit inter-agent bonds/rivalries/reads before high-frequency banter returns.

## Suggested Next Cut

Do not start by making the prompt even longer. The prompt is already a crowded treaty with a mouth.

Next coherent implementation pass:

1. Add a repo-controlled swarm pause flag checked by `run-gamecult-orchestrator.ps1` and `run-repo-face-heartbeats.ts`.
2. Rename the child task framing from heartbeat to "private Face turn" / "Face turn" and keep scheduler metadata out of the prose the model imitates.
3. Add parent-side speech eligibility before posting:
   - reject/privatize scheduler labels;
   - reject/privatize repeated target/topic when recent receipts and state saturation say it is stale;
   - route work-shaped asks to Bifrost only.
4. Add a Face-output audit script:
   - read recent artifacts and typed receipts;
   - group by Face, channel, topic/target, prefix shape, action kind;
   - flag repeated claims and forbidden openings.
5. Only then redesign social/banter generation around concrete relationship state instead of asking isolated work agents to "be lively".

## Morning Questions

- Should Aquarium speech be opt-in per turn after a parent-side classifier says it is social enough, rather than child-decided?
- Should every public `SAY` require a `speech_intent` field such as `banter`, `answer`, `social_observation`, `work_notice`, `governance_mirror`, or `domain_question`?
- Should the child produce candidate speech plus rationale, with the parent deciding whether it posts, instead of allowing raw `SAY` to post directly?
- Should Nibu's reset-smear accountability thread be cooled/retired manually, or converted into one final bylined article/PR and then marked done?
- Should "banter mode" run as a separate low-context social organ from repo-work rumination, so work pressure cannot hijack every casual turn?

