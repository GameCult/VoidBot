import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  getRepoFaceSourceRepoName,
  resolveRepoFaceStatePath,
  type RepoDiscordIdentity,
} from "@voidbot/core";

export type RepoActivityObservation =
  | { status: "unconfigured" }
  | { status: "ok"; sourceRepoName: string; digest: string }
  | { status: "unavailable"; sourceRepoName: string; detail?: string }
  | { status: "malformed"; sourceRepoName: string; raw: string };

interface ActivityProcessResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export function readRepoActivity(input: {
  identity: RepoDiscordIdentity;
  storageRoot: string;
  cwd?: string;
  runExporter?: (scriptPath: string, args: string[], cwd: string) => ActivityProcessResult;
}): RepoActivityObservation {
  const sourceRepoName = getRepoFaceSourceRepoName(input.identity);
  if (!sourceRepoName) return { status: "unconfigured" };
  const cwd = input.cwd ?? process.cwd();
  const scriptPath = resolve(cwd, "scripts", "export-recent-repo-activity.mjs");
  const args = [
    "--repos", sourceRepoName,
    "--state-path", resolveRepoFaceStatePath(input.identity, input.storageRoot),
    "--read-only",
    "--hours", "96",
    "--max-commits", "5",
  ];
  const result = input.runExporter
    ? input.runExporter(scriptPath, args, cwd)
    : runExporter(scriptPath, args, cwd);
  const stdout = result.stdout ?? "";
  if (result.status !== 0) {
    const detail = `${stdout}\n${result.stderr ?? ""}`.trim().slice(-600);
    return { status: "unavailable", sourceRepoName, ...(detail ? { detail } : {}) };
  }
  try {
    const parsed = JSON.parse(stdout) as { digest?: unknown };
    return {
      status: "ok",
      sourceRepoName,
      digest: typeof parsed.digest === "string" ? parsed.digest.trim() : "",
    };
  } catch {
    return { status: "malformed", sourceRepoName, raw: stdout.slice(0, 500) };
  }
}

function runExporter(scriptPath: string, args: string[], cwd: string): ActivityProcessResult {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
