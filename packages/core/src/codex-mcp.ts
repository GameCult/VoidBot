import { resolve } from "node:path";

import { type CodexMcpServerConfig } from "@voidbot/shared";

export const VOID_MCP_SERVER_NAME = "voidbot";

export function buildVoidMcpServerConfig(workspaceRoot: string): CodexMcpServerConfig {
  return {
    name: VOID_MCP_SERVER_NAME,
    command: process.execPath,
    args: [resolve(workspaceRoot, "apps", "worker", "dist", "mcp-server.js")],
    cwd: workspaceRoot,
    env: {
      VOIDBOT_WORKSPACE_ROOT: workspaceRoot,
      ...(process.env.ODIN_BASE_URL ? { ODIN_BASE_URL: process.env.ODIN_BASE_URL } : {}),
    },
  };
}

export function buildCodexMcpConfigOverrides(
  servers: CodexMcpServerConfig[],
): string[] {
  const overrides: string[] = [];

  for (const server of servers) {
    overrides.push(`mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`);
    overrides.push(`mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`);

    if (server.cwd) {
      overrides.push(`mcp_servers.${server.name}.cwd=${JSON.stringify(server.cwd)}`);
    }

    for (const [key, value] of Object.entries(server.env ?? {})) {
      overrides.push(`mcp_servers.${server.name}.env.${key}=${JSON.stringify(value)}`);
    }
  }

  return overrides;
}
