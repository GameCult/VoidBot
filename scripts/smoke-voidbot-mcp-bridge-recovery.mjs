import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createVoidbotMcpContext } from "../apps/worker/dist/mcp-server-context.js";
import { startVoidbotMcpHttpServer } from "../apps/worker/dist/mcp-http-server.js";

const port = Number.parseInt(process.env.VOIDBOT_MCP_BRIDGE_SMOKE_PORT ?? "17876", 10);
const endpoint = `http://127.0.0.1:${port}/mcp`;
const context = createVoidbotMcpContext();
let listener = await startVoidbotMcpHttpServer(context, { host: "127.0.0.1", port });
const client = new Client({ name: "voidbot-mcp-bridge-recovery-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["scripts/serve-voidbot-mcp-bridge.mjs"],
  env: { ...process.env, VOIDBOT_MCP_HTTP_URL: endpoint },
  stderr: "inherit",
});

try {
  await client.connect(transport);
  const before = await client.callTool({ name: "list_indexed_repos", arguments: {} });
  assertSuccessful(before, "before outage");

  await closeListener(listener);
  const during = await client.callTool({ name: "list_indexed_repos", arguments: {} });
  if (!during.isError) {
    throw new Error("Bridge did not lower daemon outage into a tool error.");
  }

  listener = await startVoidbotMcpHttpServer(context, { host: "127.0.0.1", port });
  const after = await client.callTool({ name: "list_indexed_repos", arguments: {} });
  assertSuccessful(after, "after recovery");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    beforeRepoCount: before.structuredContent?.repoCount,
    outageWasToolError: during.isError,
    afterRepoCount: after.structuredContent?.repoCount,
  })}\n`);
} finally {
  await client.close().catch(() => undefined);
  await closeListener(listener).catch(() => undefined);
}

function assertSuccessful(result, phase) {
  if (result.isError || !result.structuredContent?.repoCount) {
    throw new Error(`Bridge call failed ${phase}.`);
  }
}

async function closeListener(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
