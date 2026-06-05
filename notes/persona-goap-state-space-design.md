# Persona GOAP State-Space Design

Drafted 2026-06-05 after comparing Ghostlight state projection and Weksa
structured utterance lowering.

## Objective

Make repo Personas and public Faces choose actions through explicit state-space
planning instead of prompt-flavored instinct. The planner should act as the
missing social/sensory autopilot substitute: read signals, model counterpart
state, propose next actions, predict effects, and compare the result against
observed reality.

This is a bounded GOAP/MuZero-shaped layer, not a giant universal planner. If
it tries to own all cognition, prose, state mutation, and transport, it becomes
the old prompt machine wearing a planning hat and lying about its ankles.

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

GOAP should fit between these two machines, but the reward function is not a
generic conversation score. The reward function is a projection of the
Persona's personality: its values, needs, bonds, fascinations, aversions,
current pressures, and role constraints. The planner is not trying to win a
conversation. It is trying to choose a future state that would satisfy this
Persona in a way that remains truthful, consensual, inspectable, and coherent.

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
- One reward projection for the current turn: the Persona-specific satisfaction
  and aversion surface used to score possible futures.
- Candidate action receipts with preconditions, predicted effects, cost, risk,
  reversibility, evidence used, confidence, and expected reward/cost terms.
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

Goals are weighted deltas, not one global victory condition. They are derived
from the Persona's value and affect machinery, not from a universal assistant
success metric:

- satisfy stable values
- satisfy active needs such as recognition, closeness, curiosity, usefulness,
  rest, play, dignity, or solitude
- advance active goals
- honor or repair bonds
- preserve agency, consent, and privacy
- increase shared-model accuracy
- reduce confusion
- protect character/persona dignity
- experience competence, puzzle-satisfaction, beauty, humor, praise, relief, or
  hard-earned closure when those rewards belong to the Persona
- avoid shame pressure, coercion, false authority, abandonment, incoherence,
  boredom, manipulation, or self-betrayal

Each goal should include:

- target state dimension
- desired direction
- weight
- forbidden tradeoffs
- evidence needed to know whether it improved

## Reward Projection

Classical GOAP assumes the designer can write useful costs and effects by hand.
The AlphaGo -> AlphaZero -> MuZero line suggests a better posture: combine
search with learned or model-projected value and transition estimates, then
compare prediction receipts against observed outcomes. For Personas, the
learned world model is not "how all humans work." It is a compact, inspectable
model of how this Persona expects action to move the local social/task state and
how satisfying or aversive that next state would feel to them.

Reward projection reads:

- stable values and their current activation
- affect needs and deprivation/satisfaction levels
- agency pressures
- bonds and status reads
- active memories and unresolved tensions
- current room/task affordances
- role constraints and consent boundaries

It emits terms such as:

- `value_satisfaction`
- `need_satisfaction`
- `curiosity_reward`
- `competence_reward`
- `recognition_reward`
- `bond_warmth`
- `repair_reward`
- `aesthetic_reward`
- `agency_reward`
- `incoherence_cost`
- `boundary_cost`
- `shame_cost`
- `manipulation_cost`
- `staleness_cost`
- `authority_violation_cost`

The exact weights are Persona-specific. Nibu should not experience the same
reward landscape as Aqua, Mimir, Epiphany, Libby, Metacrat, or Void. Same room,
different internal weather.

Reward terms are planning receipts, not durable truth. They explain why a
candidate looked attractive now. They do not mutate the Persona, and they do
not excuse a harmful action just because the Persona would find it satisfying.
Soul still owns constraint checks.

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
5. Project Persona-specific reward/cost terms over each predicted future.
6. Score candidates with bounded A*/GOAP/MuZero-style heuristic.
7. Emit a short action plan, reward receipt, and prediction receipt.
8. Parent gate checks authority, risk, freshness, constraints, and transport.
9. Weksa lowers speech-shaped actions into utterance packet and trace.
10. Action executes.
11. Appraiser compares observed event to predicted effect and predicted reward.
12. State Mutator applies reviewed deltas through typed operations.

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
      "id": "satisfy-metacrat-coherence",
      "target": "self.value_satisfaction.coherence",
      "direction": "increase",
      "weight": 0.82,
      "forbiddenTradeoffs": ["invented facts", "coercive certainty"]
    }
  ],
  "rewardProjection": {
    "sourceStateRefs": ["persona-state-ref", "room-event-ref"],
    "terms": [
      { "id": "coherence", "weight": 0.88, "activation": 0.91 },
      { "id": "curiosity", "weight": 0.74, "activation": 0.69 },
      { "id": "recognition", "weight": 0.46, "activation": 0.38 },
      { "id": "manipulation_cost", "weight": -0.95, "activation": 0.2 }
    ]
  },
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
      "predictedReward": [
        { "term": "coherence", "delta": 0.28, "confidence": 0.7 },
        { "term": "curiosity", "delta": 0.12, "confidence": 0.52 },
        { "term": "task_delay_cost", "delta": -0.08, "confidence": 0.62 }
      ],
      "evidenceRefs": ["room:recent-message"],
      "weksaIntent": {
        "private_interpretation": "The user may be asking for implementation or architecture.",
        "intended_effect": "Clarify the authority boundary before cutting.",
        "visible_action": "Ask one direct question."
      }
    }
  ],
  "selectedPlan": ["ask-what-layer"],
  "selectionRationale": "Higher Persona-specific coherence reward with lower irreversible risk.",
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
