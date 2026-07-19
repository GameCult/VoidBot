import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const node = process.execPath;
const transport = new StdioClientTransport({
  command: node,
  args: ["scripts/serve-voidbot-remote-mcp-relay.mjs"],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "voidbot-remote-relay-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const repositories = await client.callTool({ name: "list_indexed_repos", arguments: {} });
  const sources = await client.callTool({
    name: "search_sources",
    arguments: { query: "VoidBot indexed source retrieval", repoName: "VoidBot", limit: 1 },
  });
  if (repositories.isError || sources.isError) {
    throw new Error("Remote relay returned an MCP error for indexed-source retrieval.");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    toolCount: tools.tools.length,
    repoCount: repositories.structuredContent?.repoCount,
    sourceResultCount: sources.structuredContent?.resultCount,
  })}\n`);
} finally {
  await client.close();
}
