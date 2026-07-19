import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const host = process.env.VOIDBOT_MCP_REMOTE_HOST;
const keyPath = process.env.VOIDBOT_MCP_SSH_KEY_PATH;
if (!host || !keyPath) {
  throw new Error("VOIDBOT_MCP_REMOTE_HOST and VOIDBOT_MCP_SSH_KEY_PATH are required.");
}

const transport = new StdioClientTransport({
  command: process.env.VOIDBOT_MCP_SSH_EXECUTABLE ?? "ssh",
  args: [
    "-T", "-i", keyPath, host,
    "sudo", "docker", "exec", "-i", "compose-worker-1",
    "node", "/app/apps/worker/dist/mcp-server.js",
  ],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "voidbot-remote-mcp-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  for (const requiredTool of ["search_history", "list_indexed_repos", "search_sources"]) {
    if (!tools.tools.some((tool) => tool.name === requiredTool)) {
      throw new Error(`Remote VoidBot MCP did not advertise ${requiredTool}.`);
    }
  }
  const historyResult = await client.callTool({
    name: "search_history",
    arguments: { query: "VoidBot deployment Yggdrasil", limit: 2 },
  });
  if (historyResult.isError) {
    const detail = historyResult.content?.map((entry) => entry.type === "text" ? entry.text : entry.type).join(" ");
    throw new Error(`Remote search_history failed: ${detail || "unknown MCP error"}`);
  }
  const repositoriesResult = await client.callTool({ name: "list_indexed_repos", arguments: {} });
  if (repositoriesResult.isError) {
    throw new Error("Remote list_indexed_repos failed.");
  }
  const sourceResult = await client.callTool({
    name: "search_sources",
    arguments: { query: "VoidBot indexed source retrieval", limit: 2 },
  });
  if (sourceResult.isError) {
    const detail = sourceResult.content?.map((entry) => entry.type === "text" ? entry.text : entry.type).join(" ");
    throw new Error(`Remote search_sources failed: ${detail || "unknown MCP error"}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    toolCount: tools.tools.length,
    historyResult,
    repositoriesResult,
    sourceResult,
  }, null, 2)}\n`);
} finally {
  await client.close();
}
