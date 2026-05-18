import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const identityId = requireArg("identity-id");
const repoPath = resolve(requireArg("repo"));
const epiphanyAgentRoot = resolve(requireArg("epiphany-agent-root"));
const artifactDir = resolve(requireArg("artifact-dir"));
const stateDir = resolve(requireArg("state-dir"));
const statusPath = resolve(requireArg("status-path"));
const logPath = resolve(requireArg("log-path"));
const mode = args.mode ?? "plan";
const executor = args.executor ?? "codex-exec";

await main();

async function main() {
  await mkdir(artifactDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(dirname(statusPath), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  const startedAt = new Date().toISOString();
  await writeStatus({
    status: "running",
    identityId,
    repoPath,
    artifactDir,
    logPath,
    startedAt,
    updatedAt: startedAt,
  });

  const log = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
  try {
    log.write(`[${startedAt}] starting repo Face birth for ${identityId}\n`);
    const scoutDir = resolve(artifactDir, "terrain");
    const runnerDir = resolve(artifactDir, "runner");
    await mkdir(scoutDir, { recursive: true });
    await mkdir(runnerDir, { recursive: true });

    await runCommand(
      "cargo",
      [
        "run",
        "--quiet",
        "--bin",
        "epiphany-repo-personality",
        "--",
        "scout",
        "--root",
        repoPath,
        "--artifact-dir",
        scoutDir,
      ],
      resolve(epiphanyAgentRoot, "epiphany-core"),
      log,
    );

    await runCommand(
      "cargo",
      [
        "run",
        "--quiet",
        "--bin",
        "epiphany-repo-birth-runner",
        "--",
        "--repo",
        repoPath,
        "--baseline",
        resolve(scoutDir, "baseline.msgpack"),
        "--artifact-dir",
        runnerDir,
        "--init-store",
        resolve(stateDir, "repo-initialization.msgpack"),
        "--agent-store",
        resolve(stateDir, "agents.msgpack"),
        "--heartbeat-store",
        resolve(stateDir, "agent-heartbeats.msgpack"),
        "--runtime-store",
        resolve(stateDir, "runtime-spine.msgpack"),
        "--mode",
        mode,
        "--executor",
        executor,
      ],
      resolve(epiphanyAgentRoot, "epiphany-core"),
      log,
    );

    const completedAt = new Date().toISOString();
    await writeStatus({
      status: "completed",
      identityId,
      repoPath,
      artifactDir,
      scoutDir,
      runnerDir,
      summaryPath: resolve(runnerDir, "birth-runner-summary.json"),
      logPath,
      startedAt,
      completedAt,
      updatedAt: completedAt,
    });
    log.write(`[${completedAt}] completed repo Face birth for ${identityId}\n`);
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await writeStatus({
      status: "failed",
      identityId,
      repoPath,
      artifactDir,
      logPath,
      error: message,
      startedAt,
      failedAt,
      updatedAt: failedAt,
    });
    log.write(`[${failedAt}] failed repo Face birth for ${identityId}: ${message}\n`);
    process.exitCode = 1;
  } finally {
    log.end();
  }
}

async function runCommand(command, commandArgs, cwd, log) {
  log.write(`\n> ${command} ${commandArgs.join(" ")}\n`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => log.write(chunk));
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
}

async function writeStatus(payload) {
  await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requireArg(name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}
