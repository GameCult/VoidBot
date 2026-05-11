import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "config/moderation-review-agent.md",
  "config/discord-server-rules.md",
  "config/moderation-agent-state-template.json",
  "styles/void-default.md",
  ".voidbot/private/moderation-agent-state.json",
];

function readTextFileFlexible(path) {
  const buffer = readFileSync(path);

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buffer.subarray(3));
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }

  return new TextDecoder("utf-8").decode(buffer);
}

const sections = targets.map((relativePath) => {
  const absolutePath = resolve(repoRoot, relativePath);
  const content = readTextFileFlexible(absolutePath).replace(/\r\n/g, "\n");
  return `=== ${relativePath} ===\n${content.trimEnd()}\n`;
});

process.stdout.write(`${sections.join("\n")}\n`);
