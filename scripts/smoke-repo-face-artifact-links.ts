import assert from "node:assert/strict";

import type { ArchivedSourceDocumentRecord } from "../packages/rag/src/source-document-archive";
import {
  resolveKnowledgebaseUrl,
  resolveRepoIdentityPostArtifactLinks,
} from "../apps/worker/src/repo-face-artifact-links";

const continuityPath = "Aetheria/Worldbuilding/Post-Elysium/Reference/Continuity Admissibility Finding.md";
const continuityUrl = "https://aetheria.gamecult.org/Worldbuilding/Post-Elysium/Reference/Continuity-Admissibility-Finding";

assert.equal(
  resolveKnowledgebaseUrl("AetheriaLore", continuityPath),
  continuityUrl,
);

assert.equal(
  resolveRepoIdentityPostArtifactLinks({
    repoName: "AetheriaLore",
    content: `The useful anchor is \`AetheriaLore:${continuityPath}\`.`,
  }),
  `The useful anchor is \`AetheriaLore:${continuityPath}\` (${continuityUrl}).`,
);

const documents: ArchivedSourceDocumentRecord[] = [
  {
    id: `AetheriaLore:${continuityPath}`,
    repoName: "AetheriaLore",
    path: continuityPath,
    title: "Continuity Admissibility Finding",
    content: "",
    normalizedContent: "",
    indexedAt: "2026-05-26T00:00:00.000Z",
  },
];

assert.equal(
  resolveRepoIdentityPostArtifactLinks({
    repoName: "AetheriaLore",
    content: "Continuity Admissibility Finding is the anchor for this thought.",
    documents,
  }),
  `Continuity Admissibility Finding is the anchor for this thought.\n\nReference: ${continuityUrl}`,
);

assert.equal(
  resolveRepoIdentityPostArtifactLinks({
    repoName: "UnknownRepo",
    content: `The useful anchor is \`UnknownRepo:${continuityPath}\`.`,
    documents,
  }),
  `The useful anchor is \`UnknownRepo:${continuityPath}\`.`,
);

console.log("repo Face artifact link smoke passed");
