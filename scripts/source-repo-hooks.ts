import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type SourceRepoMatch } from "./source-repo-discovery";

export const HOOK_MARKER = "# voidbot-source-index-push-hook";

export interface SourceHookInstallSummary {
  installed: number;
  updated: number;
  backedUp: number;
  skipped: number;
  messages: string[];
}

export async function installSourceIndexPushHooks(
  voidbotRoot: string,
  repos: SourceRepoMatch[],
): Promise<SourceHookInstallSummary> {
  let installed = 0;
  let updated = 0;
  let backedUp = 0;
  let skipped = 0;
  const messages: string[] = [];

  for (const repo of repos) {
    const hooksDir = join(repo.gitDir, "hooks");
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
      skipped += 1;
      messages.push(
        `Skipping ${repo.repoName}: existing pre-push hook already has a Void backup; not clobbering it.`,
      );
      continue;
    }

    const hookScript = renderHookScript(voidbotRoot, repo.repoName);
    await writeFile(hookPath, hookScript, "utf8");
    await chmod(hookPath, 0o755);

    if (existingContent?.includes(HOOK_MARKER)) {
      updated += 1;
      messages.push(`Updated pre-push hook for ${repo.repoName}.`);
    } else {
      installed += 1;
      messages.push(`Installed pre-push hook for ${repo.repoName}.`);
    }
  }

  return {
    installed,
    updated,
    backedUp,
    skipped,
    messages,
  };
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
