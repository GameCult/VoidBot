#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const host = process.env.VOIDBOT_MCP_REMOTE_HOST;
const keyPath = process.env.VOIDBOT_MCP_SSH_KEY_PATH;
if (!host || !keyPath) {
  throw new Error("VOIDBOT_MCP_REMOTE_HOST and VOIDBOT_MCP_SSH_KEY_PATH are required.");
}

const server = new Server(
  { name: "voidbot-yggdrasil-relay", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () =>
  withRemoteClient((client) => client.listTools()),
);

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  withRemoteClient((client) => client.callTool(request.params)),
);

async function withRemoteClient(operation) {
  const transport = new StdioClientTransport({
    command: process.env.VOIDBOT_MCP_SSH_EXECUTABLE ?? "ssh",
    args: [
      "-T", "-i", keyPath, host,
      "sudo", "docker", "exec", "-i", "compose-worker-1",
      "node", "/app/apps/worker/dist/mcp-server.js",
    ],
    env: process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "voidbot-yggdrasil-relay-upstream", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

await server.connect(new StdioServerTransport());
