import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const coreDistPath = resolve(repoRoot, "packages/core/dist/index.js");

if (!existsSync(coreDistPath)) {
  throw new Error(`Missing built core package at ${coreDistPath}. Run npm run build first.`);
}

const { applyVoidSelfStateOperation } = require(coreDistPath);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command !== "apply-operation") {
    throw new Error("Expected command: apply-operation.");
  }

  const canonicalPath = requirePathArg(args, "canonical");
  const operation = readOperation(args);
  const result = await applyVoidSelfStateOperation({ canonicalPath }, operation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function readOperation(args) {
  if (typeof args.operation === "string" && args.operation.trim().length > 0) {
    return JSON.parse(args.operation);
  }

  if (typeof args["operation-file"] === "string" && args["operation-file"].trim().length > 0) {
    return JSON.parse(stripLeadingBom(readFileSync(resolve(args["operation-file"]), "utf8")));
  }

  throw new Error("apply-operation requires --operation JSON or --operation-file path.");
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function requirePathArg(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required --${key} path.`);
  }

  return resolve(value);
}

function stripLeadingBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

await main();
