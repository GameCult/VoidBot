import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type PortablePersonaStateObservation =
  | { status: "ok"; statePath: string; state: Record<string, unknown>; schemaVersion: "gamecult.persona_state.v0" }
  | { status: "missing" | "malformed" | "unsupported"; statePath: string; reason: string };

export async function readPortablePersonaState(path: string): Promise<PortablePersonaStateObservation> {
  const statePath = resolve(path);
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(stripBom(raw)) as unknown;
    if (!record(parsed)) return { status: "malformed", statePath, reason: "Portable Persona state root is not an object." };
    if (parsed.schemaVersion !== "gamecult.persona_state.v0") return { status: "unsupported", statePath, reason: `Unsupported portable Persona schema ${String(parsed.schemaVersion ?? "missing")}.` };
    return { status: "ok", statePath, state: parsed, schemaVersion: "gamecult.persona_state.v0" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", statePath, reason: "Portable Persona state file does not exist." };
    return { status: "malformed", statePath, reason: error instanceof Error ? error.message : String(error) };
  }
}

function stripBom(value: string): string { return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
