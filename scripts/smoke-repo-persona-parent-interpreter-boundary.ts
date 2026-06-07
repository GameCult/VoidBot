import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workerSource = readFileSync(resolve("apps", "worker", "src", "index.ts"), "utf8");

const forbidden = [
  "routeUnparsedWouldSay",
  "extractUnconditionalWouldSay",
  "Parent interpreter fallback: routed unconditional Persona Would say.",
];

const present = forbidden.filter((needle) => workerSource.includes(needle));

if (present.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    reason: "Repo Persona parent interpreter must not route raw child Would say output when interpreter parsing fails.",
    present,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    "no raw Would say fallback route remains in worker parent-interpreter boundary",
  ],
}, null, 2));
