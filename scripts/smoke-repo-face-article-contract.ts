import {
  normalizeArticlePath,
  renderRepoIdentityArticleMarkdown,
  resolveArticleRepoRoot,
  validateRenderedArticleMarkdown,
  type RepoIdentityArticleIntent,
} from "../apps/worker/src/repo-face-article";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const nibuIdentity = {
  displayName: "Nibu",
  repoName: "AetheriaLore",
  repoPath: "E:/Projects/AetheriaLore",
};

const aetheriaIntent: RepoIdentityArticleIntent = {
  identity: "nibu",
  site: "aetheria",
  title: "Timeline Smearing And The Bodies It Steals",
  description: "Nibu's bylined argument about adjacent-timeline survival pressure.",
  author: "Nibu",
  date: "2026-05-22",
  tags: ["Aetheria", "Nibu", "glitchcraft"],
  body: [
    "---",
    "title: Wrong",
    "---",
    "",
    "## The rude part",
    "",
    "Resetting is not a save button. It is a change of which incarnation has to pay attention.",
  ].join("\n"),
};

const aetheriaPath = normalizeArticlePath(aetheriaIntent, nibuIdentity);
assert(
  aetheriaPath === "Aetheria/Articles/nibu/2026-05-22-timeline-smearing-and-the-bodies-it-steals.md",
  `unexpected Aetheria article path: ${aetheriaPath}`,
);

const markdown = renderRepoIdentityArticleMarkdown(aetheriaIntent, nibuIdentity);
validateRenderedArticleMarkdown(markdown, aetheriaIntent);
assert(markdown.startsWith("---\n"), "article markdown should start with deterministic frontmatter");
assert(markdown.includes('title: "Timeline Smearing And The Bodies It Steals"'), "title frontmatter missing");
assert(markdown.includes('description: "Nibu\'s bylined argument'), "description frontmatter missing");
assert(markdown.includes('author: "Nibu"'), "author frontmatter missing");
assert(markdown.includes("date: 2026-05-22"), "date frontmatter missing");
assert(markdown.includes('  - "glitchcraft"'), "tag frontmatter missing");
assert(!markdown.includes("title: Wrong"), "model-provided frontmatter should be stripped from body");

const aquaIdentity = {
  displayName: "Aqua",
  repoName: "AquaSynth",
  repoPath: "E:/Projects/AquaSynth",
};
const gamecultIntent: RepoIdentityArticleIntent = {
  identity: "aqua",
  title: "A Tiny Fish Demands Better Patch Cards",
  description: "Aqua's bylined note about readable synth progress artifacts.",
  date: "2026-05-22",
  tags: [],
  body: "A patch card is a promise the ear can cash.",
};
const gamecultPath = normalizeArticlePath(gamecultIntent, aquaIdentity);
assert(
  gamecultPath === "GameCult/Blog/2026-05-22-a-tiny-fish-demands-better-patch-cards.md",
  `unexpected GameCult blog path: ${gamecultPath}`,
);
const gamecultRoot = resolveArticleRepoRoot(gamecultIntent, aquaIdentity, {
  sourceRepoRoot: "E:/Projects",
  storageRoot: "E:/Projects/VoidBot/.voidbot",
});
assert(gamecultRoot.replace(/\\/g, "/").endsWith("/gamecult-site"), `unexpected GameCult root: ${gamecultRoot}`);

let rejected = false;
try {
  normalizeArticlePath({ ...gamecultIntent, path: "AquaSynth/Notes/bad.md" }, aquaIdentity);
} catch {
  rejected = true;
}
assert(rejected, "GameCult article path outside GameCult/Blog should be rejected");

console.log("repo Face article contract smoke passed");
