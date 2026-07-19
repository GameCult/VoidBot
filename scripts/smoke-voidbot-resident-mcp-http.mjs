import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const targetUrl = process.env.VOIDBOT_MCP_HTTP_URL;
let listener;
let endpoint;
if (targetUrl) {
  endpoint = new URL(targetUrl);
} else {
  const { createVoidbotMcpContext } = await import("../apps/worker/dist/mcp-server-context.js");
  const { startVoidbotMcpHttpServer } = await import("../apps/worker/dist/mcp-http-server.js");
  const port = Number.parseInt(process.env.VOIDBOT_MCP_HTTP_SMOKE_PORT ?? "17876", 10);
  listener = await startVoidbotMcpHttpServer(createVoidbotMcpContext(), {
    host: "127.0.0.1",
    port,
  });
  endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
}
const client = new Client({ name: "voidbot-resident-mcp-http-smoke", version: "1.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const tools = await client.listTools();
  const repositories = await client.callTool({ name: "list_indexed_repos", arguments: {} });
  if (repositories.isError || !repositories.structuredContent?.repoCount) {
    throw new Error("Resident MCP HTTP endpoint did not return indexed repositories.");
  }
  const sources = await client.callTool({
    name: "search_sources",
    arguments: { query: "VoidBot resident MCP", repoName: "VoidBot", limit: 1 },
  });
  if (sources.isError || !sources.structuredContent?.resultCount) {
    throw new Error("Resident MCP HTTP endpoint did not return indexed source results.");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    toolCount: tools.tools.length,
    repoCount: repositories.structuredContent.repoCount,
    sourceResultCount: sources.structuredContent.resultCount,
  })}\n`);
} finally {
  await client.close().catch(() => undefined);
  if (listener) {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
}
