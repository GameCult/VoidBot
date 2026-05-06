import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const coreDistPath = resolve(repoRoot, "packages/core/dist/moderation-state-store.js");

if (!existsSync(coreDistPath)) {
  throw new Error(`Missing built moderation-state-store helper at ${coreDistPath}. Run npm run build first.`);
}

const {
  commitModerationStateWorkingView,
  ensureModerationStateStore,
  getModerationStateLegacyJsonPath,
  getModerationStateWorkingPath,
  readModerationStateCursor,
  setModerationStateCursor,
} = require(coreDistPath);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command) {
    throw new Error("Expected a moderation-state-store command.");
  }

  const canonicalPath = requirePathArg(args, "canonical");
  const workingPath = args.working ?? getModerationStateWorkingPath(canonicalPath);
  const legacyJsonPath = args.legacy ?? getModerationStateLegacyJsonPath(canonicalPath);
  const templatePath = args.template;
  const paths = {
    canonicalPath,
    workingPath,
    legacyJsonPath,
    templatePath,
  };

  switch (command) {
    case "ensure": {
      const result = await ensureModerationStateStore(paths);
      writeJson({
        canonicalPath: result.canonicalPath,
        workingPath: result.workingPath,
        createdCanonical: result.createdCanonical,
        migratedFromLegacyJson: result.migratedFromLegacyJson,
        cursor: result.state.moderation_runtime?.cursor ?? null,
      });
      return;
    }
    case "read-cursor": {
      const cursor = await readModerationStateCursor(canonicalPath);
      writeJson(cursor);
      return;
    }
    case "commit-working-view": {
      const state = await commitModerationStateWorkingView(paths);
      writeJson({
        canonicalPath,
        workingPath,
        cursor: state.moderation_runtime?.cursor ?? null,
      });
      return;
    }
    case "set-cursor": {
      const state = await setModerationStateCursor(paths, {
        lastReviewedMessageId: args["message-id"] ?? null,
        lastReviewedTimestamp: args.timestamp ?? null,
      });
      writeJson({
        canonicalPath,
        workingPath,
        cursor: state.moderation_runtime?.cursor ?? null,
      });
      return;
    }
    default:
      throw new Error(`Unknown moderation-state-store command "${command}".`);
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function requirePathArg(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required --${key} path.`);
  }

  return resolve(value);
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

await main();
