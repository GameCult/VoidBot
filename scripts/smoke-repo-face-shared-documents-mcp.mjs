#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(process.cwd());
const serverPath = resolve(workspaceRoot, "apps", "worker", "dist", "mcp-server.js");
const storageRoot = await mkdtemp(join(tmpdir(), "voidbot-shared-documents-mcp-"));
if (!existsSync(serverPath)) {
  throw new Error(`MCP server entrypoint is missing at ${serverPath}. Run the build first.`);
}

const expectedTools = ["read_shared_document", "create_shared_document", "update_shared_document"];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: workspaceRoot,
  env: {
    ...process.env,
    STORAGE_ROOT: storageRoot,
    REPO_DISCORD_IDENTITIES_PATH: resolve(workspaceRoot, ".voidbot", "private", "repo-discord-identities.json"),
    VOIDBOT_REPO_FACE_IDENTITY: "nibu",
    VOIDBOT_MCP_TOOL_ALLOWLIST: expectedTools.join(","),
  },
  stderr: "pipe",
});
const client = new Client({ name: "voidbot-shared-documents-smoke", version: "0.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedTools].sort())) {
    throw new Error(`Unexpected shared-document tool surface: ${names.join(", ")}`);
  }

  const created = await client.callTool({
    name: "create_shared_document",
    arguments: { documentId: "shared-scratch", title: "Shared scratch", body: "First mark" },
  });
  assertOk(created, "create_shared_document");
  if (created.structuredContent?.document?.createdBy !== "nibu") {
    throw new Error("MCP server did not stamp the active Face identity on create.");
  }

  const read = await client.callTool({ name: "read_shared_document", arguments: { documentId: "shared-scratch" } });
  assertOk(read, "read_shared_document");
  if (read.structuredContent?.document?.version !== 1) {
    throw new Error("MCP read did not return the created revision.");
  }

  const updated = await client.callTool({
    name: "update_shared_document",
    arguments: { documentId: "shared-scratch", body: "Second mark", expectedVersion: 1 },
  });
  assertOk(updated, "update_shared_document");
  if (updated.structuredContent?.document?.version !== 2) {
    throw new Error("MCP update did not advance the revision.");
  }

  process.stdout.write(`${JSON.stringify({ ok: true, tools: names, document: updated.structuredContent?.document })}\n`);
} finally {
  await client.close();
  await rm(storageRoot, { recursive: true, force: true });
}

function assertOk(result, tool) {
  if (result.isError) {
    const text = (result.content ?? []).map((entry) => entry.type === "text" ? entry.text : "").join("\n");
    throw new Error(`${tool} failed: ${text}`);
  }
}
