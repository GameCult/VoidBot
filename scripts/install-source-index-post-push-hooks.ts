import "dotenv/config";

import { loadConfig } from "@voidbot/config";
import { discoverSourceRepos, selectSourceRepos } from "./source-repo-discovery";
import { installSourceIndexPushHooks } from "./source-repo-hooks";

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
  const discoveredRepos = await discoverSourceRepos(config.sourceRepoRoot, config.sourceRepoPatterns);
  const selectedRepos = selectSourceRepos(discoveredRepos, options.repos);
  const summary = await installSourceIndexPushHooks(process.cwd(), selectedRepos);

  for (const message of summary.messages) {
    console.log(message);
  }

  console.log(
    [
      `installed=${summary.installed}`,
      `updated=${summary.updated}`,
      `backedUp=${summary.backedUp}`,
      `skipped=${summary.skipped}`,
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

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
