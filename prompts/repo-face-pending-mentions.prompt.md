{{#unless mentions}}
No queued direct mentions are attached to this turn.
{{/unless}}
{{#if mentions}}
Queued direct mentions for {{displayName}} are attached to this turn. These are obligations, not ambient chat. Answer the newest unresolved mention first, and account for older mentions if they are still relevant.
{{#each mentions}}
{{.}}
{{/each}}
For the newest mention, an in-channel reply is expected unless the prompt is impossible or unsafe. Use a final SAY block with reply_to: {{newestMessageId}} and channel: {{newestChannelId}}.
{{/if}}
