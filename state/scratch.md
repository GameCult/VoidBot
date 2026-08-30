# VoidBot Scratch

## Current Subgoal

Observe the first live Yggdrasil source-refresh recovery pass to a settled,
verified result while preserving the read-only retrieval boundary.

## Working Notes

- Current runtime authority: `voidbot.service` owns only the typed swarm Eve
  publisher; `voidbot-retrieval.service` separately owns read-only archive and
  source retrieval at Yggdrasil loopback `127.0.0.1:17875`.
- Do not infer that the Discord bot, worker, Persona scheduler, Postgres, or
  resident cognition organs are live from source code or the retained swarm
  projection.
- The recovery corpus is read-only. Diagnose retrieval service, tunnel,
  embedding provider, Qdrant collections, and recovered archive independently;
  the new indexing writer must remain a separate authority and lifecycle.
- Writer owner is systemd oneshot `voidbot-source-refresh.service`, triggered by
  hourly `voidbot-source-refresh.timer`. `/usr/local/sbin/refresh-voidbot-sources`
  owns the public catalog, repo mirror, pending queue, flock, and stable
  `voidbot-source-indexer` container cleanup.
- Deployed authorities: VoidBot
  `3fa4a8742060ac54b9f0e27b8d8751db76fd3a8c`; gamecult-ops
  `a1c5fc8bec7f7aaf565d8cddcf486605021c7416`.
- Writer service restoration and continuity are achieved: the oneshot has a
  24-hour timeout, the hourly timer is active, one stable indexer container
  processes one repo at a time, pending drops only after repo success, and the
  log emits `embedded_chunks=N/total` progress.
- PID 2270422 was stopped during that lifecycle redesign. Live PID 2279696 is
  `phase=index`, `detail=repo_1_of_56:AetheriaEve`, with 56 repos pending and
  witness `Repo AetheriaEve: embedded_chunks=64/3739`. Qdrant is green at about
  93,701 points.
- Aetheria is committed and excluded from reconstructed pending. Before that
  completion, the measured outstanding delta was 69,060 chunks across 51
  repos. Full catch-up remains pending.
- Poll `/srv/voidbot/retrieval/status/source-refresh.status`; inspect
  `/srv/voidbot/retrieval/log/source-refresh.log` and
  `/srv/voidbot/retrieval/status/pending-repos.txt`. After settlement, verify
  empty pending work, archive/Qdrant agreement, current MCP retrieval, active
  hourly timer, and absence of a stale indexer container.
- Last durable retrieval proof is the 2026-08-16 exact-document witness for
  release `20260816T193315Z-c88c71909dbc`; it is historical evidence, not a
  present-health result.
