import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultModerationStatePath = resolve(
  repoRoot,
  ".voidbot/private/void-self-state.cc",
);
const voidSelfStateScriptPath = resolve(repoRoot, "scripts/void-self-state.mjs");
const coreDistPath = resolve(repoRoot, "packages/core/dist/index.js");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const trackedRepoNames = readTrackedRepoNames(config.archivePath, options.repoNames);
  const availableRepos = readAvailableRepos(config.sourceRepoRoot);
  const canonicalStatePath = resolveCanonicalStatePath(options);
  const repoActivityCursor = canonicalStatePath
    ? readRepoActivityCursorFromCanonicalState(canonicalStatePath)
    : new Map();
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
  const cursorUpdate = canonicalStatePath
    ? writeRepoActivityCursor({
        canonicalStatePath,
        repos,
        generatedAt,
        readOnly: options.readOnly,
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
        statePath: canonicalStatePath,
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
    statePath: defaultModerationStatePath,
    cursorFile: undefined,
    readOnly: false,
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
      case "--state-path":
        options.statePath = args[index + 1] ?? "";
        index += 1;
        break;
      case "--stateless":
        options.statePath = null;
        options.cursorFile = null;
        break;
      case "--read-only":
        options.readOnly = true;
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

function resolveCanonicalStatePath(options) {
  if (options.statePath === null) {
    return null;
  }

  if (options.cursorFile) {
    const cursorFilePath = resolve(repoRoot, options.cursorFile);
    const derived = deriveCanonicalModerationStatePath(cursorFilePath);
    if (derived) {
      return derived;
    }
    return cursorFilePath.toLowerCase().endsWith(".cc") ? cursorFilePath : null;
  }

  return options.statePath ? resolve(repoRoot, options.statePath) : null;
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

function readRepoActivityCursorFromCanonicalState(canonicalStatePath) {
  if (!existsSync(canonicalStatePath)) {
    return new Map();
  }

  if (!existsSync(coreDistPath)) {
    throw new Error(`Missing built core package at ${coreDistPath}. Run npm run build first.`);
  }

  const typedCursor = readTypedRepoActivityCursor(canonicalStatePath);
  const lookup = new Map();

  for (const cursorEntry of typedCursor) {
    if (!cursorEntry?.repo) {
      continue;
    }

    lookup.set(cursorEntry.repo.toLowerCase(), {
      lastSeenHash: cursorEntry.lastCommitSha ?? null,
      lastSeenCommittedAt: cursorEntry.lastCommitAt ?? null,
    });
  }

  return lookup;
}

function writeRepoActivityCursor({ canonicalStatePath, repos, generatedAt, readOnly }) {
  let updated = false;
  let repoCount = 0;

  if (readOnly) {
    return {
      mode: "incremental_read_only",
      updated: false,
      repoCount: repos.filter((repo) => repo.status === "ok" && repo.recentCommitCount > 0).length,
    };
  }

  for (const repo of repos) {
    if (repo.status !== "ok" || !repo.latestCommit?.hash || repo.recentCommitCount <= 0) {
      continue;
    }

    const nextEntry = {
      lastSeenHash: repo.latestCommit.hash,
      lastSeenCommittedAt: repo.latestCommit.committedAt ?? null,
      lastInjectedAt: generatedAt,
    };
    applyRepoActivityCursorOperation({
      canonicalStatePath,
      repoName: repo.repoName,
      nextEntry,
    });
    updated = true;
    repoCount += 1;
  }

  return { mode: "incremental", updated, repoCount };
}

function applyRepoActivityCursorOperation({ canonicalStatePath, repoName, nextEntry }) {
  if (!existsSync(voidSelfStateScriptPath)) {
    throw new Error(`Missing typed self-state CLI at ${voidSelfStateScriptPath}.`);
  }

  const operation = {
    operation: "update_repo_activity_cursor",
    cursor: {
      repo: repoName,
      lastCommitAt: nextEntry.lastSeenCommittedAt ?? undefined,
      lastCommitSha: nextEntry.lastSeenHash ?? undefined,
      updatedAt: nextEntry.lastInjectedAt,
    },
  };

  execFileSync(
    process.execPath,
    [
      voidSelfStateScriptPath,
      "apply-operation",
      "--canonical",
      canonicalStatePath,
      "--operation",
      JSON.stringify(operation),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function readTypedRepoActivityCursor(canonicalStatePath) {
  const marker = "__VOIDBOT_ASYNC_RESULT__";
  const script = `
    const core = require(${JSON.stringify(coreDistPath)});
    core.loadVoidSelfStateTypedDocuments({ canonicalPath: ${JSON.stringify(canonicalStatePath)} })
      .then((state) => {
        console.log(${JSON.stringify(marker)} + JSON.stringify(state.moderationCursor.repoActivityCursor ?? []));
      })
      .catch((error) => { console.error(error); process.exit(1); });
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(marker));
  if (!line) {
    throw new Error("Failed to read moderation state through core loader.");
  }
  return JSON.parse(line.slice(marker.length));
}

function deriveCanonicalModerationStatePath(cursorFilePath) {
  if (typeof cursorFilePath !== "string" || !cursorFilePath.toLowerCase().endsWith(".json")) {
    return null;
  }

  const candidate = `${cursorFilePath.slice(0, -".json".length)}.cc`;
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
