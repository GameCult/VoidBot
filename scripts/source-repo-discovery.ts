import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface SourceRepoMatch {
  repoName: string;
  repoPath: string;
  gitDir: string;
}

export async function discoverSourceRepos(
  root: string,
  patterns: string[],
): Promise<SourceRepoMatch[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const repoMatches: SourceRepoMatch[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (patterns.length > 0 && !patterns.some((pattern) => matchesPattern(entry.name, pattern))) {
      continue;
    }

    const repoPath = join(root, entry.name);
    const gitDir = await resolveGitDir(repoPath);

    if (!gitDir) {
      continue;
    }

    repoMatches.push({
      repoName: entry.name,
      repoPath,
      gitDir,
    });
  }

  repoMatches.sort((left, right) => left.repoName.localeCompare(right.repoName));
  return repoMatches;
}

export function selectSourceRepos(
  availableRepos: SourceRepoMatch[],
  requestedRepoNames?: string[],
): SourceRepoMatch[] {
  if (!requestedRepoNames || requestedRepoNames.length === 0) {
    return availableRepos;
  }

  const lookup = new Map(
    availableRepos.map((repo) => [repo.repoName.toLowerCase(), repo] as const),
  );
  const selectedRepos: SourceRepoMatch[] = [];
  const missingRepoNames: string[] = [];

  for (const requestedRepoName of requestedRepoNames) {
    const repo = lookup.get(requestedRepoName.toLowerCase());

    if (!repo) {
      missingRepoNames.push(requestedRepoName);
      continue;
    }

    if (!selectedRepos.some((entry) => entry.repoName === repo.repoName)) {
      selectedRepos.push(repo);
    }
  }

  if (missingRepoNames.length > 0) {
    throw new Error(
      `Requested source repos were not found under SOURCE_REPO_ROOT: ${missingRepoNames.join(", ")}`,
    );
  }

  return selectedRepos;
}

export async function resolveGitDir(repoPath: string): Promise<string | undefined> {
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

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(value);
}
