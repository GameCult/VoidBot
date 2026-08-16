import "dotenv/config";

import { createVoidbotMcpContext } from "./mcp-server-context";
import { startVoidbotMcpHttpServer } from "./mcp-http-server";

async function main(): Promise<void> {
  await startVoidbotMcpHttpServer({
    ...createVoidbotMcpContext(),
  });
}

void main().catch((error) => {
  console.error("Resident MCP HTTP server failed:", error);
  process.exit(1);
});
