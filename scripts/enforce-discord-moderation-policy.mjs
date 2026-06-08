import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const POLICY = {
  safety_threat: { strikeExpiresDays: 365, instantBanTags: ["severity:instaban"], threeStrike: true },
  weaponized_intimidation: { strikeExpiresDays: 365, instantBanTags: ["severity:instaban"], threeStrike: true },
  stalking_or_doxxing: { strikeExpiresDays: 365, instantBanTags: ["severity:instaban"], threeStrike: true },
  sexual_boundary_violation: { strikeExpiresDays: 365, instantBanTags: ["severity:instaban"], threeStrike: true },
  bigotry_identity_attack: { strikeExpiresDays: 180, instantBanTags: ["severity:instaban"], threeStrike: true },
  bad_faith_argument: { strikeExpiresDays: 90, instantBanTags: ["severity:instaban"], threeStrike: true },
  nsfw_channel_violation: { strikeExpiresDays: 30, instantBanTags: ["severity:instaban"], threeStrike: true },
  spam_or_deceptive_promotion: { strikeExpiresDays: 30, instantBanTags: ["severity:instaban"], threeStrike: true },
  moderator_obstruction: { strikeExpiresDays: 90, instantBanTags: ["severity:instaban"], threeStrike: true },
  empty_words_noise: { strikeExpiresDays: 14, instantBanTags: ["severity:instaban"], threeStrike: true },
  values_debate_escalation: { strikeExpiresDays: 14, instantBanTags: ["severity:instaban"], threeStrike: true },
  pg13_language_violation: { strikeExpiresDays: 14, instantBanTags: ["severity:instaban"], threeStrike: true },
  event_time_coordination: { strikeExpiresDays: 14, instantBanTags: ["severity:instaban"], threeStrike: true },
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = normalizeMode(options.mode ?? readLocalEnv().VOID_MODERATION_ENFORCEMENT_MODE ?? "log_only");
  const operations = await readOperations(options.operationsFile);
  const newCases = operations
    .filter((operation) => operation?.operation === "upsert_open_case" && operation.case)
    .map((operation) => operation.case);

  if (newCases.length === 0) {
    writeJson({ ok: true, mode, status: "no_new_cases", actions: [] });
    return;
  }

  const state = await loadTypedState(options.stateFile);
  const actions = [];
  for (const moderationCase of newCases) {
    const action = await evaluateCase({ moderationCase, state, mode, dryRun: options.dryRun });
    if (action) {
      actions.push(action);
    }
  }

  writeJson({
    ok: actions.every((action) => action.ok !== false),
    mode,
    status: actions.length > 0 ? "evaluated" : "no_policy_action",
    actions,
  });
}

function parseArgs(args) {
  const options = {
    stateFile: undefined,
    operationsFile: undefined,
    mode: undefined,
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--state-file":
        options.stateFile = args[index + 1];
        index += 1;
        break;
      case "--operations-file":
        options.operationsFile = args[index + 1];
        index += 1;
        break;
      case "--mode":
        options.mode = args[index + 1];
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.stateFile) {
    throw new Error("Provide --state-file.");
  }
  if (!options.operationsFile) {
    throw new Error("Provide --operations-file.");
  }
  return options;
}

async function evaluateCase({ moderationCase, state, mode, dryRun }) {
  const tags = new Set((moderationCase.tags ?? []).map((tag) => String(tag).toLowerCase()));
  const infringementType = getTagValue(tags, "infringement:");
  if (!infringementType || !POLICY[infringementType]) {
    return {
      ok: true,
      status: "skipped",
      reason: "missing_or_unknown_infringement_type",
      sourceMessageId: moderationCase.sourceMessageId,
      tags: [...tags],
    };
  }

  if (!moderationCase.authorId) {
    return {
      ok: true,
      status: "skipped",
      reason: "missing_author_id",
      sourceMessageId: moderationCase.sourceMessageId,
      infringementType,
    };
  }

  if (hasActionedTag(tags)) {
    return {
      ok: true,
      status: "skipped",
      reason: "already_actioned",
      sourceMessageId: moderationCase.sourceMessageId,
      infringementType,
    };
  }

  const policy = POLICY[infringementType];
  const isInstantBan = tags.has("moderation:instaban") ||
    policy.instantBanTags.some((tag) => tags.has(tag));
  const strikeCount = countActiveStrikes({
    cases: state.moderationCursor?.openCases ?? [],
    authorId: moderationCase.authorId,
    infringementType,
    expiresDays: policy.strikeExpiresDays,
    now: new Date(),
  });
  const isThirdStrike = tags.has("moderation:strike") && policy.threeStrike && strikeCount >= 3;

  if (isInstantBan || isThirdStrike) {
    const reason = isInstantBan
      ? `VoidBot instaban: ${infringementType} at ${moderationCase.sourceMessageId}`
      : `VoidBot three-strike ban: ${infringementType} strike ${strikeCount}/3 at ${moderationCase.sourceMessageId}`;
    const moderationResult = await invokeModerationAction({
      action: "ban",
      userId: moderationCase.authorId,
      reason,
      mode,
      dryRun,
    });
    await closeCase({
      stateFile: state.__stateFile,
      sourceMessageId: moderationCase.sourceMessageId,
      status: "resolved",
      resolutionSummary: `${isInstantBan ? "Instaban" : "Three-strike ban"} applied for ${infringementType}.`,
      dryRun,
    });
    return {
      ok: true,
      status: isInstantBan ? "instaban_applied" : "three_strike_ban_applied",
      sourceMessageId: moderationCase.sourceMessageId,
      authorId: moderationCase.authorId,
      infringementType,
      strikeCount,
      strikeExpiresDays: policy.strikeExpiresDays,
      moderationResult,
    };
  }

  if (tags.has("moderation:strike")) {
    await closeCase({
      stateFile: state.__stateFile,
      sourceMessageId: moderationCase.sourceMessageId,
      status: "resolved",
      resolutionSummary: `Strike ${strikeCount}/3 recorded for ${infringementType}; expires after ${policy.strikeExpiresDays} days without another matching strike.`,
      dryRun,
    });
    return {
      ok: true,
      status: "strike_recorded",
      sourceMessageId: moderationCase.sourceMessageId,
      authorId: moderationCase.authorId,
      infringementType,
      strikeCount,
      strikeExpiresDays: policy.strikeExpiresDays,
    };
  }

  return {
    ok: true,
    status: "case_recorded_no_sanction",
    sourceMessageId: moderationCase.sourceMessageId,
    authorId: moderationCase.authorId,
    infringementType,
    strikeCount,
    strikeExpiresDays: policy.strikeExpiresDays,
  };
}

function countActiveStrikes({ cases, authorId, infringementType, expiresDays, now }) {
  const cutoffMs = now.getTime() - expiresDays * 24 * 60 * 60 * 1000;
  return cases.filter((entry) => {
    if (entry.authorId !== authorId) {
      return false;
    }
    const tags = new Set((entry.tags ?? []).map((tag) => String(tag).toLowerCase()));
    if (!tags.has(`infringement:${infringementType}`) || !tags.has("moderation:strike")) {
      return false;
    }
    const timestampMs = Date.parse(entry.createdAt ?? entry.lastTouchedAt ?? "");
    return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
  }).length;
}

async function invokeModerationAction({ action, userId, reason, mode, dryRun }) {
  if (["off", "disabled", "log_only", "log-only", "case_only", "case-only"].includes(mode)) {
    return { ok: true, status: "skipped", reason: "enforcement_mode_non_destructive", action, userId };
  }
  if (mode === "notify_owner") {
    return { ok: true, status: "skipped", reason: "notify_owner_does_not_apply_discord_sanctions", action, userId };
  }
  if (!["policy", "enforce_policy", "enforce-policy", "ban"].includes(mode)) {
    return { ok: true, status: "skipped", reason: `mode_${mode}_does_not_apply_policy_bans`, action, userId };
  }

  const args = [
    resolve(repoRoot, "scripts", "moderate-discord-user.mjs"),
    "--action", action,
    "--user-id", userId,
    "--reason", reason,
  ];
  if (dryRun) {
    args.push("--dry-run");
  }
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Discord moderation action failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function closeCase({ stateFile, sourceMessageId, status, resolutionSummary, dryRun }) {
  if (dryRun) {
    return;
  }
  const tempRoot = mkdtempSync(resolve(tmpdir(), "void-policy-close-"));
  const operationPath = resolve(tempRoot, "operation.json");
  try {
    writeFileSync(operationPath, `${JSON.stringify({
      operation: "close_open_case",
      sourceMessageId,
      status,
      resolvedAt: new Date().toISOString(),
      resolutionSummary,
    }, null, 2)}\n`, "utf8");
    const result = spawnSync(process.execPath, [
      resolve(repoRoot, "scripts", "void-self-state.mjs"),
      "apply-operation",
      "--canonical", stateFile,
      "--operation-file", operationPath,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`Failed to close moderation case: ${result.stderr || result.stdout}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function normalizeMode(value) {
  return String(value).trim().toLowerCase();
}

function getTagValue(tags, prefix) {
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      return tag.slice(prefix.length);
    }
  }
  return undefined;
}

function hasActionedTag(tags) {
  for (const tag of tags) {
    if (tag.startsWith("moderation:actioned")) {
      return true;
    }
  }
  return false;
}

async function readOperations(path) {
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) {
    return [];
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function loadTypedState(stateFile) {
  const script = `
const core = require('./packages/core/dist');
core.loadVoidSelfStateTypedDocuments({ canonicalPath: process.argv[1] })
  .then((state) => console.log(JSON.stringify(state)))
  .catch((error) => { console.error(error); process.exit(1); });
`;
  const result = spawnSync(process.execPath, ["-e", script, stateFile], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to load typed state: ${result.stderr || result.stdout}`);
  }
  return { ...JSON.parse(result.stdout), __stateFile: stateFile };
}

function readLocalEnv() {
  const envPath = resolve(repoRoot, ".env");
  const parsed = { ...process.env };
  try {
    const raw = stripLeadingBom(readTextFileFlexible(envPath));
    Object.assign(parsed, parseDotEnv(raw));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return parsed;
}

function parseDotEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    result[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim();
  }
  return result;
}

function readTextFileFlexible(path) {
  const buffer = readFileSync(path);
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(buffer);
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(buffer);
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

function stripLeadingBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

await main();
