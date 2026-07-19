import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVoidbotMcpContext } from "./mcp-server-context";
import { createVoidbotMcpServer } from "./mcp-server-factory";

async function main(): Promise<void> {
  const server = createVoidbotMcpServer(createVoidbotMcpContext());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  console.error("MCP server failed:", error);
  process.exit(1);
});
