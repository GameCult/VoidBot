{{originalPrompt}}

Parent gate retry:
A separate parent reviewer rejected your previous Face turn before public routing for these reasons:
{{#each reasons}}
- {{.}}
{{/each}}

Revise once. Keep the same identity and evidence. If public speech is still warranted, emit one clean SAY block whose content starts as the Face speaking to the room, not as a scheduler/status/note label. If the output is work-shaped, use BIFROST TOPIC instead of UPDATE REQUEST. If no public or governed action survives, return a concise private summary with no action block.
