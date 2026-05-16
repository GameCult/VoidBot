import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { labelNoiseTokens, stopwords } from "./void-memory-organ-constants.mjs";

export function topKeywords(text, limit) {
  const counts = new Map();

  for (const token of tokenize(text)) {
    if (stopwords.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([token]) => token);
}

export function tokenize(input) {
  return String(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

export function ensureMemoryId(entry, kind, text) {
  const existing = readString(entry, "memoryId");
  if (existing) {
    return existing;
  }

  const timestamp = readString(entry, "timestamp") ?? readString(entry, "lastObservedAt") ?? "undated";
  return `${kind}-${hashString(`${timestamp}|${text}`).slice(0, 12)}`;
}

export function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizePreferredThoughtLabel(label) {
  const normalized = normalizeText(label)
    .replace(/^Why\s+/i, "")
    .replace(/\s+keeps\s+resurfacing$/i, "")
    .replace(/^What\s+/i, "")
    .replace(/\s+is\s+trying\s+to\s+become$/i, "")
    .trim();

  if (!normalized) {
    return null;
  }

  if (looksKeywordSalad(normalized)) {
    return null;
  }

  if (/\b(still matters|current room need|change a real machine)\b/i.test(normalized)) {
    return null;
  }

  if (looksPersonLikeSingleton(normalized)) {
    return null;
  }

  return normalized;
}

export function looksKeywordSalad(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.split(",").length >= 3) {
    return true;
  }
  const tokens = tokenize(normalized).filter((token) => !stopwords.has(token));
  if (tokens.length === 0) {
    return true;
  }
  const longTokens = tokens.filter((token) => token.length >= 5);
  return tokens.length >= 3 && longTokens.length === 0;
}

export function looksPersonLikeSingleton(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  if (normalized.includes(":") || normalized.includes(" ")) {
    return false;
  }
  if (!/^[A-Z][a-zA-Z0-9_-]+$/.test(normalized)) {
    return false;
  }
  return normalized.length >= 4;
}

export function selectRecentRecords(entries, { limit, quietLimit }) {
  const recent = ensureArray(entries).slice(-Math.max(limit * 3, limit));
  const quiet = [];
  const active = [];

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index];
    if (!isObject(entry)) {
      continue;
    }

    const text = normalizeText([
      readString(entry, "summary"),
      readString(entry, "claim"),
      readString(entry, "topic"),
      readString(entry, "counterweight"),
    ].filter(Boolean).join(" | "));

    if (isLowSignalQuietRoomText(text)) {
      if (quiet.length < quietLimit) {
        quiet.unshift(entry);
      }
      continue;
    }

    if (active.length < limit - quietLimit) {
      active.unshift(entry);
    }
  }

  return [...active, ...quiet].slice(-limit);
}

export function isLowSignalQuietRoomText(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return false;
  }

  const quietSignals = [
    "no new discord",
    "no fresh discord",
    "no new messages",
    "no fresh live traffic",
    "no live moderation",
    "no moderation smoke",
    "no owner escalation",
    "room was empty",
    "room is idle",
    "there was no live moderation pressure",
    "nothing got posted",
    "no discord post",
  ];

  let matches = 0;
  for (const signal of quietSignals) {
    if (normalized.includes(signal)) {
      matches += 1;
    }
  }

  return matches >= 2;
}

export function overlapRatio(left, right) {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  let overlap = 0;

  for (const value of right) {
    if (leftSet.has(value)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(left.length, right.length);
}

export function mergeStringArrays(left, right) {
  return [...new Set([...ensureStringArray(left), ...ensureStringArray(right)])];
}

export function newestIsoTimestamp(left, right) {
  const leftTime = parseIsoTimestamp(left);
  const rightTime = parseIsoTimestamp(right);
  if (leftTime === null) {
    return rightTime === null ? undefined : right;
  }
  if (rightTime === null) {
    return left;
  }
  return leftTime >= rightTime ? left : right;
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function looksLegacyThoughtSurface(label, summary) {
  return (
    /\//.test(label) ||
    /^Recurring seam across /i.test(summary) ||
    /^Dream-compressed a seam around /i.test(summary) ||
    /^Self-facing seam around /i.test(summary) ||
    /^Archive-facing seam around /i.test(summary) ||
    /What part of this thought wants embodiment/i.test(summary)
  );
}

export function parseIsoTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function hashString(input) {
  return createHash("sha1").update(String(input)).digest("hex");
}

export function parseDotEnvSafe(path) {
  try {
    return parseDotEnv(stripBom(readFileSync(path, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function parseDotEnv(raw) {
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

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

export function readInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function ensureObject(value) {
  return isObject(value) ? value : {};
}

export function ensureStringArray(value) {
  return ensureArray(value).filter((entry) => typeof entry === "string");
}

export function readString(value, key) {
  return isObject(value) && typeof value[key] === "string" ? value[key] : undefined;
}

export function readNumber(value, key) {
  return isObject(value) && typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

export function readBoolean(value, key) {
  return isObject(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function stripBom(input) {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compactNarrative(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return normalized;
  }
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  const candidate = firstSentence && firstSentence.length >= 24 ? firstSentence : normalized;
  return candidate.length > 220 ? `${candidate.slice(0, 217).trimEnd()}...` : candidate;
}

export function compactLabel(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return normalized;
  }
  if (/incremental sweep found/i.test(normalized)) {
    const repoMatch = normalized.match(/`([^`]+)`/);
    const repoName = repoMatch?.[1] ?? "repo";
    return `${repoName} repo sweep`;
  }
  if (/no new discord traffic|one new discord message|no messages arrived/i.test(normalized)) {
    return "room pass";
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93).trimEnd()}...` : normalized;
}

export function capDistinctStrings(entries, limit) {
  return [...new Set(ensureStringArray(entries))].slice(0, limit);
}

export function compareMemoryFreshness(left, right) {
  const leftTime = parseIsoTimestamp(readString(left, "lastObservedAt") ?? readString(left, "timestamp") ?? "") ?? 0;
  const rightTime = parseIsoTimestamp(readString(right, "lastObservedAt") ?? readString(right, "timestamp") ?? "") ?? 0;
  return rightTime - leftTime;
}

export function appendClause(existing, clause) {
  const left = normalizeText(existing);
  const right = normalizeText(clause);
  if (!left) {
    return right;
  }
  if (!right || left.includes(right)) {
    return left;
  }
  return `${left} ${right}`;
}

export function topicSimilarity(left, right) {
  const leftTokens = topConceptKeywords(left ?? "", 6);
  const rightTokens = topConceptKeywords(right ?? "", 6);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftSet.size, rightSet.size);
}

export function getValueObjects(values) {
  return ensureArray(values).filter(isObject);
}

export function topConceptKeywords(text, limit) {
  const counts = new Map();

  for (const token of tokenize(text)) {
    if (stopwords.has(token) || labelNoiseTokens.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return right[0].length - left[0].length;
    })
    .slice(0, limit)
    .map(([token]) => token);
}

export function mapCountEntries(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => right.count - left.count);
}
