export const REPO_IDENTITY_POST_SENTINEL = "VOIDBOT_REPO_IDENTITY_POST:";

export interface RepoIdentityPostIntent {
  identity?: string;
  channelId?: string;
  content: string;
  replyToMessageId?: string;
}

type RepoFaceActionBlock = {
  kind: "say" | "state_note" | "article" | "reddit_thread" | "bifrost_topic" | "update_request";
  fields: Record<string, string>;
};

export function parseRepoIdentityPostIntents(finalResponse: string): RepoIdentityPostIntent[] {
  const intents: RepoIdentityPostIntent[] = parseRepoFaceActionBlocks(finalResponse)
    .filter((block) => block.kind === "say")
    .flatMap((block): RepoIdentityPostIntent[] => {
      const content = requiredDslString(block.fields.content);
      if (!content) {
        return [];
      }
      return [
        {
          identity: optionalDslString(block.fields.identity),
          channelId: optionalDslString(block.fields.channel) ?? optionalDslString(block.fields.channelId),
          replyToMessageId: optionalDslString(block.fields.reply_to) ?? optionalDslString(block.fields.replyToMessageId),
          content,
        },
      ];
    });

  for (const line of finalResponse.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(REPO_IDENTITY_POST_SENTINEL)) {
      continue;
    }

    const payload = trimmed.slice(REPO_IDENTITY_POST_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (!content) {
        continue;
      }
      intents.push({
        identity: typeof parsed.identity === "string" ? parsed.identity.trim() : undefined,
        channelId: typeof parsed.channelId === "string" ? parsed.channelId.trim() : undefined,
        replyToMessageId:
          typeof parsed.replyToMessageId === "string" ? parsed.replyToMessageId.trim() : undefined,
        content,
      });
    } catch {
      continue;
    }
  }

  return intents;
}

export function isNonPublicRepoIdentitySpeech(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (isSingleMarkdownFence(trimmed)) {
    return true;
  }
  const unfenced = stripSingleMarkdownFence(trimmed);
  const normalized = unfenced
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();
  if (/^(nothing|nothing public|nothing private|nothing right now|nothing yet|no public(?: line| speech)?|stay private|stay quiet)\b/.test(normalized)) {
    return true;
  }
  if (/\b(no public line|no public speech|nothing public yet|nothing public right now|would say nothing|hold silence|stay private|stay quiet)\b/.test(normalized)) {
    return true;
  }
  return [
    "nothing",
    "nothing right now",
    "nothing public",
    "nothing public yet",
    "nothing public right now",
    "nothing in aquarium",
    "stay private",
    "stay quiet",
    "no public line",
    "no public speech",
  ].includes(normalized);
}

export function normalizePublicRepoIdentitySpeech(value: string): string {
  return value
    .replace(/```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```/g, (_match, body: string) => body.trim())
    .replace(/`([^`\r\n]+)`/g, (_match, body: string) => `"${body.trim()}"`)
    .trim();
}

function stripSingleMarkdownFence(value: string): string {
  const trimmed = value.trim();
  if (!isSingleMarkdownFence(trimmed)) {
    return trimmed;
  }
  const singleLine = trimmed.match(/^`([^`\r\n]+)`$/);
  if (singleLine) {
    return singleLine[1].trim();
  }
  const block = trimmed.match(/^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  return block ? block[1].trim() : trimmed;
}

function isSingleMarkdownFence(value: string): boolean {
  return /^`[^`\r\n]+`$/.test(value) || /^```[A-Za-z0-9_-]*\s*\r?\n[\s\S]*?\r?\n```$/.test(value);
}

function parseRepoFaceActionBlocks(finalResponse: string): RepoFaceActionBlock[] {
  const lines = finalResponse.split(/\r?\n/);
  const blocks: RepoFaceActionBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = parseRepoFaceActionKind(lines[index]);
    if (!kind) {
      continue;
    }

    const bodyLines: string[] = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "END") {
      if (parseRepoFaceActionKind(lines[index])) {
        index -= 1;
        break;
      }
      bodyLines.push(lines[index]);
      index += 1;
    }
    blocks.push({
      kind,
      fields: parseRepoFaceActionFields(bodyLines),
    });
  }
  return blocks;
}

function parseRepoFaceActionKind(line: string): RepoFaceActionBlock["kind"] | undefined {
  switch (line.trim().toUpperCase()) {
    case "SAY":
      return "say";
    case "STATE NOTE":
      return "state_note";
    case "ARTICLE":
      return "article";
    case "REDDIT THREAD":
      return "reddit_thread";
    case "BIFROST TOPIC":
      return "bifrost_topic";
    case "UPDATE REQUEST":
      return "update_request";
    default:
      return undefined;
  }
}

function parseRepoFaceActionFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let currentKey: string | undefined;
  let currentValue: string[] = [];

  const flush = (): void => {
    if (!currentKey) {
      return;
    }
    fields[currentKey] = currentValue.join("\n").trim();
  };

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) {
      flush();
      currentKey = match[1].trim();
      const inlineValue = match[2].trim();
      currentValue = inlineValue.length > 0 && inlineValue !== "|" && inlineValue !== ">" ? [match[2]] : [];
      continue;
    }
    if (currentKey) {
      currentValue.push(line.replace(/^\s{2}/, ""));
    }
  }
  flush();
  return fields;
}

function optionalDslString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length === 0) {
    return undefined;
  }
  if (["0", "null", "none", "undefined"].includes(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

function requiredDslString(value: string | undefined): string | undefined {
  return optionalDslString(value);
}
