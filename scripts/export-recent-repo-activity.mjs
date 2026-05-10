import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRepoActivityCursorPath = resolve(
  repoRoot,
  ".voidbot/private/moderation-agent-state.json",
);
const moderationStateStoreScriptPath = resolve(repoRoot, "scripts/moderation-state-store.mjs");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const trackedRepoNames = readTrackedRepoNames(config.archivePath, options.repoNames);
  const availableRepos = readAvailableRepos(config.sourceRepoRoot);
  const cursorFilePath = options.cursorFile ? resolve(repoRoot, options.cursorFile) : null;
  const moderationState = cursorFilePath ? readJsonFileSafe(cursorFilePath) : null;
  const repoActivityCursor = readRepoActivityCursor(moderationState);
  const sinceIso = new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString();
  const generatedAt = new Date().toISOString();

  const repos = trackedRepoNames.map((repoName) =>
    inspectRepoActivity({
      repoName,
      repoPath: availableRepos.get(repoName.toLowerCase()),
      sinceIso,
      maxCommits: options.maxCommits,
      cursorEntry: repoActivityCursor.get(repoName.toLowerCase()) ?? null,
    }),
  );

  repos.sort(compareRepoActivity);
  const cursorUpdate = cursorFilePath
    ? writeRepoActivityCursor({
        state: moderationState,
        cursorFilePath,
        repos,
        hours: options.hours,
        generatedAt,
      })
    : { mode: "stateless", updated: false, repoCount: 0 };

  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt,
        sourceRepoRoot: config.sourceRepoRoot,
        archivePath: config.archivePath,
        since: sinceIso,
        hours: options.hours,
        maxCommits: options.maxCommits,
        cursorMode: cursorUpdate.mode,
        cursorFile: cursorFilePath,
        cursorUpdated: cursorUpdate.updated,
        cursorRepoCount: cursorUpdate.repoCount,
        totalTrackedRepos: trackedRepoNames.length,
        repos,
        digest: renderDigest(repos, sinceIso, cursorUpdate.mode),
      },
      null,
      2,
    )}\n`,
  );
}

function parseArgs(args) {
  const options = {
    hours: 72,
    maxCommits: 3,
    repoNames: undefined,
    cursorFile: defaultRepoActivityCursorPath,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--hours":
        options.hours = Number.parseInt(args[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--max-commits":
        options.maxCommits = Number.parseInt(args[index + 1] ?? "", 10);
        index += 1;
        break;
      case "--repos":
        options.repoNames = parseRepoList(args[index + 1] ?? "");
        index += 1;
        break;
      case "--cursor-file":
        options.cursorFile = args[index + 1] ?? "";
        index += 1;
        break;
      case "--stateless":
        options.cursorFile = null;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isInteger(options.hours) || options.hours <= 0) {
    throw new Error("--hours must be a positive integer.");
  }

  if (!Number.isInteger(options.maxCommits) || options.maxCommits <= 0) {
    throw new Error("--max-commits must be a positive integer.");
  }

  return options;
}

function readJsonFileSafe(path) {
  try {
    return JSON.parse(stripLeadingBom(readFileSync(path, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function parseRepoList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readConfig() {
  const envPath = resolve(repoRoot, ".env");
  const env = parseDotEnvSafe(envPath);
  const sourceRepoRoot = env.SOURCE_REPO_ROOT?.trim();
  const archivePath = resolve(
    repoRoot,
    env.RAG_SOURCE_ARCHIVE_PATH?.trim() || ".voidbot/rag/source-documents.json",
  );

  if (!sourceRepoRoot) {
    throw new Error("SOURCE_REPO_ROOT is not configured in .env.");
  }

  return {
    sourceRepoRoot: resolve(sourceRepoRoot),
    archivePath,
  };
}

function parseDotEnvSafe(envPath) {
  try {
    return parseDotEnv(stripLeadingBom(readFileSync(envPath, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function parseDotEnv(raw) {
  const result = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function readTrackedRepoNames(archivePath, requestedRepoNames) {
  const raw = stripLeadingBom(readFileSync(archivePath, "utf8"));
  const parsed = JSON.parse(raw);
  const repoNames = Array.isArray(parsed?.repos)
    ? parsed.repos
        .map((entry) => (entry && typeof entry.repoName === "string" ? entry.repoName : undefined))
        .filter(Boolean)
    : [];

  if (repoNames.length === 0) {
    throw new Error(`No tracked repos were found in ${archivePath}.`);
  }

  if (!requestedRepoNames || requestedRepoNames.length === 0) {
    return repoNames;
  }

  const requestedLookup = new Set(requestedRepoNames.map((value) => value.toLowerCase()));
  const selected = repoNames.filter((repoName) => requestedLookup.has(repoName.toLowerCase()));

  const missing = requestedRepoNames.filter(
    (repoName) => !selected.some((value) => value.toLowerCase() === repoName.toLowerCase()),
  );

  if (missing.length > 0) {
    throw new Error(`Requested tracked repos are missing from the source archive manifest: ${missing.join(", ")}`);
  }

  return selected;
}

function readAvailableRepos(sourceRepoRoot) {
  const lookup = new Map();

  for (const entry of readdirSync(sourceRepoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    lookup.set(entry.name.toLowerCase(), resolve(sourceRepoRoot, entry.name));
  }

  return lookup;
}

function inspectRepoActivity({ repoName, repoPath, sinceIso, maxCommits, cursorEntry }) {
  if (!repoPath) {
    return {
      repoName,
      repoPath: null,
      status: "missing",
      branch: null,
      recentCommitCount: 0,
      latestCommit: null,
      commits: [],
      windowRecentCommitCount: 0,
      suppressedRecentCommitCount: 0,
    };
  }

  try {
    const branch = execGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const latestCommit = parseCommitLine(execGit(repoPath, ["log", "-1", "--date=iso-strict", "--pretty=format:%H%x09%cI%x09%an%x09%s"]));
    const recentCommitCount = Number.parseInt(
      execGit(repoPath, ["rev-list", "--count", `--since=${sinceIso}`, "HEAD"]).trim(),
      10,
    );
    const recentCommitLines = execGit(repoPath, [
      "log",
      `--since=${sinceIso}`,
      `--max-count=${maxCommits}`,
      "--date=iso-strict",
      "--pretty=format:%H%x09%cI%x09%an%x09%s",
    ]);
    const commits = recentCommitLines
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => enrichCommit(repoPath, parseCommitLine(line)))
      .filter(Boolean);
    const freshCommits = filterCommitsSinceCursor(commits, cursorEntry);
    const freshCommitCount = freshCommits.length;
    const windowRecentCommitCount = Number.isFinite(recentCommitCount) ? recentCommitCount : commits.length;

    return {
      repoName,
      repoPath,
      status: "ok",
      branch,
      recentCommitCount: freshCommitCount,
      windowRecentCommitCount,
      suppressedRecentCommitCount: Math.max(0, windowRecentCommitCount - freshCommitCount),
      latestCommit,
      commits: freshCommits,
      cursorEntry,
    };
  } catch (error) {
    return {
      repoName,
      repoPath,
      status: "error",
      branch: null,
      recentCommitCount: 0,
      latestCommit: null,
      commits: [],
      windowRecentCommitCount: 0,
      suppressedRecentCommitCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function filterCommitsSinceCursor(commits, cursorEntry) {
  if (!Array.isArray(commits) || commits.length === 0 || !cursorEntry || typeof cursorEntry !== "object") {
    return commits;
  }

  const lastSeenHash = typeof cursorEntry.lastSeenHash === "string" ? cursorEntry.lastSeenHash.trim() : "";
  if (lastSeenHash) {
    const seenIndex = commits.findIndex((commit) => commit?.hash === lastSeenHash);
    if (seenIndex !== -1) {
      return commits.slice(0, seenIndex);
    }
  }

  const lastSeenCommittedAt =
    typeof cursorEntry.lastSeenCommittedAt === "string" ? cursorEntry.lastSeenCommittedAt.trim() : "";
  const lastSeenMs = lastSeenCommittedAt ? Date.parse(lastSeenCommittedAt) : Number.NaN;
  if (Number.isFinite(lastSeenMs)) {
    return commits.filter((commit) => Date.parse(commit.committedAt) > lastSeenMs);
  }

  return commits;
}

function execGit(repoPath, args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseCommitLine(line) {
  if (!line) {
    return null;
  }

  const [hash, committedAt, author, ...subjectParts] = line.split("\t");

  return {
    hash,
    committedAt,
    author,
    subject: subjectParts.join("\t"),
  };
}

function enrichCommit(repoPath, commit) {
  if (!commit?.hash) {
    return commit;
  }

  try {
    const statLines = execGit(repoPath, [
      "show",
      "--shortstat",
      "--format=",
      "--name-only",
      commit.hash,
    ])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const summaryLine = statLines.find((line) => /files? changed|insertions?|deletions?/.test(line));
    const changedPaths = statLines.filter((line) => !/files? changed|insertions?|deletions?/.test(line)).slice(0, 8);

    return {
      ...commit,
      diffstat: parseDiffstat(summaryLine),
      changedPaths,
    };
  } catch {
    return {
      ...commit,
      diffstat: null,
      changedPaths: [],
    };
  }
}

function parseDiffstat(summaryLine) {
  if (!summaryLine) {
    return null;
  }

  return {
    filesChanged: readFirstInt(summaryLine, /(\d+)\s+files?\s+changed/i),
    insertions: readFirstInt(summaryLine, /(\d+)\s+insertions?\(\+\)/i),
    deletions: readFirstInt(summaryLine, /(\d+)\s+deletions?\(-\)/i),
  };
}

function readFirstInt(input, pattern) {
  const match = input.match(pattern);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function compareRepoActivity(left, right) {
  const leftRecent = left.recentCommitCount ?? 0;
  const rightRecent = right.recentCommitCount ?? 0;

  if (rightRecent !== leftRecent) {
    return rightRecent - leftRecent;
  }

  const leftTimestamp = left.commits?.[0]?.committedAt ?? left.latestCommit?.committedAt ?? "";
  const rightTimestamp = right.commits?.[0]?.committedAt ?? right.latestCommit?.committedAt ?? "";

  return rightTimestamp.localeCompare(leftTimestamp);
}

function renderDigest(repos, sinceIso, cursorMode) {
  const isIncremental = cursorMode === "incremental";
  const lines = [
    isIncremental
      ? `New tracked repo activity since the saved repo cursor (bounded to ${sinceIso}):`
      : `Recent tracked repo activity since ${sinceIso}:`,
  ];
  let mentionedRepoCount = 0;

  for (const repo of repos) {
    if (repo.status === "missing") {
      lines.push(`- ${repo.repoName}: missing locally under SOURCE_REPO_ROOT`);
      mentionedRepoCount += 1;
      continue;
    }

    if (repo.status === "error") {
      lines.push(`- ${repo.repoName}: failed to read git activity (${repo.error})`);
      mentionedRepoCount += 1;
      continue;
    }

    if (isIncremental && repo.recentCommitCount <= 0) {
      continue;
    }

    const header =
      repo.recentCommitCount > 0
        ? `- ${repo.repoName} [${repo.branch}]: ${repo.recentCommitCount} ${isIncremental ? "new" : "recent"} commit${repo.recentCommitCount === 1 ? "" : "s"}`
        : `- ${repo.repoName} [${repo.branch}]: no recent commits`;
    lines.push(header);
    mentionedRepoCount += 1;

    if (repo.commits.length > 0) {
      for (const commit of repo.commits) {
        const statBits = [];
        if (commit.diffstat?.filesChanged) {
          statBits.push(`${commit.diffstat.filesChanged} files`);
        }
        if (commit.diffstat?.insertions) {
          statBits.push(`+${commit.diffstat.insertions}`);
        }
        if (commit.diffstat?.deletions) {
          statBits.push(`-${commit.diffstat.deletions}`);
        }

        lines.push(
          `  - ${commit.committedAt} ${commit.author}: ${commit.subject}${statBits.length > 0 ? ` (${statBits.join(", ")})` : ""}`,
        );
        if (Array.isArray(commit.changedPaths) && commit.changedPaths.length > 0) {
          lines.push(`    paths: ${commit.changedPaths.join(", ")}`);
        }
      }
    } else if (!isIncremental && repo.latestCommit) {
      lines.push(
        `  - latest overall ${repo.latestCommit.committedAt} ${repo.latestCommit.author}: ${repo.latestCommit.subject}`,
      );
    }
  }

  if (mentionedRepoCount === 0) {
    lines.push(
      isIncremental
        ? "- No new tracked repo commits crossed the saved repo-activity cursor."
        : "- No recent tracked repo commits.",
    );
  }

  return lines.join("\n");
}

function readRepoActivityCursor(state) {
  const lookup = new Map();
  const rawCursor = state?.moderation_runtime?.repo_activity_cursor;
  if (!rawCursor || typeof rawCursor !== "object" || Array.isArray(rawCursor)) {
    return lookup;
  }

  for (const [repoName, cursorEntry] of Object.entries(rawCursor)) {
    if (!repoName || !cursorEntry || typeof cursorEntry !== "object" || Array.isArray(cursorEntry)) {
      continue;
    }

    lookup.set(repoName.toLowerCase(), cursorEntry);
  }

  return lookup;
}

function writeRepoActivityCursor({ state, cursorFilePath, repos, hours, generatedAt }) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { mode: "incremental", updated: false, repoCount: 0 };
  }

  if (!state.moderation_runtime || typeof state.moderation_runtime !== "object" || Array.isArray(state.moderation_runtime)) {
    state.moderation_runtime = {};
  }

  const currentCursor = state.moderation_runtime.repo_activity_cursor;
  const nextCursor =
    currentCursor && typeof currentCursor === "object" && !Array.isArray(currentCursor) ? { ...currentCursor } : {};

  let updated = false;
  let repoCount = 0;

  for (const repo of repos) {
    if (repo.status !== "ok" || !repo.latestCommit?.hash || repo.recentCommitCount <= 0) {
      continue;
    }

    const nextEntry = {
      lastSeenHash: repo.latestCommit.hash,
      lastSeenCommittedAt: repo.latestCommit.committedAt ?? null,
      lastInjectedAt: generatedAt,
      hoursWindow: hours,
      branch: repo.branch ?? null,
    };
    const previousEntry = nextCursor[repo.repoName];

    if (JSON.stringify(previousEntry) !== JSON.stringify(nextEntry)) {
      nextCursor[repo.repoName] = nextEntry;
      updated = true;
    }

    repoCount += 1;
  }

  if (updated) {
    state.moderation_runtime.repo_activity_cursor = nextCursor;
    writeFileSync(cursorFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const canonicalPath = deriveCanonicalModerationStatePath(cursorFilePath);
    if (canonicalPath && existsSync(moderationStateStoreScriptPath)) {
      execFileSync(
        process.execPath,
        [
          moderationStateStoreScriptPath,
          "commit-working-view",
          "--canonical",
          canonicalPath,
          "--working",
          cursorFilePath,
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
  }

  return { mode: "incremental", updated, repoCount };
}

function deriveCanonicalModerationStatePath(cursorFilePath) {
  if (typeof cursorFilePath !== "string" || !cursorFilePath.toLowerCase().endsWith(".json")) {
    return null;
  }

  const candidate = `${cursorFilePath.slice(0, -".json".length)}.msgpack`;
  return existsSync(candidate) ? candidate : null;
}

function stripLeadingBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
