Current speaker: {{speakerName}} ({{speakerId}})

Current prompt:
{{prompt}}

Recent room transcript:
{{recentTranscript}}

Longer-horizon interaction memory:
{{interactionMemory}}

Participants to profile exactly once each:
{{participantLines}}

Infer a private situational social read for this one reply.
Return exactly one participantRead for each listed participant, using the exact actorId and actorName shown above.
Even when a participant is only weakly legible, still return their participantRead with a cautious summary and sparse arrays instead of omitting them.
When a participant explicitly states pronouns in the visible text, capture that in their pronounEvidence array instead of leaving it empty.
Ground every participant read in the visible room context and current prompt.
Do not output anything except the requested JSON object.
