import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type VoidbotMcpContext } from "./mcp-server-context";
import { registerVoidbotResources } from "./mcp-server-resources";
import { registerVoidbotTools } from "./mcp-server-tools";

export function createVoidbotMcpServer(context: VoidbotMcpContext): McpServer {
  const server = new McpServer(
    {
      name: "voidbot",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerVoidbotResources(server, context);
  registerVoidbotTools(server, context);
  return server;
}
