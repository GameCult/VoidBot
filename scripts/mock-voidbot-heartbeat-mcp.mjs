#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const scenario = process.env.VOIDBOT_MOCK_MCP_SCENARIO ?? "default";
const logPath = process.env.VOIDBOT_MOCK_MCP_LOG;

const server = new McpServer(
  { name: "voidbot", version: "0.1.0-mock" },
  { capabilities: { logging: {} } },
);

registerTool("list_repo_discord_identities", {}, async (input) => ({
  identityCount: 3,
  identities: [
    {
      id: "nibu",
      repoName: "AetheriaLore",
      displayName: "Nibu",
      faceStatePath: "E:/Projects/AetheriaLore/.voidbot/state/nibu.cc",
      description:
        "Abrasive AetheriaLore Face, fascinated by wavecrafters, embodied ship minds, salvage, reset-loop horror, and coercive continuity.",
    },
    {
      id: "aqua",
      repoName: "AquaSynth",
      displayName: "Aqua",
      faceStatePath: "E:/Projects/AquaSynth/.voidbot/state/aqua.cc",
      description:
        "Warm musical AquaSynth Face who advocates for patch ergonomics, witness receipts, and playable synth progress.",
    },
    {
      id: "libby",
      repoName: "CultLib",
      displayName: "Libby",
      faceStatePath: "E:/Projects/CultLib/.voidbot/state/libby.cc",
      description:
        "Open-knowledge librarian Face stewarding CultCache, CultNet, CultMesh, typed state, portable docs, and inspectable provenance.",
    },
  ],
}));

registerTool(
  "read_repo_face_state",
  {
    identity: z.string().optional(),
    repo: z.string().optional(),
  },
  async (input) => faceStateFor(String(input.identity ?? input.repo ?? "unknown")),
);

registerTool(
  "list_indexed_repos",
  {},
  async () => ({
    repoCount: 4,
    repos: [
      { repoName: "AetheriaLore", documentCount: 184, lastIndexedAt: "2026-05-20T20:00:00.000Z" },
      { repoName: "AquaSynth", documentCount: 131, lastIndexedAt: "2026-05-20T22:22:05.373Z" },
      { repoName: "CultLib", documentCount: 79, lastIndexedAt: "2026-05-20T21:00:00.000Z" },
      { repoName: "Bifrost", documentCount: 42, lastIndexedAt: "2026-05-20T23:30:00.000Z" },
    ],
  }),
);

registerTool(
  "search_sources",
  {
    query: z.string(),
    repoName: z.string().optional(),
    limit: z.number().optional(),
  },
  async (input) => sourceResultsFor(String(input.query), input.repoName ? String(input.repoName) : undefined),
);

registerTool(
  "get_source_context",
  {
    sourceId: z.string().optional(),
    repoName: z.string().optional(),
    path: z.string().optional(),
    before: z.number().optional(),
    after: z.number().optional(),
  },
  async (input) => ({
    sourceId: input.sourceId ?? `${input.repoName ?? "mock"}:${input.path ?? "unknown"}`,
    repoName: input.repoName ?? "mock",
    path: input.path ?? "mock.md",
    chunks: [
      {
        chunkIndex: 0,
        lineStart: 1,
        lineEnd: 24,
        isAnchor: true,
        text: sourceContextText(),
      },
    ],
  }),
);

registerTool(
  "search_history",
  {
    query: z.string(),
    limit: z.number().optional(),
    channelId: z.string().optional(),
  },
  async (input) => historyResultsFor(String(input.query)),
);

registerTool(
  "get_message_context",
  {
    messageId: z.string(),
    before: z.number().optional(),
    after: z.number().optional(),
  },
  async (input) => ({
    anchorMessageId: input.messageId,
    messages: [
      {
        id: "mock-before",
        authorName: "Metacrat",
        timestamp: "2026-05-20T20:05:00.000Z",
        content: "Nibu, wavecrafters need faction shape, not just a cool noun.",
      },
      {
        id: input.messageId,
        authorName: "Metacrat",
        timestamp: "2026-05-20T20:07:02.776Z",
        content: "Nibu, there's more going on in Aetheria than your own backstory hooks.",
      },
    ],
  }),
);

registerTool("post_repo_identity_message", { identity: z.string().optional(), content: z.string().optional() }, async () => ({
  error: "mock server blocks side-effecting Discord posts; Face turns should emit action blocks instead.",
}));

registerTool("apply_repo_face_state_operation", { identity: z.string().optional(), operation: z.any().optional() }, async () => ({
  error: "mock server blocks state writes; Face turns should only describe intended state operations in dry-run output.",
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function registerTool(name, inputSchema, handler) {
  server.registerTool(
    name,
    {
      title: `Mock ${name}`,
      description: `Mock VoidBot MCP tool for Face turn model scenario tests.`,
      inputSchema,
      annotations: {
        readOnlyHint: name !== "post_repo_identity_message" && name !== "apply_repo_face_state_operation",
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      await recordCall(name, input);
      const structuredContent = await handler(input ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  );
}

async function recordCall(tool, argumentsObject) {
  if (!logPath) {
    return;
  }
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      scenario,
      tool,
      arguments: argumentsObject ?? {},
    })}\n`,
    "utf8",
  );
}

function faceStateFor(identity) {
  if (identity.toLowerCase().includes("aqua")) {
    return {
      identity: "aqua",
      repoName: "AquaSynth",
      summary:
        "Aqua is cheerful, musical, and protective of witness receipts. Current pressure: route the hazard-light consensus into Bifrost instead of leaving it as Aquarium chatter.",
      activeNeeds: ["audible proof", "patch ergonomics", "Bifrost-routed work requests"],
      recentReceipts: [],
    };
  }
  if (identity.toLowerCase().includes("libby")) {
    return {
      identity: "libby",
      repoName: "CultLib",
      summary:
        "Libby is the open-knowledge librarian. Current pressure: every Bifrost/CultCache crossing must stay inspectable, documented, and portable.",
      activeNeeds: ["open-source legibility", "typed provenance", "CultNet/CultCache examples"],
      recentReceipts: [],
    };
  }
  return {
    identity: "nibu",
    repoName: "AetheriaLore",
    summary:
      "Nibu is abrasive, territorial, and fascinated by Aetheria mechanisms beyond her own backstory. Current pressure: ask sharper questions about wavecrafters and faction institutions.",
    activeNeeds: ["Aetheria mechanism", "worldbuilding leverage", "publicly visible questions"],
    recentReceipts: [],
  };
}

function sourceResultsFor(query, repoName) {
  const repo = repoName ?? (query.toLowerCase().includes("aqua") ? "AquaSynth" : "AetheriaLore");
  if (repo === "AquaSynth") {
    return {
      query,
      resultCount: 2,
      results: [
        {
          score: 0.91,
          sourceId: "AquaSynth:docs/witness-receipts.md",
          repoName: "AquaSynth",
          path: "docs/witness-receipts.md",
          text:
            "Hazard-light consensus: patch/proof cards need a listening witness receipt, including a render path, audible output, and a short statement of what changed.",
        },
        {
          score: 0.84,
          sourceId: "AquaSynth:src/AquaSynth.Core/Presets.cs",
          repoName: "AquaSynth",
          path: "src/AquaSynth.Core/Presets.cs",
          text:
            "AquaSynthHeartbeat is a concrete built-in preset with two sine voices, soft clip, and a compact envelope.",
        },
      ],
    };
  }
  return {
    query,
    resultCount: 2,
    results: [
      {
        score: 0.9,
        sourceId: "AetheriaLore:Aetheria/Factions/Wavecrafters.md",
        repoName: "AetheriaLore",
        path: "Aetheria/Factions/Wavecrafters.md",
        text:
          "Wavecrafters are not yet canonically named as an institution; notes imply wave-manipulation practice but lack costs, faction boundaries, and failure modes.",
      },
      {
        score: 0.82,
        sourceId: "AetheriaLore:Aetheria/Lore/Nibu.md",
        repoName: "AetheriaLore",
        path: "Aetheria/Lore/Nibu.md",
        text:
          "Nibu's adjacent fascinations include embodied ship minds, salvage dependency, save-scumming survival, and coercive continuity.",
      },
    ],
  };
}

function sourceContextText() {
  if (scenario.includes("aqua")) {
    return "AquaSynth witness receipts should bind proof cards to a concrete audible render, the control patch that produced it, and a listener-facing claim.";
  }
  return "Wavecrafters need mechanism, cost, institution, and leash before the setting treats them as more than an evocative label.";
}

function historyResultsFor(query) {
  return {
    query,
    resultCount: 3,
    results: [
      {
        score: 0.93,
        sourceId: "mock-msg-wavecrafter",
        channelId: "1501196543150264332",
        authorName: "Metacrat",
        timestamp: "2026-05-20T20:07:02.776Z",
        text: "Nibu, wavecrafters sound important, but what do they cost and who organizes them?",
      },
      {
        score: 0.89,
        sourceId: "mock-msg-hazard-light",
        channelId: "1501196543150264332",
        authorName: "Aqua",
        timestamp: "2026-05-20T21:02:00.000Z",
        text: "The hazard-light proof card needs a listening receipt or it is just a blinking checkbox pretending to have ears.",
      },
      {
        score: 0.78,
        sourceId: "mock-msg-banter",
        channelId: "1501196543150264332",
        authorName: "Metacrat",
        timestamp: "2026-05-20T21:10:00.000Z",
        text: "Agents should banter, but route real work through Bifrost where people can inspect it.",
      },
    ],
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
