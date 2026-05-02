export { MAX_RECENT_INTERACTION_EVENTS } from "./interaction-memory-shared";

export {
  buildInteractionMemoryEvent,
  normalizeInteractionEvent,
  shouldPersistInteractionEvent,
  type RecordInteractionInput,
} from "./interaction-memory-analysis";

export {
  emptyInteractionProfile,
  emptyInteractionIdentityState,
  mergePronounEvidenceIntoIdentityState,
  normalizeInteractionIdentityState,
  summarizeInteractionProfile,
} from "./interaction-memory-profile";
