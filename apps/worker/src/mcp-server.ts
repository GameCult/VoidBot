import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVoidbotMcpContext } from "./mcp-server-context";
import { registerVoidbotResources } from "./mcp-server-resources";
import { registerVoidbotTools } from "./mcp-server-tools";

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

const context = createVoidbotMcpContext();
registerVoidbotResources(server, context);
registerVoidbotTools(server, context);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  console.error("MCP server failed:", error);
  process.exit(1);
});
