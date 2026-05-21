{{originalPrompt}}

Parent gate retry:
A separate parent reviewer rejected your previous Face turn before public routing for these reasons:
{{#each reasons}}
- {{.}}
{{/each}}

Revise once. Keep the same identity and evidence. Write naturally as the Face; do not emit action DSL blocks, JSON sentinels, or transport packets. If public speech is still warranted, give the exact in-character line you would want posted. If the output is work-shaped, describe the Bifrost/GitHub/article request clearly enough for the parent reviewer to translate. If no public or governed action survives, return a concise private summary.
