import { stat } from "node:fs/promises";

export async function readVoidModerationActivity(input: {
  lockPath: string;
  observedAt?: Date;
  recentWithinMs?: number;
}): Promise<{ active: boolean; lockPath: string; ageMs?: number }> {
  try {
    const info = await stat(input.lockPath);
    const ageMs = (input.observedAt ?? new Date()).getTime() - info.mtimeMs;
    return { active: ageMs >= 0 && ageMs < (input.recentWithinMs ?? 20 * 60_000), lockPath: input.lockPath, ageMs };
  } catch {
    return { active: false, lockPath: input.lockPath };
  }
}
