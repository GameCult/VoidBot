#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const requiredSelfStateDocumentTypes = [
  "void.self_profile",
  "void.moderation_cursor",
  "void.speech_receipts",
  "void.thought_memory",
  "void.scheduled_runtime",
  "void.agency_pressure",
  "void.candidate_interventions",
  "void.persona_affect",
];
const requiredSelfStateSchemaFingerprint =
  `void-self-state.v1:${requiredSelfStateDocumentTypes.join("|")}`;

const workspaceRoot = resolve(process.cwd());
const serverPath = resolve(workspaceRoot, "apps", "worker", "dist", "mcp-server.js");
const identity = readArg("--identity") ?? "nibu";

if (!existsSync(serverPath)) {
  throw new Error(`MCP server entrypoint is missing at ${serverPath}. Run npm run build first.`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: workspaceRoot,
  env: {
    ...process.env,
    VOIDBOT_WORKSPACE_ROOT: workspaceRoot,
  },
  stderr: "pipe",
});

const client = new Client({
  name: "voidbot-repo-persona-affect-smoke",
  version: "0.0.0",
});

try {
  await client.connect(transport);
  const runtimeResult = await client.callTool({
    name: "get_voidbot_runtime_info",
    arguments: {},
  });
  assertRuntimeInfo(runtimeResult);

  const result = await client.callTool({
    name: "read_repo_persona_state",
    arguments: { identity },
  });

  if (result.isError) {
    throw new Error(renderToolText(result) || `read_repo_persona_state returned isError for ${identity}.`);
  }

  const structured = result.structuredContent;
  const typedState = structured?.typedState;
  const personaAffect = typedState?.personaAffect;

  if (!personaAffect || typeof personaAffect !== "object") {
    throw new Error(`read_repo_persona_state did not expose typedState.personaAffect for ${identity}.`);
  }

  for (const field of ["needs", "socialBonds", "statusReads", "moodDimensions", "stressResponses"]) {
    if (!Array.isArray(personaAffect[field])) {
      throw new Error(`typedState.personaAffect.${field} is not an array for ${identity}.`);
    }
  }

  const renderedText = renderToolText(result);
  if (/No schema is registered for persisted document type "void\.persona_affect"/i.test(renderedText)) {
    throw new Error("MCP Persona-state read still lacks the void.persona_affect document schema.");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    identity,
    personaStatePath: structured?.personaStatePath,
    affect: {
      needs: personaAffect.needs.length,
      socialBonds: personaAffect.socialBonds.length,
      statusReads: personaAffect.statusReads.length,
      moodDimensions: personaAffect.moodDimensions.length,
      stressResponses: personaAffect.stressResponses.length,
    },
  }, null, 2)}\n`);
} finally {
  await client.close();
}

function assertRuntimeInfo(result) {
  if (result.isError) {
    throw new Error(renderToolText(result) || "get_voidbot_runtime_info returned isError.");
  }
  const runtimeInfo = result.structuredContent;
  if (!runtimeInfo || typeof runtimeInfo !== "object") {
    throw new Error("get_voidbot_runtime_info did not return structured runtime info.");
  }
  if (runtimeInfo.selfStateSchemaFingerprint !== requiredSelfStateSchemaFingerprint) {
    throw new Error(
      `VoidBot MCP self-state schema fingerprint mismatch. Expected ${requiredSelfStateSchemaFingerprint}, got ${runtimeInfo.selfStateSchemaFingerprint ?? "(missing)"}.`,
    );
  }
  const documentTypes = runtimeInfo.selfStateDocumentTypes;
  if (!Array.isArray(documentTypes)) {
    throw new Error("VoidBot MCP runtime info did not expose selfStateDocumentTypes.");
  }
  for (const documentType of requiredSelfStateDocumentTypes) {
    if (!documentTypes.includes(documentType)) {
      throw new Error(`VoidBot MCP runtime is missing self-state document type ${documentType}.`);
    }
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function renderToolText(result) {
  return (result.content ?? [])
    .map((entry) => entry.type === "text" ? entry.text : "")
    .filter(Boolean)
    .join("\n");
}
