import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { RepoDiscordIdentity } from "./repo-discord-identities";

export interface RepoFaceInitializationOptions {
  identity: RepoDiscordIdentity;
  storageRoot: string;
  sourceRepoRoot?: string;
  epiphanyAgentRoot?: string;
  workspaceRoot?: string;
  birthMode?: "plan" | "run";
  birthExecutor?: "codex-exec" | "openai-runtime";
}

export interface RepoFaceInitializationResult {
  initialized: boolean;
  repoPath?: string;
  repoVoidbotRoot?: string;
  identityPath?: string;
  birthStatusPath?: string;
  birthLogPath?: string;
  birthPid?: number;
  skippedReason?: string;
}

export async function ensureRepoFaceInitialized(
  options: RepoFaceInitializationOptions,
): Promise<RepoFaceInitializationResult> {
  const repoPath = resolveRepoPath(options);

  if (!repoPath) {
    return {
      initialized: false,
      skippedReason: "repo_path_unresolved",
    };
  }

  const repoVoidbotRoot = resolve(repoPath, ".voidbot");
  const identityPath = resolve(repoVoidbotRoot, "voice", "identity.json");
  const birthStatusPath = resolve(repoVoidbotRoot, "birth", "voidbot-face-birth.json");
  const birthLogPath = resolve(repoVoidbotRoot, "logs", "voidbot-face-birth.log");

  await mkdir(resolve(repoVoidbotRoot, "voice"), { recursive: true });
  await mkdir(resolve(repoVoidbotRoot, "state"), { recursive: true });
  await mkdir(resolve(repoVoidbotRoot, "birth"), { recursive: true });
  await mkdir(resolve(repoVoidbotRoot, "logs"), { recursive: true });
  await writeRepoFaceIdentity(options.identity, repoPath, identityPath);
  await writeReadmeIfMissing(
    resolve(repoVoidbotRoot, "voice", "README.md"),
    renderVoiceReadme(options.identity),
  );
  await writeReadmeIfMissing(
    resolve(repoVoidbotRoot, "state", "README.md"),
    renderStateReadme(options.identity),
  );

  if (existsSync(resolve(repoVoidbotRoot, "birth", "birth-runner-summary.json"))) {
    return {
      initialized: true,
      repoPath,
      repoVoidbotRoot,
      identityPath,
      birthStatusPath,
      birthLogPath,
      skippedReason: "birth_summary_exists",
    };
  }

  if (await isBirthAlreadyRunning(birthStatusPath)) {
    return {
      initialized: true,
      repoPath,
      repoVoidbotRoot,
      identityPath,
      birthStatusPath,
      birthLogPath,
      skippedReason: "birth_already_running",
    };
  }

  const epiphanyAgentRoot = resolve(
    options.epiphanyAgentRoot ?? "E:/Projects/EpiphanyAgent",
  );

  if (!existsSync(resolve(epiphanyAgentRoot, "epiphany-core", "Cargo.toml"))) {
    await writeStatus(birthStatusPath, {
      status: "skipped",
      reason: "epiphany_agent_root_missing",
      epiphanyAgentRoot,
      updatedAt: new Date().toISOString(),
    });
    return {
      initialized: true,
      repoPath,
      repoVoidbotRoot,
      identityPath,
      birthStatusPath,
      birthLogPath,
      skippedReason: "epiphany_agent_root_missing",
    };
  }

  const scriptPath = resolve(
    options.workspaceRoot ?? process.cwd(),
    "scripts",
    "run-repo-face-birth.mjs",
  );
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      "--identity-id",
      options.identity.id,
      "--repo",
      repoPath,
      "--epiphany-agent-root",
      epiphanyAgentRoot,
      "--artifact-dir",
      resolve(repoVoidbotRoot, "birth"),
      "--state-dir",
      resolve(repoVoidbotRoot, "state"),
      "--status-path",
      birthStatusPath,
      "--log-path",
      birthLogPath,
      "--mode",
      options.birthMode ?? "plan",
      "--executor",
      options.birthExecutor ?? "codex-exec",
    ],
    {
      cwd: options.workspaceRoot ?? process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  await writeStatus(birthStatusPath, {
    status: "started",
    identityId: options.identity.id,
    repoPath,
    pid: child.pid ?? null,
    logPath: birthLogPath,
    updatedAt: new Date().toISOString(),
  });

  return {
    initialized: true,
    repoPath,
    repoVoidbotRoot,
    identityPath,
    birthStatusPath,
    birthLogPath,
    birthPid: child.pid,
  };
}

function resolveRepoPath(options: RepoFaceInitializationOptions): string | undefined {
  const candidates = [
    options.identity.repoPath,
    options.sourceRepoRoot ? resolve(options.sourceRepoRoot, options.identity.repoName) : undefined,
    resolve("E:/Projects", options.identity.repoName),
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

  return candidates.map((entry) => resolve(entry)).find((entry) => existsSync(entry));
}

async function writeRepoFaceIdentity(
  identity: RepoDiscordIdentity,
  repoPath: string,
  identityPath: string,
): Promise<void> {
  const existing = await readExistingIdentity(identityPath);
  await writeFile(
    identityPath,
    `${JSON.stringify(
      {
        ...existing,
        schemaVersion: "voidbot.repo_face_identity.v0",
        identityId: identity.id,
        repoName: identity.repoName,
        displayName: identity.displayName,
        roleId: identity.roleId ?? null,
        avatarUrl: identity.avatarUrl ?? null,
        repoPath,
        createdOrRefreshedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function readExistingIdentity(identityPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(identityPath, "utf8"))) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function writeReadmeIfMissing(path: string, content: string): Promise<void> {
  if (existsSync(path)) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function isBirthAlreadyRunning(statusPath: string): Promise<boolean> {
  try {
    const raw = await readFile(statusPath, "utf8");
    const parsed = JSON.parse(stripLeadingBom(raw)) as { status?: string };
    return parsed.status === "started" || parsed.status === "running";
  } catch {
    return false;
  }
}

async function writeStatus(path: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function renderVoiceReadme(identity: RepoDiscordIdentity): string {
  return [
    "# Repo Face Voice",
    "",
    `This folder belongs to the Discord-facing Face for \`${identity.displayName}\`.`,
    "Discord roles address the Face; VoidBot's webhook persona pipe is the mouth.",
    "",
  ].join("\n");
}

function renderStateReadme(identity: RepoDiscordIdentity): string {
  return [
    "# Repo Face State",
    "",
    `This folder stores birth and continuity state for \`${identity.displayName}\`.`,
    "Do not treat these files as arbitrary editable projections. Persistent memory should cross typed operation boundaries.",
    "",
  ].join("\n");
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
