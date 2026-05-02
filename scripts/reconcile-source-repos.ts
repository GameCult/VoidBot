import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";

import { loadConfig } from "@voidbot/config";
import { FileSourceDocumentArchiveRepository } from "@voidbot/rag";

import { discoverSourceRepos, selectSourceRepos, type SourceRepoMatch } from "./source-repo-discovery";
import { installSourceIndexPushHooks } from "./source-repo-hooks";
import { createSourceVectorStore, indexSourceRepos } from "./source-repo-indexing";

interface ScriptOptions {
  repos?: string[];
  forceReindex?: boolean;
  detached?: boolean;
  json?: boolean;
  checkOnly?: boolean;
}

interface ReconcileSummary {
  discoveredRepoCount: number;
  indexedRepoCount: number;
  selectedRepoCount: number;
  missingRepos: string[];
  staleIndexedRepos: string[];
  hookInstall: {
    installed: number;
    updated: number;
    backedUp: number;
    skipped: number;
  };
  prunedRepos: string[];
  normalizedArchive: boolean;
  detached: boolean;
  forceReindex: boolean;
  checkOnly: boolean;
  indexedRepos: string[];
  launchedRepos: string[];
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const voidbotRoot = resolve(scriptDir, "..");

async function main(): Promise<void> {
  process.chdir(voidbotRoot);
  loadDotEnv({ path: join(voidbotRoot, ".env") });

  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__source_reconcile__";
  }

  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (!config.sourceRepoRoot) {
    throw new Error("SOURCE_REPO_ROOT is not configured.");
  }

  const discoveredRepos = await discoverSourceRepos(config.sourceRepoRoot, config.sourceRepoPatterns);
  const selectedRepos = selectSourceRepos(discoveredRepos, options.repos);

  if (selectedRepos.length === 0) {
    throw new Error("No source repositories matched SOURCE_REPO_PATTERNS.");
  }

  const archiveRepository = new FileSourceDocumentArchiveRepository(config.ragSourceArchivePath);

  if (!options.checkOnly) {
    await archiveRepository.normalizeStore();
  }

  const indexedRepoSummaries = await archiveRepository.listRepoSummaries();
  const indexedRepoNames = new Set(indexedRepoSummaries.map((summary) => summary.repoName));
  const missingRepos = selectedRepos
    .filter((repo) => options.forceReindex || !indexedRepoNames.has(repo.repoName))
    .map((repo) => repo.repoName);
  const staleIndexedRepos = indexedRepoSummaries
    .map((summary) => summary.repoName)
    .filter((repoName) => !discoveredRepos.some((repo) => repo.repoName === repoName))
    .sort((left, right) => left.localeCompare(right));

  let hookInstall = {
    installed: 0,
    updated: 0,
    backedUp: 0,
    skipped: 0,
  };

  if (!options.checkOnly) {
    const hookSummary = await installSourceIndexPushHooks(voidbotRoot, selectedRepos);
    hookInstall = {
      installed: hookSummary.installed,
      updated: hookSummary.updated,
      backedUp: hookSummary.backedUp,
      skipped: hookSummary.skipped,
    };

    if (!options.json) {
      for (const message of hookSummary.messages) {
        console.log(message);
      }
    }
  }

  const reposToIndex = selectedRepos.filter((repo) => missingRepos.includes(repo.repoName));
  const indexedRepos: string[] = [];
  const launchedRepos: string[] = [];
  const prunedRepos: string[] = [];

  if (!options.checkOnly && reposToIndex.length > 0) {
    if (options.detached) {
      for (const repo of reposToIndex) {
        await launchDetachedRepoIndex(voidbotRoot, repo.repoName);
        launchedRepos.push(repo.repoName);
      }
    } else {
      const runSummary = await indexSourceRepos(config, reposToIndex, {
        forceReindex: options.forceReindex,
        logger: options.json ? undefined : (line) => console.log(line),
      });
      indexedRepos.push(...runSummary.results.map((result) => result.repoName));

      if (!options.json) {
        console.log(`Indexed repositories: ${runSummary.indexedRepositories}`);
        console.log(`Indexed documents: ${runSummary.totalDocuments}`);
        console.log(`Indexed chunks: ${runSummary.totalChunks}`);
      }
    }
  }

  if (!options.checkOnly && staleIndexedRepos.length > 0) {
    const sourceVectorStore = createSourceVectorStore(config);

    for (const repoName of staleIndexedRepos) {
      await sourceVectorStore.deleteByFilters({
        corpusKind: "repository_source",
        repoName,
      });
      await archiveRepository.removeRepo(repoName);
      prunedRepos.push(repoName);
    }
  }

  const summary: ReconcileSummary = {
    discoveredRepoCount: discoveredRepos.length,
    indexedRepoCount: indexedRepoSummaries.length,
    selectedRepoCount: selectedRepos.length,
    missingRepos,
    staleIndexedRepos,
    hookInstall,
    prunedRepos,
    normalizedArchive: !options.checkOnly,
    detached: options.detached,
    forceReindex: options.forceReindex,
    checkOnly: options.checkOnly,
    indexedRepos,
    launchedRepos,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }

  console.log(
    [
      `discoveredRepos=${summary.discoveredRepoCount}`,
      `indexedRepos=${summary.indexedRepoCount}`,
      `selectedRepos=${summary.selectedRepoCount}`,
      `missingRepos=${summary.missingRepos.length}`,
      `staleIndexedRepos=${summary.staleIndexedRepos.length}`,
      `installedHooks=${summary.hookInstall.installed}`,
      `updatedHooks=${summary.hookInstall.updated}`,
      `backedUpHooks=${summary.hookInstall.backedUp}`,
      `skippedHooks=${summary.hookInstall.skipped}`,
      `prunedStaleRepos=${summary.prunedRepos.length}`,
      `indexedNow=${summary.indexedRepos.length}`,
      `launchedDetached=${summary.launchedRepos.length}`,
    ].join(" "),
  );
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    forceReindex: false,
    detached: false,
    json: false,
    checkOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if ((argument === "--repo" || argument === "--repos") && argv[index + 1]) {
      options.repos = argv[index + 1]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      index += 1;
      continue;
    }

    if (argument === "--force") {
      options.forceReindex = true;
      continue;
    }

    if (argument === "--detached") {
      options.detached = true;
      continue;
    }

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--check") {
      options.checkOnly = true;
    }
  }

  return options;
}

async function launchDetachedRepoIndex(voidbotRoot: string, repoName: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        join(voidbotRoot, "scripts", "git-post-push-index.mjs"),
        "--voidbot-root",
        voidbotRoot,
        "--repo-name",
        repoName,
      ],
      {
        cwd: voidbotRoot,
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        rejectPromise(
          new Error(
            stderr.trim().length > 0
              ? stderr.trim()
              : `Detached source-index launcher failed for ${repoName}.`,
          ),
        );
        return;
      }

      resolvePromise();
    });
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
