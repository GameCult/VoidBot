import { spawn } from "node:child_process";
import { access, mkdir, open, writeFile, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

const args = parseArgs(process.argv.slice(2));

if (!args.repoName) {
  console.error("Missing required --repo-name argument.");
  process.exit(1);
}

const voidbotRoot = resolve(args.voidbotRoot ?? process.cwd());
loadDotenv({ path: join(voidbotRoot, ".env") });
const storageRoot = resolve(
  voidbotRoot,
  process.env.STORAGE_ROOT && process.env.STORAGE_ROOT.trim().length > 0
    ? process.env.STORAGE_ROOT
    : ".voidbot",
);
const safeRepoName = encodeURIComponent(args.repoName);
const logDir = join(storageRoot, "logs", "source-hooks");
const statusDir = join(storageRoot, "status", "source-hooks");
const logPath = join(logDir, `${safeRepoName}.log`);
const statusPath = join(statusDir, `${safeRepoName}.json`);

if (args.run) {
  await runWorker();
} else {
  await launchDetachedWorker();
}

async function launchDetachedWorker() {
  await ensureDirectories();

  const currentStatus = await readJson(statusPath);

  if (typeof currentStatus?.pid === "number" && isProcessRunning(currentStatus.pid)) {
    await writeStatus({
      ...currentStatus,
      repoName: args.repoName,
      logPath,
      lastSkippedAt: new Date().toISOString(),
      lastSkipReason: "already_running",
    });
    return;
  }

  const logHandle = await open(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      join(voidbotRoot, "scripts", "git-post-push-index.mjs"),
      "--run",
      "--voidbot-root",
      voidbotRoot,
      "--repo-name",
      args.repoName,
    ],
    {
      cwd: voidbotRoot,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
      env: process.env,
    },
  );

  child.unref();
  await logHandle.close();

  await writeStatus({
    state: "running",
    repoName: args.repoName,
    pid: child.pid,
    queuedAt: new Date().toISOString(),
    logPath,
  });
}

async function runWorker() {
  await ensureDirectories();

  const sourceRepoRoot = process.env.SOURCE_REPO_ROOT
    ? resolve(process.env.SOURCE_REPO_ROOT)
    : undefined;
  const repoPath = sourceRepoRoot ? join(sourceRepoRoot, args.repoName) : undefined;
  const startedAt = new Date().toISOString();

  await writeStatus({
    state: "running",
    repoName: args.repoName,
    pid: process.pid,
    startedAt,
    logPath,
    repoPath,
  });

  process.stdout.write(`\n=== source hook run ${startedAt} repo=${args.repoName} ===\n`);

  if (!sourceRepoRoot) {
    const message = "SOURCE_REPO_ROOT is not configured in VoidBot's .env.";
    process.stderr.write(`${message}\n`);
    await writeStatus({
      state: "failed",
      repoName: args.repoName,
      pid: process.pid,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: 1,
      logPath,
      error: message,
    });
    process.exit(1);
  }

  if (!(await pathExists(repoPath))) {
    const message = `Configured repo path does not exist: ${repoPath}`;
    process.stderr.write(`${message}\n`);
    await writeStatus({
      state: "failed",
      repoName: args.repoName,
      pid: process.pid,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: 1,
      logPath,
      repoPath,
      error: message,
    });
    process.exit(1);
  }

  try {
    const child =
      process.platform === "win32"
        ? spawn(
            "cmd.exe",
            ["/d", "/s", "/c", "npm.cmd", "run", "rag:index-sources", "--", "--repo", args.repoName],
            {
              cwd: voidbotRoot,
              windowsHide: true,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            },
          )
        : spawn("npm", ["run", "rag:index-sources", "--", "--repo", args.repoName], {
            cwd: voidbotRoot,
            windowsHide: true,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    const exitCode = await new Promise((resolveExit, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolveExit(code ?? 1));
    });

    await writeStatus({
      state: exitCode === 0 ? "completed" : "failed",
      repoName: args.repoName,
      pid: process.pid,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode,
      logPath,
      repoPath,
    });

    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    await writeStatus({
      state: "failed",
      repoName: args.repoName,
      pid: process.pid,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: 1,
      logPath,
      repoPath,
      error: message,
    });
    process.exit(1);
  }
}

async function ensureDirectories() {
  await mkdir(logDir, { recursive: true });
  await mkdir(statusDir, { recursive: true });
}

async function writeStatus(status) {
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function readJson(path) {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const parsed = {
    run: false,
    voidbotRoot: undefined,
    repoName: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--run") {
      parsed.run = true;
      continue;
    }

    if (argument === "--voidbot-root" && argv[index + 1]) {
      parsed.voidbotRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--repo-name" && argv[index + 1]) {
      parsed.repoName = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}
