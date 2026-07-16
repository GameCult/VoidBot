import "dotenv/config";

import { loadConfig } from "@voidbot/config";
import { inspectPersonaTurnPrompt } from "../apps/persona-scheduler/dist/persona-prompt-inspection.js";
import { runPersonaSchedulerTick } from "../apps/persona-scheduler/dist/persona-scheduler-runner.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const identityId = readArgValue("--assemble-prompt");
  const result = identityId
    ? await inspectPersonaTurnPrompt({
        config,
        identityId,
        outPath: readArgValue("--out"),
        memorySurfacePath: readArgValue("--memory-surface"),
        conversationSurfacePath: readArgValue("--conversation-surface"),
      })
    : await runPersonaSchedulerTick({ config, dryRun: process.argv.includes("--dry-run"), force: process.argv.includes("--force") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
