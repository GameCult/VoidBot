import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";

import { loadConfig } from "../packages/config/src";
import { VOID_MCP_SERVER_NAME } from "../packages/core/src/codex-mcp";

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  loadDotenv({ path: resolve(process.cwd(), ".env") });
  const config = loadConfig();
  await runCodex(config.codexExecutable, config.codexExecArgs, ["mcp", "remove", VOID_MCP_SERVER_NAME]);
}

function runCodex(executable: string, executableArgs: string[], args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...executableArgs, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`codex ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}
