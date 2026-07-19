#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const endpoint = new URL(process.env.VOIDBOT_MCP_HTTP_URL ?? "http://127.0.0.1:17875/mcp");
let cachedTools;

const server = new Server(
  { name: "voidbot-transport-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    cachedTools = await withDaemon((client) => client.listTools());
    return cachedTools;
  } catch (error) {
    if (cachedTools) {
      return cachedTools;
    }
    throw error;
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await withDaemon((client) => client.callTool(request.params));
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `VoidBot daemon is temporarily unavailable: ${describeError(error)}`,
      }],
    };
  }
});

async function withDaemon(operation) {
  const client = new Client({ name: "voidbot-transport-bridge-upstream", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

await server.connect(new StdioServerTransport());
