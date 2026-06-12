import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface RepoFaceVoiceOutboxEntry {
  schemaVersion: "voidbot.repo_face_voice_outbox.v1";
  id: string;
  createdAt: string;
  identityId: string;
  displayName: string;
  repoName: string;
  textChannelId: string;
  textMessageId: string;
  replyToMessageId?: string;
  contentPreview: string;
  weksaRequestId?: string;
  weksaReceiptArtifact?: string;
  audioPath: string;
  audioBytes?: number;
}

export async function appendRepoFaceVoiceOutboxEntry(
  outboxPath: string,
  entry: RepoFaceVoiceOutboxEntry,
): Promise<void> {
  await mkdir(dirname(outboxPath), { recursive: true });
  await appendFile(outboxPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function loadRepoFaceVoiceOutboxEntries(
  outboxPath: string,
): Promise<RepoFaceVoiceOutboxEntry[]> {
  const content = await readFile(outboxPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as RepoFaceVoiceOutboxEntry;
        return parsed.schemaVersion === "voidbot.repo_face_voice_outbox.v1" &&
          typeof parsed.id === "string" &&
          typeof parsed.audioPath === "string"
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });
}

export async function appendRepoFaceVoicePlayedEntry(
  playedPath: string,
  entry: RepoFaceVoiceOutboxEntry,
): Promise<void> {
  await mkdir(dirname(playedPath), { recursive: true });
  await appendFile(
    playedPath,
    `${JSON.stringify({
      schemaVersion: "voidbot.repo_face_voice_played.v1",
      id: entry.id,
      playedAt: new Date().toISOString(),
      identityId: entry.identityId,
      textMessageId: entry.textMessageId,
      audioPath: entry.audioPath,
    })}\n`,
    "utf8",
  );
}

export async function loadRepoFaceVoicePlayedIds(playedPath: string): Promise<Set<string>> {
  const content = await readFile(playedPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const ids = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { id?: string };
      if (typeof parsed.id === "string") {
        ids.add(parsed.id);
      }
    } catch {
      continue;
    }
  }
  return ids;
}

export function resolveWeksaArtifactPath(weksaRepoRoot: string, artifactPath: string | undefined): string | undefined {
  if (!artifactPath) {
    return undefined;
  }
  return resolve(weksaRepoRoot, artifactPath);
}
