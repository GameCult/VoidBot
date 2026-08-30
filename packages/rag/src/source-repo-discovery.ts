import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const execFile = promisify(execFileCallback);
const GAMECULT_ORIGIN_PATTERN = /github\.com[:/]GameCult\//i;

export interface SourceRepoMatch {
  /** Canonical GameCult upstream slug: the source archive identity. */
  repoName: string;
  /** Local checkout label; diagnostic only, never an archive key. */
  localRepoName: string;
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
      localRepoName: entry.name,
      repoPath,
      gitDir,
    });
  }

  const approved = await Promise.all(
    repoMatches.map(async (repo) => ({
      repo,
      originUrl: await readOriginUrl(repo.repoPath),
    })),
  );

  return selectCanonicalGameCultRepos(approved);
}

export async function discoverSourceReposFromCatalog(
  root: string,
  catalogPath: string,
): Promise<SourceRepoMatch[]> {
  const resolvedRoot = resolve(root);
  const catalog = await readFile(catalogPath, "utf8");
  const candidates: Array<{ repo: SourceRepoMatch; originUrl: string }> = [];

  for (const [index, rawLine] of catalog.split(/\r?\n/).entries()) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    const [localRepoName, originUrl] = line.split("\t");

    if (!localRepoName || !originUrl || !GAMECULT_ORIGIN_PATTERN.test(originUrl)) {
      throw new Error(`Invalid source catalog entry at line ${index + 1}.`);
    }

    const repoPath = resolve(resolvedRoot, localRepoName);
    const relativePath = relative(resolvedRoot, repoPath);

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Source catalog entry escapes SOURCE_REPO_ROOT: ${localRepoName}`);
    }

    const gitDir = await resolveGitDir(repoPath);

    if (!gitDir) {
      throw new Error(`Source catalog repository is not materialized: ${localRepoName}`);
    }

    candidates.push({
      repo: {
        repoName: localRepoName,
        localRepoName,
        repoPath,
        gitDir,
      },
      originUrl,
    });
  }

  return selectCanonicalGameCultRepos(candidates);
}

async function readOriginUrl(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      windowsHide: true,
    });
    const originUrl = stdout.trim();
    return originUrl.length > 0 ? originUrl : undefined;
  } catch {
    return undefined;
  }
}

function selectCanonicalGameCultRepos(
  candidates: Array<{ repo: SourceRepoMatch; originUrl?: string }>,
): SourceRepoMatch[] {
  const byOrigin = new Map<string, Array<{ repo: SourceRepoMatch; originUrl: string }>>();

  for (const candidate of candidates) {
    if (!candidate.originUrl || !GAMECULT_ORIGIN_PATTERN.test(candidate.originUrl)) {
      continue;
    }

    const originKey = normalizeOrigin(candidate.originUrl);
    const entries = byOrigin.get(originKey) ?? [];
    entries.push({ repo: candidate.repo, originUrl: candidate.originUrl });
    byOrigin.set(originKey, entries);
  }

  return [...byOrigin.values()]
    .map((entries) => {
      const canonical = chooseCanonicalRepo(entries);
      return {
        ...canonical,
        repoName: repoNameFromOrigin(entries[0].originUrl),
      };
    })
    .sort((left, right) => left.repoName.localeCompare(right.repoName));
}

function chooseCanonicalRepo(entries: Array<{ repo: SourceRepoMatch; originUrl: string }>): SourceRepoMatch {
  const remoteName = repoNameFromOrigin(entries[0].originUrl);
  return entries
    .slice()
    .sort((left, right) => canonicalRank(left.repo, remoteName) - canonicalRank(right.repo, remoteName)
      || left.repo.repoName.localeCompare(right.repo.repoName))[0].repo;
}

function canonicalRank(repo: SourceRepoMatch, remoteName: string): number {
  if (repo.localRepoName.localeCompare(remoteName, undefined, { sensitivity: "accent" }) === 0) {
    return 0;
  }

  return repo.gitDir.replace(/\\/g, "/").toLowerCase().endsWith("/.git") ? 1 : 2;
}

function normalizeOrigin(originUrl: string): string {
  return originUrl.trim().replace(/\\/g, "/").replace(/\.git$/i, "").toLowerCase();
}

function repoNameFromOrigin(originUrl: string): string {
  const normalized = originUrl.trim().replace(/\\/g, "/").replace(/\.git$/i, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function selectSourceRepos(
  availableRepos: SourceRepoMatch[],
  requestedRepoNames?: string[],
): SourceRepoMatch[] {
  if (!requestedRepoNames || requestedRepoNames.length === 0) {
    return availableRepos;
  }

  const lookup = new Map(
    availableRepos.flatMap((repo) => [
      [repo.repoName.toLowerCase(), repo] as const,
      [repo.localRepoName.toLowerCase(), repo] as const,
    ]),
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
