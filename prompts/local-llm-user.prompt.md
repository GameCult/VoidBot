Question: {{prompt}}

Guild context:
- Guild: {{guild}}
- Channel: {{channel}}

{{#unless repoPersonaTurn}}
Recent channel messages:
{{recentMessages}}

Retrieved archive context:
{{retrievedContext}}

Interaction memory for this speaker:
{{interactionMemory}}

Private persistent self-state for the speaking agent:
{{voidSelfState}}

Private runtime projection for this reply:
{{sleepProjection}}

Private situational social read for this room:
{{situationalSocialRead}}
{{/unless}}

If you need more archived history or source context than is included above, call the appropriate read-only tool before answering.
