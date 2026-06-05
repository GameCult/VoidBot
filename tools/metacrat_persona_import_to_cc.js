const path = require("node:path");

const { CultCache, SingleFileMessagePackBackingStore } = require("cultcache-ts");
const core = require("../packages/core/dist/index.js");

const SOURCE_PATH = path.resolve("notes/personas/metacrat.persona_state.import.json");
const TARGET_PATH = path.resolve("state/personas/metacrat.cc");

function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, compact(child)]),
  );
}

function readImport() {
  delete require.cache[SOURCE_PATH];
  return require(SOURCE_PATH);
}

function timestampOf(doc) {
  return doc.updatedAt || doc.provenance?.exportedAt || new Date().toISOString();
}

function activationCategory(input = {}) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      {
        mean: value.mean,
        plasticity: value.plasticity,
        current_activation: value.currentActivation ?? value.current_activation ?? value.mean,
      },
    ]),
  );
}

function targetOf(target = {}) {
  const allowed = new Set(["archive", "lore", "person", "repo", "room", "self", "system"]);
  const kind = allowed.has(target.kind)
    ? target.kind
    : target.kind === "project"
      ? "repo"
      : target.kind === "community"
        ? "room"
        : "system";
  return compact({
    kind,
    id: String(target.id || "unknown-target"),
    label: target.label,
  });
}

function anchorRefs(entry = {}) {
  return (entry.extensions?.anchors || []).map((ref) => ({ ref: String(ref) }));
}

function memoryKind(entry) {
  const tags = new Set(entry.tags || []);
  if (tags.has("interaction") || tags.has("repair") || tags.has("support")) {
    return "room_observation";
  }
  if (
    tags.has("persona") ||
    tags.has("governance") ||
    tags.has("agents") ||
    tags.has("consent") ||
    tags.has("memory-standard")
  ) {
    return "identity_seam";
  }
  if (tags.has("method")) {
    return "distilled_seam";
  }
  return "project_seam";
}

function memoryOf(entry) {
  return compact({
    memoryId: entry.id,
    kind: memoryKind(entry),
    target: targetOf(entry.target),
    summary: entry.summary,
    claim: entry.claim,
    question: entry.question,
    tension: entry.tension,
    actionImplication: entry.actionImplication,
    anchorRefs: anchorRefs(entry),
    evidenceRefs: [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags || [],
  });
}

function incubationOf(entry) {
  return compact({
    threadId: entry.id,
    target: targetOf(entry.target),
    topic: entry.summary,
    summary: entry.question || entry.summary,
    supportMemoryIds: entry.supportMemoryIds || [],
    anchorRefs: anchorRefs(entry),
    evidenceRefs: [],
    maturation: entry.maturation ?? 0.35,
    status: entry.status || "active",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function pressureOf(entry) {
  return compact({
    pressureId: entry.id,
    kind: entry.kind || "active_tension",
    status: entry.status || "active",
    target: targetOf(entry.target),
    summary: entry.summary,
    claim: entry.claim,
    question: entry.question,
    tension: entry.tension,
    actionImplication: entry.actionImplication,
    intensity: entry.intensity ?? 0.5,
    anchorRefs: anchorRefs(entry),
    evidenceRefs: [],
    sourceMemoryIds: entry.sourceMemoryIds || [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags || [],
  });
}

function candidateOf(entry) {
  return compact({
    interventionId: entry.id,
    kind: "identity_crystallization",
    status: "deferred",
    target: targetOf(entry.target),
    summary: entry.summary,
    draft: entry.rationale || entry.summary,
    priority: entry.urgency ?? 0.5,
    mustEventuallyShare: false,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: [
      "candidate-action",
      ...(entry.constraints || []).map((constraint) => `constraint:${constraint.slice(0, 40)}`),
    ],
  });
}

function affectNeedOf(entry) {
  return compact({
    needId: entry.id,
    kind: entry.kind || "recognition",
    status: entry.status || "active",
    target: targetOf(entry.target),
    summary: entry.summary,
    claim: entry.claim,
    question: entry.question,
    tension: entry.tension,
    actionImplication: entry.actionImplication,
    intensity: entry.intensity ?? 0.5,
    valence: entry.valence ?? 0,
    anchorRefs: anchorRefs(entry),
    evidenceRefs: [],
    sourceMemoryIds: entry.sourceMemoryIds || [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags || [],
  });
}

function socialBondOf(entry) {
  const lastEvidence = entry.lastEvidence || {};
  const stanceAliases = {
    attachment: "attachment",
    respect: "respect",
    trust: "trust",
    protectiveness: "protectiveness",
    fondness: "fondness",
    collaborator: "trust",
    friend: "attachment",
    mentor: "protectiveness",
  };
  const rawStance = entry.stance || entry.extensions?.stance || entry.relationshipKind;
  return compact({
    bondId: entry.id || entry.bondId,
    stance: stanceAliases[rawStance] || "respect",
    status: entry.status || "active",
    target: targetOf(entry.target || entry.object),
    summary: entry.summary,
    claim: entry.claim || lastEvidence.claim || entry.summary,
    tension:
      typeof entry.tension === "string"
        ? entry.tension
        : lastEvidence.tension || "Relationship memory needs periodic review as the archive expands.",
    actionImplication:
      entry.actionImplication || lastEvidence.actionImplication || "Preserve the relationship lesson when acting in this domain.",
    intensity: entry.intensity ?? 0.5,
    anchorRefs: anchorRefs(entry.extensions ? entry : lastEvidence),
    evidenceRefs: [],
    createdAt: entry.createdAt || timestampOf({}),
    updatedAt: entry.updatedAt || timestampOf({}),
    tags: entry.tags || entry.extensions?.tags || [],
  });
}

function statusReadOf(entry) {
  const lastEvidence = entry.lastEvidence || {};
  const allowed = new Set([
    "favored",
    "neglected",
    "pampered",
    "bypassed",
    "blocked",
    "challenged",
    "ignored",
    "consulted",
    "threatened",
    "admired",
  ]);
  const rawStatus = entry.extensions?.localStatus || entry.status || entry.statusKind || "challenged";
  return compact({
    readId: entry.id || entry.readId,
    status: allowed.has(rawStatus) ? rawStatus : "challenged",
    target: targetOf(entry.target),
    summary: entry.summary,
    claim: entry.claim || lastEvidence.claim || entry.summary,
    tension: entry.tension || lastEvidence.tension || "Status read may be provisional and source-bound.",
    actionImplication:
      entry.actionImplication || lastEvidence.actionImplication || "Use this read as a prompt for inspection, not as final truth.",
    intensity: entry.intensity ?? 0.5,
    anchorRefs: anchorRefs(entry.extensions ? entry : lastEvidence),
    evidenceRefs: [],
    createdAt: entry.createdAt || timestampOf({}),
    updatedAt: entry.updatedAt || timestampOf({}),
    tags: entry.tags || entry.extensions?.tags || [],
  });
}

function doctrineStanceOf(entry) {
  return compact({
    stanceId: entry.id || entry.stanceId,
    doctrine: entry.doctrine || entry.extensions?.doctrine || entry.stanceKind || "doctrine",
    status: entry.status || "active",
    target: targetOf(entry.target),
    summary: entry.summary,
    claim: entry.claim || entry.principle,
    question: entry.question,
    tension: entry.tension || entry.extensions?.tension || "Doctrine must remain tied to live substrate and future action.",
    actionImplication: entry.actionImplication,
    intensity: entry.intensity ?? 0.5,
    valence: entry.valence ?? entry.extensions?.valence ?? 0,
    anchorRefs: anchorRefs(entry),
    evidenceRefs: [],
    sourceMemoryIds: entry.sourceMemoryIds || [],
    createdAt: entry.createdAt || timestampOf({}),
    updatedAt: entry.updatedAt,
    tags: entry.tags || entry.extensions?.tags || [],
  });
}

function socialBiasOf(entry) {
  const aliases = {
    steelman_before_rebuke: "trust_baseline",
    repair_after_overheat: "grievance_retention",
    invite_participation: "trust_baseline",
  };
  return {
    ...entry,
    name: aliases[entry.name] || entry.name,
  };
}

async function main() {
  const doc = readImport();
  const updatedAt = timestampOf(doc);
  const state = core.createEmptyVoidSelfState({
    identity: {
      agentId: doc.personaId,
      publicName: doc.publicName,
      publicDescription: doc.publicDescription,
    },
  });

  state.selfProfile.publicDescription = doc.publicDescription;
  state.selfProfile.privateNotes = doc.privateNotes || [];
  state.selfProfile.values = doc.values || [];
  state.selfProfile.activationProfile = {
    underlyingOrganization: activationCategory(doc.activationProfile?.underlyingOrganization),
    stableDispositions: activationCategory(doc.activationProfile?.stableDispositions),
    behavioralDimensions: activationCategory(doc.activationProfile?.behavioralDimensions),
    presentationStrategy: activationCategory(doc.activationProfile?.presentationStrategy),
    voiceStyle: activationCategory(doc.activationProfile?.voiceStyle),
    situationalState: activationCategory(doc.activationProfile?.situationalState),
  };
  state.selfProfile.updatedAt = updatedAt;

  state.thoughtMemory.shortTerm = (doc.thoughtMemory?.shortTerm || []).map(memoryOf);
  state.thoughtMemory.memories = (doc.thoughtMemory?.memories || []).map(memoryOf);
  state.thoughtMemory.incubation = (doc.thoughtMemory?.incubation || []).map(incubationOf);
  state.thoughtMemory.updatedAt = updatedAt;

  state.agencyPressure.pressures = (doc.agencyPressure?.pressures || []).map(pressureOf);
  state.agencyPressure.updatedAt = updatedAt;

  state.candidateInterventions.interventions = (doc.candidateActions?.actions || []).map(candidateOf);
  state.candidateInterventions.updatedAt = updatedAt;

  state.personaAffect.needs = (doc.affect?.needs || []).map(affectNeedOf);
  state.personaAffect.socialBonds = (doc.affect?.socialBonds || []).map(socialBondOf);
  state.personaAffect.statusReads = (doc.affect?.statusReads || []).map(statusReadOf);
  state.personaAffect.moodDimensions = doc.affect?.moodDimensions || [];
  state.personaAffect.socialBiases = (doc.affect?.socialBiases || []).map(socialBiasOf);
  state.personaAffect.doctrineStances = (doc.affect?.doctrineStances || []).map(doctrineStanceOf);
  state.personaAffect.updatedAt = updatedAt;

  const cache = CultCache.builder()
    .withRegistry(core.voidSelfStateDocumentRegistry)
    .withGenericStore(new SingleFileMessagePackBackingStore(TARGET_PATH))
    .build();

  await cache.putGlobal(core.voidSelfProfileDocument, state.selfProfile);
  await cache.putGlobal(core.voidModerationCursorDocument, state.moderationCursor);
  await cache.putGlobal(core.voidSpeechReceiptsDocument, state.speechReceipts);
  await cache.putGlobal(core.voidThoughtMemoryDocument, state.thoughtMemory);
  await cache.putGlobal(core.voidScheduledRuntimeDocument, state.scheduledRuntime);
  await cache.putGlobal(core.voidAgencyPressureDocument, state.agencyPressure);
  await cache.putGlobal(core.voidCandidateInterventionsDocument, state.candidateInterventions);
  await cache.putGlobal(core.voidPersonaAffectDocument, state.personaAffect);

  console.log(JSON.stringify({
    targetPath: TARGET_PATH,
    values: state.selfProfile.values.length,
    memories: state.thoughtMemory.memories.length,
    shortTerm: state.thoughtMemory.shortTerm.length,
    incubation: state.thoughtMemory.incubation.length,
    pressures: state.agencyPressure.pressures.length,
    candidates: state.candidateInterventions.interventions.length,
    affectNeeds: state.personaAffect.needs.length,
    socialBonds: state.personaAffect.socialBonds.length,
    statusReads: state.personaAffect.statusReads.length,
    doctrineStances: state.personaAffect.doctrineStances.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
