import "dotenv/config";

import { loadConfig } from "@voidbot/config";

import { discoverSourceRepos, selectSourceRepos } from "./source-repo-discovery";
import { indexSourceRepos } from "./source-repo-indexing";

interface ScriptOptions {
  repos?: string[];
  forceReindex?: boolean;
}

async function main(): Promise<void> {
  if (!process.env.DISCORD_OWNER_ID) {
    process.env.DISCORD_OWNER_ID = "__source_reindex__";
  }

  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (!config.sourceRepoRoot) {
    throw new Error("SOURCE_REPO_ROOT is not configured.");
  }

  const repoNames =
    await discoverSourceRepos(config.sourceRepoRoot, config.sourceRepoPatterns);
  const repos = selectSourceRepos(repoNames, options.repos);

  if (repos.length === 0) {
    throw new Error("No source repositories matched SOURCE_REPO_PATTERNS.");
  }

  const summary = await indexSourceRepos(config, repos, {
    forceReindex: options.forceReindex,
    logger: (line) => console.log(line),
  });

  console.log(`Indexed repositories: ${summary.indexedRepositories}`);
  console.log(`Indexed documents: ${summary.totalDocuments}`);
  console.log(`Indexed chunks: ${summary.totalChunks}`);
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
      continue;
    }

    if (argument === "--force") {
      options.forceReindex = true;
    }
  }

  return options;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
