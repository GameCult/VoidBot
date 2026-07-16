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
  if (!tools.tools.some((tool) => tool.name === "search_history")) {
    throw new Error("Remote VoidBot MCP did not advertise search_history.");
  }
  const result = await client.callTool({
    name: "search_history",
    arguments: { query: "VoidBot deployment Yggdrasil", limit: 2 },
  });
  if (result.isError) {
    const detail = result.content?.map((entry) => entry.type === "text" ? entry.text : entry.type).join(" ");
    throw new Error(`Remote search_history failed: ${detail || "unknown MCP error"}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, toolCount: tools.tools.length, result }, null, 2)}\n`);
} finally {
  await client.close();
}
