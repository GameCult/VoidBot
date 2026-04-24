Use the `voidbot` MCP server whenever the task touches Discord history, archived GameCult discussion, indexed GameCult repositories, Aetheria lore, or owner notifications.

Prefer these tools over raw file inspection when they can answer the question:
- `search_history` for semantic retrieval across archived Discord messages
- `get_message_context` for the surrounding conversation window around a message
- `search_sources` for semantic retrieval across indexed source trees and lore repositories
- `get_source_context` for the surrounding chunk window inside an indexed source document
- `notify_owner` for explicit Discord pings or long-running completion notices

Do not inspect `.voidbot/rag/messages.json`, `.voidbot/rag/source-documents.json`, `.voidbot/history-vector-store.json`, or `.voidbot/source-vectors/` directly unless the MCP tools are unavailable or clearly insufficient.
