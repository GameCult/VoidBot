# VoidBot Implementation Plan

This is the current forward plan for the next larger organs. It is not a changelog and it is not allowed to become a duplicate brain for the canonical map.

## Current Aim

Use the persistent project-state surfaces to keep future work source-grounded and rehydratable while continuing to cut oversized runtime organs into cleaner seams.

## Near-Term Organs

### 1. Public-Lane Hardening

- tighten moderation and abuse handling for non-owner traffic
- make budgets and rate-limit policy easier to inspect/administer
- preserve the current owner/public provider boundaries instead of letting them blur

### 2. Recovery That Is More Adult Than Hope

- add a real restore-drill cadence instead of stopping at backup verification
- reduce dependence on interactive workstation logon where practical
- keep watchdog signals and dashboard diagnostics honest when dependencies are degraded
- keep adjacent-service checks behind private local extensions so VoidBot does not quietly mutate into a generic infra panic funnel

### 3. Admin And Forensics Surfaces

- richer inspection around jobs, provider runs, tool usage, interaction memory, and rate-limit denials
- better "what happened?" answers without spelunking raw artifacts by candlelight

### 4. Legibility Hardening

- continue splitting oversized runtime files where concern boundaries are already obvious
- likely next cuts: `apps/worker/src/mcp-server.ts` or `packages/providers/src/local-llm-provider.ts`
- keep behavior stable while moving concerns into smaller organs

### 5. The Still-Scaffolded Paths

- replace the remaining scaffolded provider paths with funded or production-grade implementations
- move sandbox execution from policy theater to real constrained runners when the policy story is ready

## Rules For Editing This Plan

- update this note when the larger sequence of work changes
- do not dump volatile minute-by-minute status here
- if a lesson changes future belief, record it in `state/evidence.jsonl`
- if the current next action changes, update `state/map.yaml` and `notes/fresh-workspace-handoff.md`
