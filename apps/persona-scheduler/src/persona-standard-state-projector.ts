import type { RepoDiscordIdentity } from "@voidbot/core";

export function projectGamecultPersonaState(identity: RepoDiscordIdentity, state: Record<string, unknown>): string {
  const profile = child(state, "profile") ?? child(state, "selfProfile") ?? state;
  const memory = child(state, "memory") ?? child(state, "thoughtMemory");
  const affect = child(state, "affect") ?? child(state, "faceAffect");
  const doctrine = child(state, "doctrine") ?? child(state, "doctrineStances");
  const authority = text(child(state, "provenance"), "authority");
  return [
    `${identity.displayName} is a native VoidBot Persona, not a repo Face.`,
    authority === "canonical"
      ? "Persona Mind is canonical gamecult.persona_state.v0 state loaded from typed CultCache."
      : `Persona state authority is ${authority ?? "unreported"}; treat it as a non-canonical projection.`,
    identity.avatarUrl ? `Public avatar URL: ${identity.avatarUrl}` : undefined,
    identity.avatarPath ? `Local avatar asset: ${identity.avatarPath}` : undefined,
    text(profile, "publicDescription") ?? identity.description,
    list("Private notes", array(profile, "privateNotes")),
    values("Values", array(profile, "values")),
    list("Activation traits", array(profile, "activationTraits")),
    memories("Memories", [...array(memory, "memories"), ...array(memory, "durableMemories")]),
    memories("Short-term residue", array(memory, "shortTerm")),
    memories("Agency pressure", [...array(state, "pressures"), ...array(state, "agencyPressures"), ...array(child(state, "agencyPressure"), "pressures")]),
    memories("Affect needs", array(affect, "needs")),
    memories("Social bonds", array(affect, "socialBonds")),
    memories("Doctrine stances", [...array(state, "doctrineStances"), ...array(doctrine, "stances"), ...array(doctrine, "doctrineStances")]),
  ].filter((line): line is string => Boolean(line?.trim())).join("\n\n");
}

export function projectNativePersonaBody(identity: RepoDiscordIdentity): string { return [`${identity.displayName} is a native VoidBot Persona.`, "Body for this turn: Persona state, avatar, allowed Discord channels, current conversation, and VoidBot's webhook mouth.", "No repo jurisdiction, Bifrost governance digest, source-repo activity, or repo proposal authority is implied by this native Persona category."].join("\n"); }

function child(value: unknown, key: string): Record<string, unknown> | undefined { return record(value) && record(value[key]) ? value[key] as Record<string, unknown> : undefined; }
function text(value: unknown, key: string): string | undefined { const field = record(value) ? value[key] : undefined; return typeof field === "string" && field.trim() ? field.trim() : undefined; }
function array(value: unknown, key: string): unknown[] { const field = record(value) ? value[key] : undefined; return Array.isArray(field) ? field : []; }
function list(title: string, entries: unknown[]): string | undefined { const rendered = entries.map((entry) => typeof entry === "string" ? entry : summarize(entry)).filter((entry): entry is string => Boolean(entry?.trim())).slice(0, 12); return rendered.length > 0 ? [`${title}:`, ...rendered.map((entry) => `- ${entry}`)].join("\n") : undefined; }
function values(title: string, entries: unknown[]): string | undefined { return list(title, entries.map((entry) => record(entry) ? [text(entry, "label") ?? text(entry, "id") ?? text(entry, "name"), text(entry, "summary") ?? text(entry, "description")].filter(Boolean).join(": ") : entry)); }
function memories(title: string, entries: unknown[]): string | undefined { return list(title, entries.map((entry) => record(entry) ? text(entry, "summary") ?? text(entry, "claim") ?? text(entry, "description") ?? text(entry, "text") ?? summarize(entry) : entry)); }
function summarize(value: unknown): string | undefined { if (!record(value)) return undefined; for (const key of ["summary", "claim", "description", "text", "label", "id", "name"]) { const field = text(value, key); if (field) return field; } return undefined; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
