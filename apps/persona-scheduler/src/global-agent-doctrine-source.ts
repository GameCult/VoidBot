import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type GlobalAgentDoctrineObservation =
  | { status: "ok"; path: string; doctrine: string; attemptedPaths: string[] }
  | { status: "unavailable"; attemptedPaths: string[]; errors: string[] };

export async function readGlobalAgentDoctrine(input: {
  codexHome?: string;
  userProfile?: string;
  homeDirectory?: string;
  readText?: (path: string) => Promise<string>;
} = {}): Promise<GlobalAgentDoctrineObservation> {
  const attemptedPaths = [...new Set([
    input.codexHome ? resolve(input.codexHome, "AGENTS.md") : undefined,
    input.userProfile ? resolve(input.userProfile, ".codex", "AGENTS.md") : undefined,
    resolve(input.homeDirectory ?? homedir(), ".codex", "AGENTS.md"),
  ].filter((value): value is string => Boolean(value?.trim())))];
  const errors: string[] = [];
  const readText = input.readText ?? ((path) => readFile(path, "utf8"));
  for (const path of attemptedPaths) {
    try {
      const doctrine = (await readText(path)).trim();
      if (doctrine) return { status: "ok", path, doctrine, attemptedPaths };
      errors.push(`${path}: empty file`);
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { status: "unavailable", attemptedPaths, errors };
}
