import type { RepoDiscordIdentity } from "@voidbot/core";
import type { InitiativeParticipant } from "./initiative-engine.js";

export function buildInspectionParticipant(identity: RepoDiscordIdentity, baseRecoveryMinutes: number): InitiativeParticipant {
  return {
    identityId: identity.id,
    participantKind: "repo_face",
    turnKind: "repo_face_rumination",
    repoName: identity.repoName,
    displayName: identity.displayName,
    initiativeSpeed: 1,
    reactionBias: 0.5,
    interruptThreshold: 0.6,
    currentLoad: 0,
    status: "active",
    groups: ["all", "kind:repo_face", "turn:repo_face_rumination", `identity:${normalize(identity.id)}`, `repo:${normalize(identity.repoName)}`],
    heat: 1,
    dynamicHeat: 0,
    responsePressure: 0,
    responsePressureEvidence: [],
    semanticInterruptReceipts: [],
    effectiveSpeed: 1,
    baseRecoveryMinutes,
    nextTurnAt: 0,
    queuedCount: 0,
    constraints: [
      "Prompt assembly is deterministic inspection only.",
      "Character memory and affect prose must come from the Interpreter memory surface.",
    ],
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
