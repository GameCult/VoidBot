# Narrative Design in Mass Effect 2: Digest for Scenario Runner Work

Source: [Interactive Storytelling in Mass Effect 2](https://www.youtube.com/watch?v=pMd5SS35KgM), a GDC 2010 talk by BioWare lead cinematic designer Armando Troisi. This digest is based on the generated English transcript captured at `.voidbot/artifacts/scenario-runner-research/pMd5SS35KgM.transcript.txt`; generated captions may contain name and wording errors.

## One-Line Thesis

Mass Effect 2 treats story and gameplay as one machine: the player's roleplay survives cinematic authorship only when every choice interface makes a clear promise and every authored result honors that promise.

## The Core Problem

BioWare wanted a cinematic, voiced, emotionally directed RPG without breaking the player's sense that Shepard was still their character. That creates a structural tension:

- Traditional computer RPG dialogue gives the player high control, usually through verbatim lines and frequent choices.
- Cinematic presentation gives the writer, camera, actor, and editor stronger control over timing, emotion, and spectacle.
- If the cinematic layer acts without the player feeling represented, roleplay breaks.
- If the game pauses constantly for exact textual authorization, cinematic flow collapses.

The talk's answer is not "more choices." It is a disciplined agreement between designer and player about what choices mean, how they are presented, when they appear, and what consequences they are allowed to produce.

## Cinematic Design

Troisi describes cinematic designers as narrative designers first and cinematic artists second. Their job is the "how" of interactive storytelling: tools, process, staging, camera, animation, dialogue, VO, and scripting all converge in the conversation system.

The important point is that conversations are not just writing. They are the main interface through which the game communicates story intent, role, relationship, and player agency. A dialogue line is therefore also UI, animation, state mutation, pacing device, and player contract.

For our scenario runner, this is the useful frame: utterance generation is not merely text output. It is the visible tip of a projection and action pipeline. If a Persona speaks, acts, withholds, interrupts, or escalates, the runner needs to preserve the intent contract all the way from inner interpretation to visible output.

## Perspective: Subjective and Objective

The talk separates RPG storytelling into two broad perspectives.

Subjective perspective:

- The player and avatar are treated as nearly identical.
- Dialogue choices are often verbatim.
- The avatar rarely acts without direct player instruction.
- Agency is high and explicit.
- The cost is temporal distortion: time freezes while the player reads and selects; NPCs often carry exposition while the player's character waits.

Objective perspective:

- The avatar is more visibly a character in the scene.
- Camera, acting, and timing can produce stronger cinematic emotion.
- The world can feel like it continues in real time.
- The cost is distance: the avatar may speak or act in a way the player did not intend.

Mass Effect 2 tries to occupy a hybrid position: objective cinematic presentation with enough predictable choice grammar that players still feel they are roleplaying Shepard.

For a Persona scenario runner, this maps directly onto the tension between authored character and agentic projection. A Persona should not be a puppet waiting for every explicit player command, but it also cannot violate its own established intent grammar and then call that "character." The runner needs a visible covenant for how inner state becomes action.

## The BioWare Covenant

Troisi names a covenant, or agreement, between designer and player. Its rules are the talk's most reusable design object:

1. The interface for choice must be predictable.
2. A choice must produce the result the player expects.
3. The player should get the choices they want, when they want them.
4. It is the player's story; writers provide a multipath probability space.

This is stronger than "support branching dialogue." It says the experience depends on preserving trust between option, implied intent, timing, and result. Once that trust breaks, the player stops inhabiting the role and starts defending against the interface.

## The Conversation Wheel as a Promise Machine

The Mass Effect conversation wheel replaced long list-based dialogue with short paraphrases arranged in consistent positions. It works because it carries two layers at once.

Behavioral layer:

- Position on the wheel has stable meaning.
- Upper/right and lower/right options develop moral or tonal associations, such as Paragon and Renegade.
- Investigate, neutral, friendly, hostile, exit, and action patterns become readable through placement.
- A reactive player can move quickly based on behavioral intent without parsing every word.

Cognitive layer:

- The text is a short paraphrase, not the exact voiced line.
- The paraphrase summarizes the intended thought or conversational move.
- It lets a reflective player reason about what Shepard is about to mean.

The wheel is effective because these layers reinforce each other. The same short phrase means something different when placed in a compassionate, hostile, investigative, or decisive slot. The interface does not merely label content; it colors intent.

For our runner, this suggests that player-facing and author-facing choices should expose intent grammar, not raw generated prose. A scenario action might show:

- stance: reassure, challenge, probe, deflect, threaten, confess
- target: who or what the move is aimed at
- risk: what kind of social or material consequence it may invite
- sample utterance: a short paraphrase, not the full generated line

The generated utterance can vary, but the promised move must remain stable.

## Choice and Expected Result

The talk uses a small example of moving the same action to different wheel positions to show how expectation changes. A friendly or Paragon-framed "tip the dancer" option reads as generous, respectful, or positive. Put the same action in a hostile or Renegade framing and the expected meaning changes. The surface text alone does not own the choice; the full presentation does.

The failure case is the Citadel shopkeeper interaction. The player is offered something like "accuse of classism" without enough setup. Shepard then launches into a long manipulative exchange while the player mostly watches. The scene can be funny, but it violates the agreement:

- The player lacked enough context to want that move.
- The option did not fully prepare them for the scale of Shepard's behavior.
- Once selected, the scene ran away without enough agency.
- The result felt like the character hijacked the player.

The fix would not be a warning label. Troisi points toward setup: ambient lines, prior context, clearer framing, or more opportunities to steer. The system failed because it asked for a choice before earning the player's informed desire.

For a scenario runner, this is a hard rule: do not ask the player, director, or Persona to commit to an action whose social meaning has not been made legible. If the generated action is going to dominate, shame, seduce, betray, forgive, kill, or permanently alter a bond, the runner must surface the real move before executing it.

## Choices Players Want, When They Want Them

Mass Effect 2's interrupt system exists to close an emotional loop at the moment the player feels it. If a villain is monologuing and the player wants to hit them, the Renegade interrupt appears at that dramatic pressure point. If Tali is grieving and the player wants to comfort her, the Paragon interrupt lets Shepard hug her.

The interrupt matters because it appears when the desire is already present. It does not merely add optional activity. It recognizes a felt impulse and gives the player a clean way to express it.

That timing is critical for roleplay. A choice offered too early is confusing. A choice offered too late feels like bureaucracy. A choice offered at the moment of emotional readiness feels like the game understood the player.

For a Persona-driven RPG, this points toward scenario prompts that watch for pressure:

- social pressure: someone is hurt, insulted, cornered, or exposed
- moral pressure: a value has been violated
- tactical pressure: an opening appears
- relationship pressure: a bond asks to be defended, deepened, tested, or cut
- identity pressure: the Persona's self-concept is being challenged

The runner should not only ask "what can happen next?" It should ask "what action would the player or Persona be aching to take now?"

## The Player's Story as Probability Space

Troisi frames authored narrative as a multipath probability space. The writers build the possibility field; the player authors their path through it.

The Mass Effect 1 council decision shown through Mass Effect 2 Citadel ads is the simple example: old choices reappear as world texture. The state is not only a branch in a quest file. It becomes propaganda, film marketing, gendered Shepard footage, tone, public memory, and the world's interpretation of past action.

For our scenario runner, this is gold. Persistent Persona state, bonds, memories, and world facts should not only unlock binary branches. They should flavor:

- what NPCs assume
- what rumors circulate
- how factions frame prior events
- what options appear natural
- what emotional pressure a Persona feels
- what the world thinks the protagonist's story means

A good runner should lower state into scene pressure, not just query it for flags.

## Interrupts Need Telegraphs

The talk ends by warning that even an interrupt icon is not enough if the action itself is ambiguous. A Renegade interrupt might mean punch, shoot, shove, threaten, insult, or something worse. If the player cannot predict the actual action, they may press the button and immediately feel betrayed.

Mass Effect 2 solves this with cinematic telegraphing. In the suspect interrogation example, Shepard cracking his knuckles before the interrupt makes the likely action clear. The player knows the category and the specific physical implication.

This is the visual version of a paraphrase. It does not spoil every detail, but it tells the player what kind of act they are authorizing.

For the scenario runner:

- A text option needs an intent paraphrase.
- A physical action needs a visible or textual telegraph.
- A social action needs a relationship consequence hint.
- A magical or tactical action needs a target and risk hint.
- A Persona utterance needs stance, audience, and likely emotional vector.

Do not hide the real move in the generated prose and pretend the player consented because they clicked a vague verb.

## Design Lessons for a Persona Scenario Runner

The runner should preserve a covenant among player, Persona, scenario, and world state.

Choice surfaces should be predictable:

- Use stable positions, icons, colors, or labels for recurring intent families.
- Keep the same intent grammar across dialogue, action, combat, and relationship scenes.
- Separate "ask for information" from "make a claim," "take action," "change relationship," and "commit to danger."

Choices should produce expected results:

- Every option should carry enough preview to define the authorized move.
- Generated output may be richer than the preview, but it must not reverse the preview's intent.
- If model generation changes the move, the runner should reject or revise before display.

Choices should appear when wanted:

- Track scene pressure, not just turn count.
- Offer interrupts when emotional, tactical, or relational pressure crests.
- Let Personas generate candidate impulses, then lower them into selectable or auto-executable moves depending on authority.

The player's story should remain theirs:

- Store consequences as world memory, not just branch flags.
- Let prior choices change framing, rumor, available options, and emotional default.
- Preserve authored state as a possibility field, not a railroad pretending to branch.

## Weksa / Persona Interlingua Implications

If existing VoidBot Personas are dropped into a roleplaying scenario through Weksa's interlingua lowerer, the lowerer should not simply convert Persona thoughts into dialogue. It needs to preserve the covenant layers:

- projection: what the Persona privately believes, feels, notices, and wants
- interpretation: what the Persona thinks the scene means
- candidate move: what the Persona wants to do or say
- intent paraphrase: what the player/director can understand before it happens
- telegraph: what the world can see before or during commitment
- utterance/action: the actual lowered output
- consequence update: how bonds, memory, world state, and scene pressure change

The interlingua should carry intent as first-class state. If it only carries final prose, the system loses the difference between "teasing," "threatening," "testing loyalty," and "trying not to cry while pretending to joke." That difference is the actual roleplay.

## Scenario Runner Shape

A coherent runner loop could look like this:

1. Scene state loads current location, participants, hazards, goals, recent events, and relevant memories.
2. Each Persona projects private reads: desire, fear, values, bonds, assumptions, and candidate impulses.
3. The runner identifies pressure points: moments where a player or Persona would naturally want to intervene.
4. Weksa lowers candidate moves into friendly intent options with stance, target, risk, and paraphrase.
5. The selected or authorized move becomes utterance/action generation.
6. A verifier checks that generated output honors the intent contract.
7. Consequences update world facts, bonds, short-term memory, long-term memory pressure, and future scene affordances.

The crucial invariant: private Persona machinery may be rich, weird, and high-dimensional, but the playable surface must be legible enough for consent and authorship.

## Anti-Patterns

Do not present vague options that secretly encode extreme actions.

Do not let a generated utterance hijack the selected intent.

Do not treat "more branches" as a substitute for clearer choice grammar.

Do not offer choices before the scene has created the desire for them.

Do not make persistent consequences invisible until they ambush the player.

Do not flatten Persona state into final dialogue. The runner needs projection, interpretation, intent, telegraph, action, and consequence as separate surfaces.

## Short Version for Implementation

Mass Effect 2's lesson is that cinematic roleplay works when authored presentation and player agency share a stable contract. For Ghostlight-shaped RPG scenarios, that means the scenario runner should treat every Persona action as a promise-bearing move:

- What does the actor intend?
- How does the player/director know that before authorizing it?
- What visible telegraph makes the action fair?
- What output is allowed under that intent?
- What state changes prove the world understood it?

If those questions are answered, existing Personas can enter adventure RPG scenes without losing their projection, interpretation, and utterance machinery. If they are not answered, the system will generate impressive dialogue that occasionally steals the story from the person trying to play it.
