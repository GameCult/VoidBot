import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../packages/config/src";
import { buildVoidMcpServerConfig } from "../packages/core/src/codex-mcp";

async function main(): Promise<void> {
  const workspaceRoot = resolve(process.cwd());
  loadDotenv({ path: resolve(workspaceRoot, ".env") });
  const config = loadConfig();
  const server = buildVoidMcpServerConfig(workspaceRoot);
  const entrypoint = server.args[0];

  if (!entrypoint || !existsSync(entrypoint)) {
    throw new Error(
      `Build the project first so the MCP server exists at ${entrypoint ?? "(missing entrypoint)"}.`,
    );
  }

  await runCodex(config.codexExecutable, config.codexExecArgs, ["mcp", "remove", server.name], true);

  const addArgs = ["mcp", "add"];

  for (const [key, value] of Object.entries(server.env ?? {})) {
    addArgs.push("--env", `${key}=${value}`);
  }

  addArgs.push(server.name, "--", server.command, ...server.args);

  await runCodex(config.codexExecutable, config.codexExecArgs, addArgs);
  await runCodex(config.codexExecutable, config.codexExecArgs, ["mcp", "get", server.name]);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function runCodex(
  executable: string,
  executableArgs: string[],
  args: string[],
  allowFailure = false,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...executableArgs, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`codex ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}
