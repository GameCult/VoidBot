export const archivedMessageKinds = ["default", "bot_prompt"] as const;
export type ArchivedMessageKind = (typeof archivedMessageKinds)[number];

export const ARCHIVED_MESSAGE_KIND_METADATA_KEY = "messageKind";

interface MetadataCarrier {
  metadata?: Record<string, string>;
}

interface BotPromptMessageLike extends MetadataCarrier {
  content: string;
}

export function readArchivedMessageKind(
  message: MetadataCarrier | undefined,
): ArchivedMessageKind {
  return message?.metadata?.[ARCHIVED_MESSAGE_KIND_METADATA_KEY] === "bot_prompt"
    ? "bot_prompt"
    : "default";
}

export function isArchivedBotPrompt(
  message: MetadataCarrier | undefined,
): boolean {
  return readArchivedMessageKind(message) === "bot_prompt";
}

export function setArchivedMessageKind(
  metadata: Record<string, string> | undefined,
  kind: ArchivedMessageKind,
): Record<string, string> | undefined {
  const nextMetadata = { ...(metadata ?? {}) };

  if (kind === "default") {
    delete nextMetadata[ARCHIVED_MESSAGE_KIND_METADATA_KEY];
    return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
  }

  nextMetadata[ARCHIVED_MESSAGE_KIND_METADATA_KEY] = kind;
  return nextMetadata;
}

export function contentMentionsDiscordUser(
  content: string,
  userId: string | undefined,
): boolean {
  if (!userId || userId.trim().length === 0) {
    return false;
  }

  const escapedId = escapeRegExp(userId.trim());
  return new RegExp(`<@!?${escapedId}>`).test(content);
}

export function contentMentionsDiscordRole(
  content: string,
  roleId: string | undefined,
): boolean {
  if (!roleId || roleId.trim().length === 0) {
    return false;
  }

  const escapedId = escapeRegExp(roleId.trim());
  return new RegExp(`<@&${escapedId}>`).test(content);
}

export function isDiscordBotPromptContent(
  content: string,
  options: {
    botUserId?: string;
    botRoleIds?: string[];
  } = {},
): boolean {
  if (contentMentionsDiscordUser(content, options.botUserId)) {
    return true;
  }

  return (options.botRoleIds ?? []).some((roleId) =>
    contentMentionsDiscordRole(content, roleId),
  );
}

export function classifyArchivedMessageKind(
  message: BotPromptMessageLike,
  options: {
    botUserId?: string;
    botRoleIds?: string[];
  } = {},
): ArchivedMessageKind {
  if (isArchivedBotPrompt(message)) {
    return "bot_prompt";
  }

  return isDiscordBotPromptContent(message.content, options)
    ? "bot_prompt"
    : "default";
}

export function applyArchivedMessageKind<T extends BotPromptMessageLike>(
  message: T,
  options: {
    botUserId?: string;
    botRoleIds?: string[];
  } = {},
): T {
  const kind = classifyArchivedMessageKind(message, options);
  const nextMetadata = setArchivedMessageKind(message.metadata, kind);
  const currentKind = readArchivedMessageKind(message);

  if (kind === currentKind && nextMetadata === message.metadata) {
    return message;
  }

  return {
    ...message,
    metadata: nextMetadata,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
