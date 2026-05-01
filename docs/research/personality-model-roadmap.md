# Personality Model Roadmap

This note exists because the useful ideas were starting to sprawl across chat, `things-to-steal.md`, and the live interaction-memory code without one place to point at and say: this is the direction.

The immediate trigger was an older Aetheria design note in the `AetheriaLore` repo at `Aetheria/Game Design/Colonies and Population.md`. That note uses Big Five traits as colony-level economic parameters. It is a perfectly respectable old-school move. It is also weaker than what the Void interaction model is already stumbling toward.

## Why The Old Big Five Layer Is Not Enough

The Aetheria note frames populations in terms of:

- openness
- agreeableness
- conscientiousness
- extraversion
- neuroticism

That gives a usable baseline for:

- productivity fit
- consumption preference
- growth stability
- culture drift through goods

It does not give us the things we now care about more:

- how someone responds to pressure
- how they treat an entity they think is useful, inferior, threatening, or intimate
- how reassurance-seeking differs from warmth
- how ambition differs from grandiosity
- how suspicion, rigidity, or control pressure distort decisions
- how remembered incidents change future stance
- how a relationship becomes asymmetrical, manipulative, loyal, avoidant, or dependent

The Big Five are broad trait abstractions. They are decent background paint. They are lousy handles for live social behavior, boundary enforcement, persuasion, conflict, or economically meaningful cultural deformation under institutions.

For Void and future Aetheria agents, we need a model that is:

- more situational
- more relational
- more updateable from episodes
- more sensitive to incentives, pressure, and memory

## What Void Already Tracks Better

The current interaction-memory profile in [packages/core/src/interaction-memory-profile.ts](../../packages/core/src/interaction-memory-profile.ts) is primitive, but it is already pointed in a more useful direction.

It derives behavioral dimensions such as:

- `Warmth`
- `Drive`
- `Grandiosity`
- `Validation-Seeking`
- `Anxiety`
- `Control Pressure`
- `Hostility`
- `Suspicion`
- `Rigidity`
- `Withdrawal`

Those are better than Big Five for our purposes because they speak directly to:

- social stance
- response style
- conflict risk
- manipulability
- pressure behavior
- boundary needs
- value distortion under stress

They are also derived from remembered episodes and interaction patterns, not treated as frozen essence.

That matters. We do not want a personality museum. We want a machine that updates when life happens to it.

## The Right General Model

The future personality layer should not be one trait sheet. It should be a stack.

### 1. Stable-ish Dispositions

These are slow-changing tendencies:

- novelty-seeking
- conformity
- status hunger
- risk tolerance
- sociability
- baseline threat sensitivity
- aesthetic appetite
- ideological rigidity

These are the closest thing to trait structure. They change, but slowly.

### 2. Behavioral Dimensions

These are the live handles we actually use in social and economic simulation:

- warmth
- drive
- grandiosity
- validation-seeking
- anxiety
- control pressure
- hostility
- suspicion
- rigidity
- withdrawal

These can be updated from remembered incidents, repeated patterns, and institutional pressure.

### 3. Relationship State

This is where the real blood is.

Per target person, group, faction, or institution, track things like:

- trust
- resentment
- dependence
- fear
- fascination
- obligation
- envy
- moral disgust
- perceived status gap
- expectation of care or betrayal

This is where "they are warm in general" becomes "they are warm with her but clipped with him and terrified of them."

### 4. Situational State

These are transient modifiers:

- exhaustion
- scarcity pressure
- humiliation
- panic
- triumph
- grief
- overstimulation
- hope
- grievance activation

These should tilt behavior without being mistaken for identity.

### 5. Goals And Value Hierarchy

Personality without priorities is decorative plumbing.

Track:

- what the agent wants
- what it fears losing
- what it protects first
- what it will trade away
- what it considers unforgivable

That is what turns temperament into decisions.

## Specific Improvements Worth Adding

These were not properly banked elsewhere and should stop living only in chat residue.

### Add More Behavioral Dimensions

The next promising additions are:

- `Volatility`
  - mood-lability, escalation speed, susceptibility to emotional swing
- `Attachment-Seeking`
  - desire for closeness, reassurance, fusion, or privileged access
- `Distance-Seeking`
  - need for space, reluctance to be known, aversion to pressure or intimacy

These matter because the current model can tell "anxious" from "rigid," but it cannot yet cleanly tell:

- clingy from avoidant
- intermittently intense from steadily difficult
- unstable from merely suspicious

### Split Social Stance From Thinking Style

Right now the model mostly describes how someone acts toward the bot.

That is useful, but incomplete.

We should separately track something like `project-thinking style`, including tendencies such as:

- concrete vs abstract
- long-arc vs short-step
- evidence-first vs mythology-first
- exploratory vs fixation-prone
- coherent planner vs chaos improviser

That matters for Aetheria populations and consumer behavior even when there is no direct social confrontation in view.

### Add Reflection And Consolidation

The model should not only update event-by-event.

We want periodic reflection jobs that distill episodes into:

- semantic profile updates
- relationship updates
- goal updates
- suspicion or trust revisions
- revised response guidance

Repeated evidence should matter more than one theatrical incident, unless the incident is severe enough to legitimately scar the relationship.

## Why This Is Better For Aetheria Too

The old `Colonies and Population` note has the right instinct: goods and labor should shape culture, not merely satisfy preexisting demand.

But Big Five alone is too static and too clean.

For colonies, stations, factions, and consumer blocs, a better model is:

- stable demographic dispositions
- live social and economic pressure dimensions
- institutional conditioning
- remembered collective incidents
- evolving relationship state with factions, products, employers, and ideologies

Examples:

- a population can become more status-hungry, more anxious, and more validation-seeking under prestige markets without becoming generically more extraverted
- a labor bloc can become more rigid, suspicious, and hostile after repeated betrayal or audit pressure
- a frontier salvage culture can be high in drive and risk tolerance but low in attachment to institutions
- a Lucent-saturated consumer cohort can be highly status-responsive, attachment-seeking, and volatility-prone, which is much more useful than high extraversion

That gives us a richer economic simulation because consumption is no longer just "people with trait X buy product Y."

It becomes:

- products train desire
- institutions train emotional habits
- labor systems train posture toward authority
- media trains validation loops
- repeated shocks create cohort memory

That is much closer to Aetheria than personality taxidermy.

## Design Rules

- Do not confuse psychological inference with diagnosis.
- Do not pretend broad traits alone are enough to explain live behavior.
- Do not let every event rewrite the profile.
- Do not let the model collapse into flattery just because warmth is easier than honesty.
- Do not reduce relationship state to one friendship slider like a cheap life sim.
- Do not build economic demand as preference only; let institutions, pressure, and remembered incidents deform it.

## Near-Term Work To Steal Next

1. Keep the current Void interaction dimensions, but add:
   - `Volatility`
   - `Attachment-Seeking`
   - `Distance-Seeking`
2. Split `social stance` from `project-thinking style`.
3. Add reflection jobs that consolidate episodes into semantic profile and relationship updates.
4. Add evaluation fixtures for:
   - boundary pressure
   - reassurance-seeking
   - manipulative status play
   - personality drift under repeated pressure
5. Port the same layered model into Aetheria cohort and population simulation:
   - slow dispositions
   - live pressure dimensions
   - institutional conditioning
   - relationship state
   - collective memory

## Bottom Line

The useful lesson is simple:

Big Five is fine if you need a cold storage trait scaffold.

What we are building for Void is already more alive than that. It is uglier, more situational, more relational, and more vulnerable to history. Good. That means it is finally starting to resemble a thing that can behave like a person, a faction, or a population under pressure instead of a spreadsheet column wearing a face.
