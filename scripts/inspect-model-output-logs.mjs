#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hours = Number.parseFloat(options["since-hours"] ?? "1");
  const sinceMs = Date.now() - Math.max(0.01, hours) * 60 * 60 * 1000;
  const logPath = resolve(repoRoot, options.log ?? ".voidbot/logs/model-outputs.jsonl");
  const markdownOut = resolve(repoRoot, options.out ?? ".voidbot/status/model-output-inspection.md");
  const jsonOut = resolve(repoRoot, options["json-out"] ?? ".voidbot/status/model-output-inspection.json");
  const records = (await readJsonl(logPath))
    .filter((record) => Date.parse(String(record.loggedAt ?? record.finishedAt ?? "")) >= sinceMs);
  const findings = inspect(records);
  const report = {
    generatedAt: new Date().toISOString(),
    logPath,
    sinceHours: hours,
    recordCount: records.length,
    ...findings,
  };

  await mkdir(dirname(markdownOut), { recursive: true });
  await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownOut, renderMarkdown(report), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, markdownOut, jsonOut, recordCount: records.length, warningCount: findings.warnings.length }, null, 2)}\n`);
}

async function readJsonl(path) {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { malformed: true, raw: line };
        }
      });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function inspect(records) {
  const warnings = [];
  const byModel = countBy(records, (record) => record.model ?? "(unknown)");
  const byCommand = countBy(records, (record) => record.command ?? "(unknown)");
  const byPrompt = countBy(records, (record) => record.promptMarker ?? "(none)");
  const failures = records.filter((record) => record.exitCode !== 0 || record.timedOut || record.handoffReason);
  const noFinalMessage = records.filter((record) => !String(record.finalMessage ?? "").trim());
  const forbiddenToolRecords = records.filter((record) =>
    (record.toolCalls ?? []).some((call) =>
      ["read_repo_face_state", "list_mcp_resources", "read_mcp_resource", "post_repo_identity_message", "apply_repo_face_state_operation", "notify_owner"].includes(call.tool),
    ),
  );
  const speechSmells = records.filter((record) =>
    /repo-face heartbeat|heartbeat from|bright bridge note|tiny fish sorting note|librarian note|maintenance pass/i.test(String(record.finalMessage ?? "")),
  );
  const quotaSignals = records.filter((record) =>
    /quota|rate limit|rate-limit|usage limit|capacity|too many requests|(?:http|status|code|error)\s*429|429\s*(?:too many requests|rate)|insufficient_quota|model.*unavailable|model.*access|limit exceeded/i.test(
      `${record.stderrTail ?? ""}\n${record.stdoutTail ?? ""}\n${record.handoffReason ?? ""}`,
    ),
  );

  pushWarning(warnings, failures.length, "model run failures/timeouts/handoffs", failures);
  pushWarning(warnings, noFinalMessage.length, "model runs with no final message", noFinalMessage);
  pushWarning(warnings, forbiddenToolRecords.length, "Face/model runs using forbidden substrate tools", forbiddenToolRecords);
  pushWarning(warnings, speechSmells.length, "robotic/provenance speech smells", speechSmells);
  pushWarning(warnings, quotaSignals.length, "quota/rate/capacity fallback signals", quotaSignals);

  return {
    byModel,
    byCommand,
    byPrompt,
    failures: summarizeRecords(failures),
    noFinalMessage: summarizeRecords(noFinalMessage),
    forbiddenToolRecords: summarizeRecords(forbiddenToolRecords),
    speechSmells: summarizeRecords(speechSmells),
    quotaSignals: summarizeRecords(quotaSignals),
    warnings,
    recent: summarizeRecords(records.slice(-12)),
  };
}

function pushWarning(warnings, count, label, records) {
  if (count <= 0) {
    return;
  }
  warnings.push({
    label,
    count,
    examples: summarizeRecords(records.slice(0, 5)),
  });
}

function summarizeRecords(records) {
  return records.map((record) => ({
    loggedAt: record.loggedAt ?? null,
    jobId: record.jobId ?? null,
    command: record.command ?? null,
    turn: record.turn ?? null,
    model: record.model ?? null,
    promptMarker: record.promptMarker ?? null,
    exitCode: record.exitCode ?? null,
    timedOut: Boolean(record.timedOut),
    handoffReason: record.handoffReason ?? null,
    tools: (record.toolCalls ?? []).map((call) => call.tool).filter(Boolean),
    finalPreview: preview(record.finalMessage ?? record.stdoutTail ?? ""),
  }));
}

function countBy(records, keyFn) {
  const counts = {};
  for (const record of records) {
    const key = String(keyFn(record));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function preview(value) {
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

function renderMarkdown(report) {
  const lines = [
    "# Model Output Inspection",
    "",
    `Generated: ${report.generatedAt}`,
    `Window: last ${report.sinceHours} hour(s)`,
    `Log: ${report.logPath}`,
    `Records: ${report.recordCount}`,
    "",
    "## Counts",
    "",
    `- By model: ${formatCounts(report.byModel)}`,
    `- By command: ${formatCounts(report.byCommand)}`,
    `- By prompt: ${formatCounts(report.byPrompt)}`,
    "",
    "## Warnings",
    "",
  ];

  if (report.warnings.length === 0) {
    lines.push("- No inspection warnings in this window.");
  } else {
    for (const warning of report.warnings) {
      lines.push(`- ${warning.label}: ${warning.count}`);
      for (const example of warning.examples) {
        lines.push(`  - ${example.loggedAt} ${example.model} ${example.command} ${example.promptMarker}: ${example.finalPreview || example.handoffReason || "(no preview)"}`);
      }
    }
  }

  lines.push("", "## Recent Records", "");
  for (const record of report.recent) {
    lines.push(`- ${record.loggedAt} ${record.model} ${record.command} ${record.promptMarker} tools=[${record.tools.join(", ")}]`);
    if (record.finalPreview) {
      lines.push(`  ${record.finalPreview}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${value}`).join(", ")
    : "(none)";
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

await main();
