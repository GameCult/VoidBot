import { loadPromptTemplate } from "@voidbot/shared";

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
