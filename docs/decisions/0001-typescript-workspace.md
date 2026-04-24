# ADR 0001: TypeScript Workspace For The First Implementation

## Status

Accepted

## Context

The spec leaves the first implementation language open, but recommends a TypeScript bot and worker. The project needs a Discord-native surface, long-lived worker process, shared contracts, and a clear provider abstraction.

## Decision

Start with an npm workspace and TypeScript project references:

- `apps/bot` handles Discord I/O
- `apps/worker` processes queued jobs
- `packages/*` hold shared contracts and internal services

## Consequences

- Shared type contracts stay explicit and compile-checked across the bot and worker.
- We can keep the provider boundary clean while still moving quickly on Discord integration.
- The repo is ready for PostgreSQL, persistent vector storage, and additional providers without changing the public Discord contract.
