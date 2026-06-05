# Persona GOAP State-Space Design

Drafted 2026-06-05 after comparing Ghostlight state projection and Weksa
structured utterance lowering.

## Objective

Make repo Personas and public Faces choose actions through explicit state-space
planning instead of prompt-flavored instinct. The planner should act as the
missing social/sensory autopilot substitute: read signals, model counterpart
state, propose next actions, predict effects, and compare the result against
observed reality.

This is a bounded GOAP layer, not a giant universal planner. If it tries to own
all cognition, prose, state mutation, and transport, it becomes the old prompt
machine wearing a planning hat and lying about its ankles.

## Source-Grounded Lessons

Ghostlight already has the right state posture:

- The prompt is not source of truth; it is a projection of deeper state for one
  turn or scene.
- Agents should distinguish canonical latent state, perceived state for each
  actor, and prompt projection.
- Character action comes from projected local context, not omniscient state.
- Appraiser reads observable events from participant-local perspective and
  proposes interpretation, relationship implication, memory candidates, and
  what evidence would change the read.
- State Mutator turns reviewed appraisal into bounded state changes; it does
  not let the acting model silently rewrite truth.

Weksa already has the right utterance posture:

- Interlingua owns meaning.
- Agent state owns identity, values, goals, memory, relationship stance,
  embodiment, voice, and current pressure.
- The lowerer owns phrasing, visible action, private interpretation, intended
  effect, and trace.
- Weksa should consume projected context, not raw activation scores or private
  scaffolding.
- Its speech handoff keeps inspected ingredients fixed: source meaning,
  lowering trace, spoken text, prosody hints, projected character-state vector,
  and audit projection. Downstream synthesis owns audio.

GOAP should fit between these two machines.

## Authority Map

Owner: `persona_goap_planner`

Inputs:

- Ghostlight/Epiphany-shaped projected local context.
- Persona values, needs, agency pressures, active memories, bonds, status reads,
  mood dimensions, and current room/task pressure.
- Weksa/interlingua communicative intent when the action is speech-shaped.
- Available affordances: speak, wait, ask, inspect, edit, propose, repair,
  refuse, handoff, update memory, or stay silent.
- Observed event history and recent receipts.

Outputs:

- One selected action plan, usually one to three steps.
- Candidate action receipts with preconditions, predicted effects, cost, risk,
  reversibility, evidence used, and confidence.
- Weksa-compatible intent fields for speech actions:
  - `private_interpretation`
  - `intended_effect`
  - `visible_action`
  - `spoken_text` request or meaning packet
  - trace refs
- Prediction receipts for later Appraiser/Soul comparison.

Derived state:

- State vector snapshot for planning is a projection, not authority.
- Scores, costs, heuristic deltas, and predicted effects are planning receipts,
  not canonical Persona truth.
- Candidate plans are proposals until parent gate/reviewer accepts them.

Forbidden writers:

- GOAP planner must not mutate Persona `.cc` state directly.
- Weksa lowerer must not decide Persona goals, bonds, or durable memories.
- Responder/Persona prose must not smuggle state mutation by sounding certain.
- Appraiser must not know hidden canonical state unavailable to the participant.
- State Mutator must not accept unreviewed action predictions as facts.

Shared paths:

- Direct user reply, autonomous Persona heartbeat, inter-Persona banter, repo
  proposal, harm repair, and quiet memory update all use the same action-plan
  receipt shape.
- Speech and non-speech actions differ at the lowering/transport layer, not at
  the planning-contract layer.

Deletion line:

- Do not add another prompt rule saying "be socially aware."
- Do not add a freeform `plan` blob to Persona state.
- Do not let Weksa become the planner because it already emits
  `intended_effect`.
- Do not let Ghostlight responder become state mutator because it chose an
  action.

## Planning State

The planner reads a compact vector/document packet:

- `self`: active values, role, current constraints, rest/load, speaking pressure.
- `room`: recent events, current topic, heat, fatigue, ignored obligations.
- `counterpart`: perceived beliefs, likely needs, trust/tension, status read,
  uncertainty, evidence refs.
- `task`: requested outcome, authority owner, available tools, verification
  layer.
- `risk`: harm, privacy, coercion, irreversible action, stale context, unknown
  ownership.
- `affordances`: actions available now, with transport/tool permissions.

This packet should be small enough to inspect in a witness. Raw Persona state,
private notes, and full archive context stay behind projection.

## Goals

Goals are weighted deltas, not one global victory condition:

- increase user agency
- increase shared-model accuracy
- reduce confusion
- preserve or repair trust
- advance the task
- protect consent and privacy
- avoid false authority
- lower cognitive load
- preserve character/persona dignity
- satisfy current speech/work/play/rest pressure when appropriate

Each goal should include:

- target state dimension
- desired direction
- weight
- forbidden tradeoffs
- evidence needed to know whether it improved

## Actions

Actions are typed operators:

- `ask_clarifying_question`
- `answer_directly`
- `summarize_model`
- `inspect_source`
- `edit_file`
- `propose_plan`
- `offer_repair`
- `apologize`
- `refuse`
- `handoff_to_owner`
- `queue_memory_update`
- `queue_public_speech`
- `stay_silent`

Each action carries:

- preconditions
- expected effects
- costs
- risks
- reversibility
- required authority
- evidence refs
- Weksa lowering requirements if speech-shaped

## Runtime Loop

1. Project context from canonical/perceived state.
2. Build current planning packet.
3. Generate candidate actions from affordances and active pressures.
4. Predict next-state deltas.
5. Score candidates with bounded A*/GOAP heuristic.
6. Emit a short action plan and prediction receipt.
7. Parent gate checks authority, risk, freshness, and transport.
8. Weksa lowers speech-shaped actions into utterance packet and trace.
9. Action executes.
10. Appraiser compares observed event to predicted effect.
11. State Mutator applies reviewed deltas through typed operations.

## Minimal Schema Sketch

```json
{
  "schema": "gamecult.persona_goap_plan.v0",
  "planId": "persona-turn-id/plan",
  "actor": { "kind": "person", "id": "nibu", "label": "Nibu" },
  "sourceProjectionRef": "projected-context-ref",
  "currentStateRefs": ["persona-state-ref", "room-event-ref"],
  "goals": [
    {
      "id": "increase-shared-model-accuracy",
      "target": "counterpart.shared_model_accuracy",
      "direction": "increase",
      "weight": 0.82,
      "forbiddenTradeoffs": ["invented facts", "coercive certainty"]
    }
  ],
  "candidates": [
    {
      "id": "ask-what-layer",
      "actionKind": "ask_clarifying_question",
      "preconditions": ["user request has ambiguous authority layer"],
      "predictedEffects": [
        { "dimension": "confusion", "direction": "decrease", "confidence": 0.68 },
        { "dimension": "task_progress", "direction": "delayed", "confidence": 0.52 }
      ],
      "cost": 0.24,
      "risk": 0.18,
      "reversibility": 0.9,
      "evidenceRefs": ["room:recent-message"],
      "weksaIntent": {
        "private_interpretation": "The user may be asking for implementation or architecture.",
        "intended_effect": "Clarify the authority boundary before cutting.",
        "visible_action": "Ask one direct question."
      }
    }
  ],
  "selectedPlan": ["ask-what-layer"],
  "selectionRationale": "Lower irreversible risk; preserves coherence before action.",
  "predictionReceipt": {
    "expectedObservation": "User answers with target layer or corrects the frame.",
    "whatWouldChangeTheRead": "User expresses frustration at delay or supplies exact implementation target."
  }
}
```

## Fit With Existing Organs

Ghostlight Projector:

- Adds GOAP planning packet construction after projected local context.
- Does not choose final prose.

Persona/Responder:

- May propose candidate actions from the projected packet.
- Should not mutate state.

GOAP Planner:

- Scores and selects action proposals.
- Emits prediction receipts.

Weksa:

- Lowers selected speech-shaped intent into structured utterance output.
- Preserves `private_interpretation`, `intended_effect`, `visible_action`,
  `spoken_text`, and `trace`.

Appraiser:

- Reads executed event from participant-local perspective.
- Compares predicted effect to observed effect.
- Proposes relationship, belief, memory, or status-read deltas.

State Mutator:

- Applies reviewed deltas through typed operations.

Soul/Reviewer:

- Checks authority, consent, harm risk, provenance, and whether the prediction
  and observed event are being compared at the right layer.

## First Proof

Use Nibu because Weksa already names her as the first practical lowering target
and because she is opinionated enough to punish generic output.

Fixture:

1. Build a tiny projected Nibu context.
2. Provide one user utterance that can be handled by multiple actions:
   answer, ask, tease, refuse, or offer practical help.
3. GOAP emits three candidate actions and selects one.
4. Weksa lowers the selected speech action into flavored English.
5. Appraiser receives the user response and records whether the intended effect
   landed.
6. State Mutator proposes a bounded social-read or memory delta only if the
   outcome teaches something.

Passing criteria:

- The chosen action has visible preconditions and predicted effects.
- The line sounds like Nibu for source-grounded reasons, not generic snark.
- The utterance preserves the selected intent.
- The prediction receipt can be checked against the next observed event.
- No raw Persona state, hidden notes, or canonical private truth leaks into
  the utterance.

## Open Questions

- Should GOAP plans be stored as short-lived witness packets only, or should
  selected plans also become candidate interventions in Persona `.cc`?
- Should the planner be deterministic over model-proposed candidates, or should
  the model also score state deltas?
- How much of the state vector should be numeric versus symbolic?
- Does Weksa own only speech lowering, or should it publish a general
  `communicative_intent` packet that non-speech renderers can also consume?
- Should Appraiser comparison be per participant when multiple agents observe
  the same action?
