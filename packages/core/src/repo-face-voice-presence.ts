import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface RepoFaceVoicePresenceSnapshot {
  schemaVersion: "voidbot.repo_face_voice_presence.v1";
  channelId: string;
  observedAt: string;
  humanListenerCount: number;
  botListenerCount: number;
}

export async function writeRepoFaceVoicePresenceSnapshot(
  path: string,
  snapshot: RepoFaceVoicePresenceSnapshot,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export async function loadRepoFaceVoicePresenceSnapshot(
  path: string,
): Promise<RepoFaceVoicePresenceSnapshot | undefined> {
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!content) {
    return undefined;
  }
  const parsed = JSON.parse(content) as Partial<RepoFaceVoicePresenceSnapshot>;
  if (
    parsed.schemaVersion !== "voidbot.repo_face_voice_presence.v1" ||
    typeof parsed.channelId !== "string" ||
    typeof parsed.observedAt !== "string" ||
    typeof parsed.humanListenerCount !== "number"
  ) {
    return undefined;
  }
  return {
    schemaVersion: "voidbot.repo_face_voice_presence.v1",
    channelId: parsed.channelId,
    observedAt: parsed.observedAt,
    humanListenerCount: parsed.humanListenerCount,
    botListenerCount: typeof parsed.botListenerCount === "number" ? parsed.botListenerCount : 0,
  };
}

export function hasFreshHumanRepoFaceVoiceListener(input: {
  snapshot: RepoFaceVoicePresenceSnapshot | undefined;
  channelId: string | undefined;
  now?: Date;
  maxAgeMs?: number;
}): boolean {
  if (!input.snapshot || !input.channelId || input.snapshot.channelId !== input.channelId) {
    return false;
  }
  if (input.snapshot.humanListenerCount <= 0) {
    return false;
  }
  const observedAt = Date.parse(input.snapshot.observedAt);
  if (!Number.isFinite(observedAt)) {
    return false;
  }
  const nowMs = (input.now ?? new Date()).getTime();
  return nowMs - observedAt <= (input.maxAgeMs ?? 30_000);
}
