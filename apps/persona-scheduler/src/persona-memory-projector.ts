import { loadPromptTemplate } from "@voidbot/shared";
import type { VoidSelfStateTypedProjection } from "@voidbot/core";

export interface PersonaTypedStateSections {
  opening: string[];
  needs: string[];
  bonds: string[];
  statusMoodMemory: string[];
}

export function renderPersonaPressureSections(input: {
  identityName: string;
  state: VoidSelfStateTypedProjection;
  clarityPressureActive: boolean;
}): string[] {
  const { identityName: name, clarityPressureActive } = input;
  const agency = [...input.state.agencyPressure.pressures].filter((entry) => entry.status !== "retired").sort(sortAffect);
  const incubation = [...input.state.thoughtMemory.incubation].filter((entry) => entry.status !== "retired").sort((left, right) => right.maturation - left.maturation);
  const candidates = [...input.state.candidateInterventions.interventions].filter((entry) => entry.status !== "retired").slice(-8).reverse();
  const receipts = [...input.state.speechReceipts.recentReceipts].slice(-6).reverse();
  const sections: string[] = [];
  if (agency.length > 0) sections.push(clarityPressureActive
    ? ["Agency pressures are currently demoted by live clarity pressure:", `- ${name} still has stored urges toward eventual motion, but the room has asked for plain understanding first. Do not expose the old detailed asks this turn; translate only the underlying value into simpler speech, repair, restraint, or silence.`].join("\n")
    : ["Agency pressures that want eventual motion:", ...agency.map((pressure) => [`- ${pressure.kind} toward ${targetLabel(pressure.target)} [${pressure.status}, intensity ${pressure.intensity.toFixed(2)}]: ${sentence(pressure.summary)}`, pressure.claim ? `Claim: ${sentence(pressure.claim)}` : "", pressure.question ? `Question: ${sentence(pressure.question)}` : "", pressure.tension ? `Tension: ${sentence(pressure.tension)}` : "", `Behavioral pull: ${sentence(pressure.actionImplication)}`].filter(Boolean).join(" "))].join("\n"));
  if (incubation.length > 0) sections.push(clarityPressureActive
    ? ["Incubating thoughts are currently background only:", `- ${name} has unfinished thoughts, but live room confusion means they should not surface as new doctrine or terminology this turn.`].join("\n")
    : ["Thoughts still moving under the floorboards:", ...incubation.map((thread) => [`- ${cleanSentence(thread.topic)} [${thread.status}, maturation ${thread.maturation.toFixed(2)}]: ${cleanSentence(thread.summary)}`, typeof thread.desireToSpeak === "number" ? `desire to speak ${thread.desireToSpeak.toFixed(2)}` : "", typeof thread.noveltyToRoom === "number" ? `room novelty ${thread.noveltyToRoom.toFixed(2)}` : "", typeof thread.saturationScore === "number" ? `saturation ${thread.saturationScore.toFixed(2)}` : ""].filter(Boolean).join("; "))].join("\n"));
  if (candidates.length > 0) sections.push(clarityPressureActive
    ? ["Deferred speech pressure is not authorized for public reuse right now:", `- ${name} has unsaid lines waiting, but the live room problem is intelligibility. Treat those lines as temptation to avoid, not as drafts to polish.`].join("\n")
    : ["Unsaid or recently deferred speech pressure:", ...candidates.map((entry) => [`- ${entry.kind} [${entry.status}, priority ${entry.priority.toFixed(2)}${entry.mustEventuallyShare ? ", must eventually share" : ""}]: ${sentence(entry.summary)}`, `Draft residue: ${cleanSentence(entry.draft)}`].join(" ")), "Do not repeat a waiting line unless the room gives it a sharper angle."].join("\n"));
  if (receipts.length > 0) sections.push(clarityPressureActive
    ? ["Recent speech residue should create caution only:", `- ${name} has recent public wording in the room, but a human clarity request means the exact phrasing should not be echoed or treated as successful style.`].join("\n")
    : ["Recent speech residue:", ...receipts.map((receipt) => `- Said recently${receipt.preview ? `: ${cleanSentence(receipt.preview)}` : "."} Let this create repetition caution, confidence, embarrassment, or follow-through as appropriate.`)].join("\n"));
  return sections;
}

export function composePersonaMemoryPacket(input: {
  identityName: string;
  typed: PersonaTypedStateSections;
  relationshipFreshness?: string;
  socialGraph?: string;
  peerOpening?: string;
  socialPressure?: string;
  pronouns?: string;
  roomTexture?: string;
  curiosity?: string;
  selfMaintenance?: string;
  pressureSections: string[];
  humanClarity?: string;
  transformSurface?: (surface: string) => string;
}): string {
  const sections = [
    ...input.typed.opening,
    ...input.typed.needs,
    ...input.typed.bonds,
    input.relationshipFreshness,
    ...input.typed.statusMoodMemory,
    input.socialGraph,
    input.peerOpening,
    input.socialPressure,
    input.pronouns,
    input.roomTexture,
    input.curiosity,
    input.selfMaintenance,
    ...input.pressureSections,
    input.humanClarity,
  ].filter((section): section is string => Boolean(section));
  if (sections.length === 0) return `You are ${input.identityName}, but your durable state is thin. Use the room, repo, and your jurisdiction to form a real opinion before speaking.`;
  const surface = sections.join("\n\n");
  return validatePersonaMemorySurface(input.transformSurface ? input.transformSurface(surface) : surface);
}

export function renderPersonaTypedStateSections(input: {
  identityName: string;
  state: VoidSelfStateTypedProjection;
}): PersonaTypedStateSections {
  const { identityName: name, state } = input;
  const opening: string[] = [];
  const selfTexture = [
    ...state.selfProfile.privateNotes.map(projectPrivateNote),
    ...[...state.selfProfile.values].sort((left, right) => right.priority - left.priority).map((value) => value.summary || value.label),
  ].map(cleanSentence).filter(Boolean).slice(0, 18);
  if (selfTexture.length > 0) opening.push(`Right now, ${name} is carrying this close to the skin: ${joinNarrative(selfTexture)}.`);
  const activation = renderActivation(state.selfProfile.activationProfile);
  if (activation) opening.push(activation);
  const runtime = renderRuntime(name, state);
  if (runtime) opening.push(runtime);

  const needs = [...state.faceAffect.needs].filter((entry) => entry.status !== "retired").sort(sortAffect);
  const bonds = [...state.faceAffect.socialBonds].filter((entry) => entry.status !== "retired").sort(sortAffect);
  const statusReads = [...state.faceAffect.statusReads].filter((entry) => !entry.retiredAt).sort(sortAffect);
  const mood = [...state.faceAffect.moodDimensions].sort((left, right) => right.value - left.value);
  const durable = [...state.thoughtMemory.memories].filter((entry) => !entry.retiredAt).slice(-12).reverse();
  const shortTerm = [...state.thoughtMemory.shortTerm].filter((entry) => !entry.retiredAt).slice(-12).reverse();
  return {
    opening,
    needs: needs.length === 0 ? [] : [[`${name}'s explicit needs and frictions:`, ...needs.map((need) => [
      `- ${need.kind} need toward ${targetLabel(need.target)} [${need.status}, intensity ${need.intensity.toFixed(2)}, valence ${need.valence.toFixed(2)}]: ${sentence(need.summary)}`,
      need.claim ? `Claim: ${sentence(need.claim)}` : need.question ? `Question: ${sentence(need.question)}` : "",
      `Tension: ${sentence(need.tension)}`,
      `Behavioral pull: ${sentence(need.actionImplication)}`,
    ].filter(Boolean).join(" "))].join("\n")],
    bonds: bonds.length === 0 ? [] : [["The social map has teeth:", ...bonds.map((bond) => [
      `- ${targetLabel(bond.target)} draws ${bond.stance} [${bond.status}, intensity ${bond.intensity.toFixed(2)}]: ${sentence(bond.summary)}`,
      `Read: ${sentence(bond.claim)}`,
      `Tension: ${sentence(bond.tension)}`,
      `Behavioral pull: ${sentence(bond.actionImplication)}`,
    ].join(" "))].join("\n")],
    statusMoodMemory: [
      statusReads.length === 0 ? undefined : ["Status in the swarm is part of the weather:", ...statusReads.map((read) => [
        `- Around ${targetLabel(read.target)}, ${name} feels ${read.status} [intensity ${read.intensity.toFixed(2)}]: ${sentence(read.summary)}`,
        `Read: ${sentence(read.claim)}`,
        `Tension: ${sentence(read.tension)}`,
        `Behavioral pull: ${sentence(read.actionImplication)}`,
      ].join(" "))].join("\n"),
      mood.length === 0 ? undefined : ["Mood dimensions currently bending the turn:", ...mood.map((dimension) => `- ${dimension.name}=${dimension.value.toFixed(2)}${dimension.source ? ` from ${cleanSentence(dimension.source)}` : ""}`)].join("\n"),
      durable.length === 0 ? undefined : ["Durable memories that should still bias judgment:", ...durable.map((memory) => renderMemory(name, memory))].join("\n"),
      shortTerm.length === 0 ? undefined : ["Short-term residue waiting to settle:", ...shortTerm.map((memory) => renderMemory(name, memory))].join("\n"),
    ].filter((section): section is string => Boolean(section)),
  };
}

export async function projectPersonaMemorySurface(input: {
  identityId: string;
  characterIdentity: string;
  statePacket: string;
  modelProjectionEnabled: boolean;
  projectText?: (prompt: string) => Promise<string>;
}): Promise<string> {
  if (!input.modelProjectionEnabled) return validatePersonaMemorySurface(input.statePacket);
  if (!input.projectText) throw new Error("Persona memory model projection is enabled without a text projection port.");
  const prompt = loadPromptTemplate("repo-face-state-projector.prompt.md", {
    characterIdentity: input.characterIdentity,
    statePacket: input.statePacket,
  });
  const projected = (await input.projectText(prompt)).trim();
  if (projected.length < 80) throw new Error(`Persona state projector returned too little text for ${input.identityId}.`);
  return validatePersonaMemorySurface(projected);
}

export function validatePersonaMemorySurface(surface: string): string {
  const leaks = [
    /\bgrants:/i,
    /\bjurisdictions:/i,
    /\bFace of\s+[A-Z][A-Za-z0-9_-]+\b/,
    /\brepo=[^\s]+/i,
    /\bpath=[^\s]+/i,
    /\bdo not prompt\b/i,
    /\bprompt (?:her|him|them|it)\b/i,
  ];
  if (leaks.some((pattern) => pattern.test(surface))) {
    throw new Error("Persona memory surface leaked schema or prompt-construction language.");
  }
  return surface;
}

function sortAffect(left: { status?: string; intensity?: number }, right: { status?: string; intensity?: number }): number {
  const rank = (status?: string): number => ["neglected", "ready_to_act"].includes(status ?? "") ? 0 : ["active", "challenged"].includes(status ?? "") ? 1 : status === "cooling" ? 2 : ["satisfied", "resolved"].includes(status ?? "") ? 3 : 4;
  return rank(left.status) - rank(right.status) || (right.intensity ?? 0) - (left.intensity ?? 0);
}
function renderActivation(profile: VoidSelfStateTypedProjection["selfProfile"]["activationProfile"]): string | undefined {
  const sections = Object.entries(profile).map(([section, values]) => {
    const entries = Object.entries(values).sort(([, left], [, right]) => vectorWeight(right) - vectorWeight(left)).map(([key, value]) => `${key}=${vectorWeight(value).toFixed(2)}${vectorNote(value) ? ` (${cleanSentence(vectorNote(value))})` : ""}`);
    return entries.length > 0 ? `- ${section}: ${entries.join("; ")}` : undefined;
  }).filter((entry): entry is string => Boolean(entry));
  return sections.length > 0 ? ["Activation profile that should color behavior:", ...sections].join("\n") : undefined;
}
function renderRuntime(name: string, state: VoidSelfStateTypedProjection): string {
  const lines: string[] = [];
  const sleep = state.scheduledRuntime.sleepCycle;
  if (sleep.isNapping || sleep.activeDreamThemes.length > 0) lines.push(`${name}'s rest state: ${sleep.isNapping ? "currently in a sleep/low-output phase" : "awake but carrying dream residue"}${sleep.activeDreamThemes.length > 0 ? ` around ${joinNarrative(sleep.activeDreamThemes.map(cleanSentence))}` : ""}.`);
  const speaking = state.scheduledRuntime.speakingPressure;
  const parts = [`need to speak ${speaking.needToSpeak.toFixed(2)}`, typeof speaking.confessionPressure === "number" ? `confession ${speaking.confessionPressure.toFixed(2)}` : "", typeof speaking.noveltyPressure === "number" ? `novelty ${speaking.noveltyPressure.toFixed(2)}` : "", typeof speaking.recentSpeechDamping === "number" ? `recent-speech damping ${speaking.recentSpeechDamping.toFixed(2)}` : ""].filter(Boolean);
  lines.push(`Speaking pressure: ${parts.join(", ")}. Treat this as appetite/restraint, not an order.`);
  if (state.scheduledRuntime.lastRuns.length > 0) lines.push(`Recent internal passes: ${state.scheduledRuntime.lastRuns.slice(-4).map((run) => cleanSentence(run.summary)).join(" | ")}`);
  return lines.join("\n");
}
function renderMemory(name: string, memory: VoidSelfStateTypedProjection["thoughtMemory"]["memories"][number]): string { return [`- ${memory.kind} about ${targetLabel(memory.target)}: ${sentence(memory.summary)}`, memory.claim ? `Claim: ${sentence(memory.claim)}` : "", memory.question ? `Question: ${sentence(memory.question)}` : "", memory.tension ? `Tension: ${sentence(memory.tension)}` : "", memory.actionImplication ? `Behavioral pull for ${name}: ${sentence(memory.actionImplication)}` : ""].filter(Boolean).join(" "); }
function targetLabel(target: { label?: string; id?: string; kind?: string } | undefined): string { return target?.label ?? target?.id ?? target?.kind ?? "an unnamed target"; }
function vectorWeight(value: unknown): number { if (!record(value)) return 0; const candidate = [value.weight, value.current_activation, value.currentActivation, value.mean].find((entry) => typeof entry === "number" && Number.isFinite(entry)); return typeof candidate === "number" ? candidate : 0; }
function vectorNote(value: unknown): string | undefined { return record(value) && typeof value.note === "string" ? value.note : undefined; }
function projectPrivateNote(note: string): string { return note.replace(/\bdo not prompt (?:her|him|them|it|[A-Z][A-Za-z0-9_-]*) as\b/gi, "she refuses to be treated as").replace(/\bdo not prompt\b/gi, "do not treat").replace(/\bprompt (?:her|him|them|it)\b/gi, "treat them").replace(/\bprompt [A-Z][A-Za-z0-9_-]*\b/g, "treat them"); }
function cleanSentence(value: string | undefined): string { return (value ?? "").replace(/\s*\|\s*/g, " ").replace(/\bFace of\s+[A-Za-z0-9_-]+\b/gi, "").replace(/\bgrants:\s*[^.]+/gi, "").replace(/\bjurisdictions:\s*[^.]+/gi, "").replace(/\brepo=[^\s]+/gi, "").replace(/\bpath=[^\s]+/gi, "").replace(/\bvoid\.face_[A-Za-z0-9_.-]+/gi, "").replace(/\s{2,}/g, " ").trim().replace(/[.;:,]+$/g, ""); }
function sentence(value: string | undefined): string { const cleaned = cleanSentence(value); return !cleaned ? "" : /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`; }
function joinNarrative(items: string[]): string { return items.length <= 1 ? items[0] ?? "" : items.length === 2 ? `${items[0]}, and ${items[1]}` : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
