import { defineDocumentRegistry, defineDocumentType } from "cultcache-ts";
import { z } from "zod";

const text = z.string().trim().min(1);
const timestamp = text;
const status = z.enum(["draft", "active", "cooling", "crystallized", "resolved", "retired"]);
const target = z.object({
  kind: z.enum(["person", "repo", "scene", "system", "room", "artifact", "concept", "relationship", "self", "community", "thread", "document", "runtime", "custom"]),
  id: text,
  label: text.optional(),
  customKind: text.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "custom" && !value.customKind) context.addIssue({ code: z.ZodIssueCode.custom, message: "Custom targets require customKind.", path: ["customKind"] });
});
const extensions = z.record(z.unknown()).optional();
const anchoredThought = z.object({
  id: text,
  status,
  target,
  summary: text,
  claim: text.optional(),
  question: text.optional(),
  tension: text,
  actionImplication: text,
  intensity: z.number().min(0).max(1).optional(),
  valence: z.number().min(-1).max(1).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  retiredAt: timestamp.optional(),
  tags: z.array(text).default([]),
  extensions,
}).strict();
const traitVector = z.object({ mean: z.number().min(0).max(1), plasticity: z.number().min(0).max(1), currentActivation: z.number().min(0).max(1) }).strict();
const traitMap = z.record(text, traitVector);
const activationProfile = z.object({
  underlyingOrganization: traitMap,
  stableDispositions: traitMap,
  behavioralDimensions: traitMap,
  presentationStrategy: traitMap,
  voiceStyle: traitMap,
  situationalState: traitMap,
}).strict();
const socialBond = z.object({
  id: text, status, subject: target, object: target,
  relationshipKind: z.enum(["ally", "friend", "collaborator", "mentor", "ward", "rival", "audience", "community_member", "self_relation", "unknown", "custom"]),
  customRelationshipKind: text.optional(), summary: text, trust: z.number().min(0).max(1), tension: z.number().min(0).max(1), intensity: z.number().min(0).max(1).optional(), lastEvidence: anchoredThought.optional(), updatedAt: timestamp, extensions,
}).strict();
const statusRead = z.object({
  id: text, status, target, statusKind: z.enum(["attention", "authority", "risk", "trust", "need", "conflict", "mood", "opportunity", "uncertainty", "custom"]), customStatusKind: text.optional(), summary: text, confidence: z.number().min(0).max(1), intensity: z.number().min(0).max(1).optional(), valence: z.number().min(-1).max(1).optional(), lastEvidence: anchoredThought.optional(), updatedAt: timestamp, extensions,
}).strict();
const doctrineStance = z.object({
  id: text, status, target, stanceKind: z.enum(["aligned", "tension", "rejected", "uncertain", "contextual", "custom"]), customStanceKind: text.optional(), principle: text, summary: text, actionImplication: text, intensity: z.number().min(0).max(1).optional(), updatedAt: timestamp, extensions,
}).strict();
const candidateAction = z.object({
  id: text, status, actionType: z.enum(["speak", "draft", "ask", "propose", "inspect", "notify", "wait", "remember", "handoff", "render", "external_action", "custom"]), customActionType: text.optional(), readiness: z.enum(["draft", "ready", "blocked", "waiting", "expired"]), riskLevel: z.enum(["none", "low", "medium", "high", "severe", "unknown"]), target, deliveryTarget: target.optional(), summary: text, rationale: text.optional(), urgency: z.number().min(0).max(1).optional(), confidence: z.number().min(0).max(1).optional(), constraints: z.array(text).default([]), evidence: z.array(anchoredThought).default([]), createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp.optional(), extensions,
}).strict();

export const gamecultPersonaStateSchema = z.object({
  schemaVersion: z.literal("gamecult.persona_state.v0"),
  provenance: z.object({ sourceSystem: text, sourceDocumentId: text, sourceUpdatedAt: timestamp, exportedAt: timestamp, authority: z.enum(["canonical", "projection", "import"]) }).strict(),
  personaId: text,
  publicName: text,
  publicDescription: z.string(),
  presentation: z.object({ avatarUri: z.string().url().optional(), pronouns: text.optional(), voiceSummary: text, defaultRenderer: z.enum(["text", "chat", "avatar", "voice", "scene", "repo_persona", "custom"]).optional(), customRenderer: text.optional(), homeContext: target.optional(), jurisdiction: text.optional(), publicHandles: z.array(z.object({ system: text, handle: text, uri: z.string().url().optional() }).strict()).default([]) }).strict(),
  privateNotes: z.array(text).default([]),
  values: z.array(z.object({ id: text, label: text, priority: z.number().min(0).max(1), summary: z.string().optional() }).strict()).default([]),
  activationProfile: activationProfile.optional(),
  thoughtMemory: z.object({ shortTerm: z.array(anchoredThought).default([]), memories: z.array(anchoredThought).default([]), incubation: z.array(anchoredThought).default([]) }).strict(),
  agencyPressure: z.object({ pressures: z.array(anchoredThought).default([]) }).strict(),
  candidateActions: z.object({ actions: z.array(candidateAction).default([]) }).strict().optional(),
  voidbotProjection: z.object({ candidateInterventions: z.array(candidateAction).default([]) }).strict().optional(),
  affect: z.object({
    needs: z.array(anchoredThought).default([]), socialBonds: z.array(socialBond).default([]), statusReads: z.array(statusRead).default([]),
    moodDimensions: z.array(z.object({ name: text, value: z.number().min(0).max(1), source: z.string().optional(), updatedAt: timestamp }).strict()).default([]),
    socialBiases: z.array(z.object({ name: text, value: z.number().min(0).max(1), summary: text, behavioralPull: text, updatedAt: timestamp }).strict()).default([]),
    doctrineStances: z.array(doctrineStance).default([]),
  }).strict(),
  updatedAt: timestamp,
}).strict();

export type GamecultPersonaState = z.infer<typeof gamecultPersonaStateSchema>;

export const gamecultPersonaStateDocument = defineDocumentType({
  type: "gamecult.persona_state.v0",
  schemaName: "gamecult.persona_state.v0",
  schema: gamecultPersonaStateSchema,
  global: true,
});

export const gamecultPersonaStateDocumentRegistry = defineDocumentRegistry(gamecultPersonaStateDocument);

export const personaProjectionImportSchema = z.object({
  schemaVersion: z.literal("voidbot.persona_state_projection_import.v1"),
  sourceDocumentId: text,
  claimedSchemaVersion: text,
  authority: z.enum(["projection", "import"]),
  payload: z.record(z.unknown()),
  importedAt: timestamp,
}).strict();

export type PersonaProjectionImport = z.infer<typeof personaProjectionImportSchema>;

export const personaProjectionImportDocument = defineDocumentType({
  type: "voidbot.persona_state_projection_import",
  schemaName: "voidbot.persona_state_projection_import.v1",
  schema: personaProjectionImportSchema,
  global: true,
});

export const personaProjectionImportDocumentRegistry = defineDocumentRegistry(personaProjectionImportDocument);
