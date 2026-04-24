import { type SandboxProfile, type SandboxProfileName } from "@voidbot/shared";

export const defaultSandboxProfiles: Record<SandboxProfileName, SandboxProfile> = {
  read_only_lookup: {
    name: "read_only_lookup",
    allowedCommands: ["lookup", "search_index"],
    networkAccess: false,
    timeoutMs: 5000,
    requiresApproval: false,
  },
  rag_maintenance: {
    name: "rag_maintenance",
    allowedCommands: ["reindex_channel", "backfill_embeddings"],
    networkAccess: false,
    timeoutMs: 30000,
    requiresApproval: true,
  },
  owner_workflow: {
    name: "owner_workflow",
    allowedCommands: ["prepare_manual_bundle", "publish_owner_reply"],
    networkAccess: false,
    timeoutMs: 30000,
    requiresApproval: true,
  },
  public_low_risk: {
    name: "public_low_risk",
    allowedCommands: ["summarize_channel", "search_history", "search_sources"],
    networkAccess: false,
    timeoutMs: 10000,
    requiresApproval: false,
  },
};
