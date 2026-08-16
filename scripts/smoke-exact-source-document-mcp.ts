import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FileSourceDocumentArchiveRepository,
  SourceDocumentIngester,
} from "@voidbot/rag";

import { createVoidbotMcpServer } from "../apps/worker/src/mcp-server-factory";
import { type VoidbotMcpContext } from "../apps/worker/src/mcp-server-context";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "voidbot-exact-source-"));
  try {
  const sources = new FileSourceDocumentArchiveRepository(join(root, "sources.json"));
  await sources.syncRepoDocuments("AetheriaLore", [{
    id: "AetheriaLore:places/forge.md",
    repoName: "AetheriaLore",
    path: "places/forge.md",
    content: "John keeps the village forge.\nThe eastern road takes six hours.",
    language: "markdown",
    title: "The Village Forge",
  }]);
  const context = {
    sourceArchiveRepository: sources,
    sourceDocumentIngester: new SourceDocumentIngester(),
  } as VoidbotMcpContext;
  const server = createVoidbotMcpServer(context);
  const client = new Client({ name: "exact-source-smoke", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({
    name: "get_exact_source_document",
    arguments: { sourceId: "AetheriaLore:places/forge.md" },
  });
  const typed = result.structuredContent as Record<string, unknown>;
  if (typed.found !== true || typed.content !== "John keeps the village forge.\nThe eastern road takes six hours.") {
    throw new Error(`exact source MCP contract failed: ${JSON.stringify(typed)}`);
  }
  await client.close();
  await server.close();
  console.log("Exact source MCP smoke passed.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
