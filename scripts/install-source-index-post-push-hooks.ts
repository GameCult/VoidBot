import "dotenv/config";

import { readdir, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "@voidbot/config";

const HOOK_MARKER = "# voidbot-source-index-push-hook";

interface ScriptOptions {
  repos?: string[];
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__source_hook_install__";
  }

  const config = loadConfig();

  if (!config.sourceRepoRoot) {
    throw new Error("SOURCE_REPO_ROOT is not configured.");
  }

  const options = parseArgs(process.argv.slice(2));
  const repoNames =
    options.repos && options.repos.length > 0
      ? options.repos
      : await resolveRepoNames(config.sourceRepoRoot, config.sourceRepoPatterns);

  let installed = 0;
  let updated = 0;
  let backedUp = 0;
  let skipped = 0;

  for (const repoName of repoNames) {
    const repoPath = join(config.sourceRepoRoot, repoName);
    const gitDir = await resolveGitDir(repoPath);

    if (!gitDir) {
      console.log(`Skipping ${repoName}: no .git directory found.`);
      skipped += 1;
      continue;
    }

    const hooksDir = join(gitDir, "hooks");
    const hookPath = join(hooksDir, "pre-push");
    const backupHookPath = join(hooksDir, "pre-push.voidbot.prev");

    await mkdir(hooksDir, { recursive: true });

    let existingContent: string | undefined;

    try {
      existingContent = await readFile(hookPath, "utf8");
    } catch {
      existingContent = undefined;
    }

    if (
      existingContent &&
      !existingContent.includes(HOOK_MARKER) &&
      !(await pathExists(backupHookPath))
    ) {
      await writeFile(backupHookPath, existingContent, "utf8");
      await chmod(backupHookPath, 0o755);
      backedUp += 1;
    } else if (
      existingContent &&
      !existingContent.includes(HOOK_MARKER) &&
      (await pathExists(backupHookPath))
    ) {
      console.log(`Skipping ${repoName}: existing pre-push hook already has a Void backup; not clobbering it.`);
      skipped += 1;
      continue;
    }

    const hookScript = renderHookScript(process.cwd(), repoName);
    await writeFile(hookPath, hookScript, "utf8");
    await chmod(hookPath, 0o755);

    if (existingContent?.includes(HOOK_MARKER)) {
      updated += 1;
      console.log(`Updated pre-push hook for ${repoName}.`);
    } else {
      installed += 1;
      console.log(`Installed pre-push hook for ${repoName}.`);
    }
  }

  console.log(
    [
      `installed=${installed}`,
      `updated=${updated}`,
      `backedUp=${backedUp}`,
      `skipped=${skipped}`,
    ].join(" "),
  );
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if ((argument === "--repo" || argument === "--repos") && argv[index + 1]) {
      options.repos = argv[index + 1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      index += 1;
    }
  }

  return options;
}

async function resolveRepoNames(root: string, patterns: string[]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => patterns.length === 0 || patterns.some((pattern) => matchesPattern(name, pattern)))
    .sort((left, right) => left.localeCompare(right));
}

async function resolveGitDir(repoPath: string): Promise<string | undefined> {
  const dotGitPath = join(repoPath, ".git");

  try {
    const dotGitStats = await stat(dotGitPath);

    if (dotGitStats.isDirectory()) {
      return dotGitPath;
    }

    if (dotGitStats.isFile()) {
      const pointer = await readFile(dotGitPath, "utf8");
      const match = pointer.match(/^gitdir:\s*(.+)$/im);

      if (match?.[1]) {
        return resolve(repoPath, match[1].trim());
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function renderHookScript(voidbotRoot: string, repoName: string): string {
  const normalizedRoot = voidbotRoot.replace(/\\/g, "/");
  const launcherPath = `${normalizedRoot}/scripts/git-post-push-index.mjs`;
  const nodePath = process.execPath.replace(/\\/g, "/");
  const quotedNodePath = escapeForDoubleQuotedShell(nodePath);
  const quotedLauncherPath = escapeForDoubleQuotedShell(launcherPath);
  const quotedRoot = escapeForDoubleQuotedShell(normalizedRoot);
  const quotedRepoName = escapeForDoubleQuotedShell(repoName);

  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "HOOK_DIR=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"",
    "PREV_HOOK=\"$HOOK_DIR/pre-push.voidbot.prev\"",
    "",
    "if [ -x \"$PREV_HOOK\" ]; then",
    "  \"$PREV_HOOK\" \"$@\"",
    "  PREV_STATUS=$?",
    "  if [ \"$PREV_STATUS\" -ne 0 ]; then",
    "    exit \"$PREV_STATUS\"",
    "  fi",
    "fi",
    "",
    `\"${quotedNodePath}\" \"${quotedLauncherPath}\" --voidbot-root \"${quotedRoot}\" --repo-name \"${quotedRepoName}\" >/dev/null 2>&1 || true`,
    "",
    "exit 0",
    "",
  ].join("\n");
}

function escapeForDoubleQuotedShell(value: string): string {
  return value.replace(/(["`$\\])/g, "\\$1");
}

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
