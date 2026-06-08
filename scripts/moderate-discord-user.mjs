import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = readLocalEnv();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const guildId = options.guildId ?? env.DISCORD_GUILD_ID?.trim();

  if (!guildId) {
    throw new Error("Provide --guild-id or configure DISCORD_GUILD_ID.");
  }
  if (!options.userId) {
    throw new Error("Provide --user-id.");
  }

  const reason = options.reason ?? "VoidBot moderation action.";
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: true,
      action: options.action,
      guildId,
      userId: options.userId,
      durationMinutes: options.durationMinutes,
      reason,
    })}\n`);
    return;
  }

  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required.");
  }

  const result = await executeModerationAction({
    botToken,
    guildId,
    userId: options.userId,
    action: options.action,
    durationMinutes: options.durationMinutes,
    reason,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseArgs(args) {
  const options = {
    action: undefined,
    guildId: undefined,
    userId: undefined,
    durationMinutes: 60,
    reason: undefined,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--action":
        options.action = args[index + 1];
        index += 1;
        break;
      case "--guild-id":
        options.guildId = args[index + 1];
        index += 1;
        break;
      case "--user-id":
        options.userId = args[index + 1];
        index += 1;
        break;
      case "--duration-minutes":
        options.durationMinutes = Number(args[index + 1]);
        index += 1;
        break;
      case "--reason":
        options.reason = args[index + 1];
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!["timeout", "ban", "kick", "remove-timeout"].includes(options.action)) {
    throw new Error("Provide --action timeout, ban, kick, or remove-timeout.");
  }
  if (!Number.isFinite(options.durationMinutes) || options.durationMinutes < 1) {
    throw new Error("--duration-minutes must be a positive number.");
  }

  return options;
}

async function executeModerationAction(input) {
  switch (input.action) {
    case "timeout":
      return timeoutMember(input);
    case "remove-timeout":
      return removeTimeout(input);
    case "ban":
      return banMember(input);
    case "kick":
      return kickMember(input);
    default:
      throw new Error(`Unsupported moderation action: ${input.action}`);
  }
}

async function timeoutMember(input) {
  const until = new Date(Date.now() + input.durationMinutes * 60_000).toISOString();
  const response = await discordFetch(input.botToken, `/guilds/${input.guildId}/members/${input.userId}`, {
    method: "PATCH",
    reason: input.reason,
    body: {
      communication_disabled_until: until,
    },
  });
  return {
    ok: true,
    action: "timeout",
    guildId: input.guildId,
    userId: input.userId,
    durationMinutes: input.durationMinutes,
    communicationDisabledUntil: until,
    status: response.status,
  };
}

async function removeTimeout(input) {
  const response = await discordFetch(input.botToken, `/guilds/${input.guildId}/members/${input.userId}`, {
    method: "PATCH",
    reason: input.reason,
    body: {
      communication_disabled_until: null,
    },
  });
  return {
    ok: true,
    action: "remove-timeout",
    guildId: input.guildId,
    userId: input.userId,
    status: response.status,
  };
}

async function banMember(input) {
  const response = await discordFetch(input.botToken, `/guilds/${input.guildId}/bans/${input.userId}`, {
    method: "PUT",
    reason: input.reason,
    body: {
      delete_message_seconds: 0,
    },
  });
  return {
    ok: true,
    action: "ban",
    guildId: input.guildId,
    userId: input.userId,
    status: response.status,
  };
}

async function kickMember(input) {
  const response = await discordFetch(input.botToken, `/guilds/${input.guildId}/members/${input.userId}`, {
    method: "DELETE",
    reason: input.reason,
  });
  return {
    ok: true,
    action: "kick",
    guildId: input.guildId,
    userId: input.userId,
    status: response.status,
  };
}

async function discordFetch(botToken, path, options) {
  const headers = {
    Authorization: `Bot ${botToken}`,
    "X-Audit-Log-Reason": encodeURIComponent(options.reason ?? "VoidBot moderation action."),
  };
  const request = {
    method: options.method,
    headers,
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }

  const response = await fetch(`https://discord.com/api/v10${path}`, request);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord moderation action failed: ${response.status} ${text}`);
  }
  return response;
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

await main();
