import { applyVoidSelfStateOperation, loadVoidSelfStateTypedDocuments } from "@voidbot/core";

const STRIKE_EXPIRY_DAYS: Record<string, number> = {
  safety_threat: 365, weaponized_intimidation: 365, stalking_or_doxxing: 365,
  sexual_boundary_violation: 365, bigotry_identity_attack: 180, bad_faith_argument: 90,
  nsfw_channel_violation: 30, spam_or_deceptive_promotion: 30, moderator_obstruction: 90,
  empty_words_noise: 14, values_debate_escalation: 14, pg13_language_violation: 14,
  event_time_coordination: 14,
};

export interface VoidModerationEnforcementResult {
  status: "ok";
  mode: string;
  evaluatedCaseCount: number;
  actions: Array<{ sourceMessageId: string; status: string; authorId?: string; infringementType?: string; strikeCount?: number }>;
}

export async function runVoidModerationEnforcement(input: {
  statePath: string;
  mode: string;
  botToken?: string;
  guildId?: string;
  observedAt?: Date;
}, dependencies: {
  loadState?: typeof loadVoidSelfStateTypedDocuments;
  applyOperation?: typeof applyVoidSelfStateOperation;
  banMember?: (input: { botToken: string; guildId: string; userId: string; reason: string }) => Promise<void>;
} = {}): Promise<VoidModerationEnforcementResult> {
  const mode = input.mode.trim().toLowerCase();
  const state = await (dependencies.loadState ?? loadVoidSelfStateTypedDocuments)({ canonicalPath: input.statePath });
  const pending = state.moderationCursor.openCases.filter((entry) => entry.status === "pending" || entry.status === "watching");
  const actions: VoidModerationEnforcementResult["actions"] = [];
  for (const moderationCase of pending) {
    const tags = new Set(moderationCase.tags.map((tag) => tag.toLowerCase()));
    const infringementType = [...tags].find((tag) => tag.startsWith("infringement:"))?.slice("infringement:".length);
    if (!infringementType || STRIKE_EXPIRY_DAYS[infringementType] === undefined || !moderationCase.authorId) {
      actions.push({ sourceMessageId: moderationCase.sourceMessageId, status: "missing_policy_or_author", authorId: moderationCase.authorId, infringementType });
      continue;
    }
    if (tags.has("moderation:case_only")) {
      actions.push({ sourceMessageId: moderationCase.sourceMessageId, status: "case_recorded_no_sanction", authorId: moderationCase.authorId, infringementType });
      continue;
    }
    if (!["policy", "enforce_policy", "enforce-policy", "ban"].includes(mode)) {
      actions.push({ sourceMessageId: moderationCase.sourceMessageId, status: "enforcement_mode_non_destructive", authorId: moderationCase.authorId, infringementType });
      continue;
    }
    const strikeCount = countActiveStrikes(state.moderationCursor.openCases, moderationCase.authorId, infringementType, STRIKE_EXPIRY_DAYS[infringementType], input.observedAt ?? new Date());
    const instantBan = tags.has("moderation:instaban") || tags.has("severity:instaban");
    const thirdStrike = tags.has("moderation:strike") && strikeCount >= 3;
    if (instantBan || thirdStrike) {
      if (!input.botToken || !input.guildId) throw new Error("Policy moderation requires Discord bot token and guild id.");
      const reason = instantBan ? `VoidBot instaban: ${infringementType} at ${moderationCase.sourceMessageId}` : `VoidBot three-strike ban: ${infringementType} strike ${strikeCount}/3 at ${moderationCase.sourceMessageId}`;
      await (dependencies.banMember ?? banDiscordMember)({ botToken: input.botToken, guildId: input.guildId, userId: moderationCase.authorId, reason });
      await closeCase(input.statePath, moderationCase.sourceMessageId, input.observedAt ?? new Date(), `${instantBan ? "Instaban" : "Three-strike ban"} applied for ${infringementType}.`, dependencies.applyOperation);
      actions.push({ sourceMessageId: moderationCase.sourceMessageId, status: instantBan ? "instaban_applied" : "three_strike_ban_applied", authorId: moderationCase.authorId, infringementType, strikeCount });
      continue;
    }
    if (tags.has("moderation:strike")) {
      await closeCase(input.statePath, moderationCase.sourceMessageId, input.observedAt ?? new Date(), `Strike ${strikeCount}/3 recorded for ${infringementType}; expires after ${STRIKE_EXPIRY_DAYS[infringementType]} days without another matching strike.`, dependencies.applyOperation);
      actions.push({ sourceMessageId: moderationCase.sourceMessageId, status: "strike_recorded", authorId: moderationCase.authorId, infringementType, strikeCount });
    }
  }
  return { status: "ok", mode, evaluatedCaseCount: pending.length, actions };
}

function countActiveStrikes(cases: Array<{ authorId?: string; createdAt: string; tags: string[] }>, authorId: string, infringementType: string, expiresDays: number, now: Date): number {
  const cutoff = now.getTime() - expiresDays * 86_400_000;
  return cases.filter((entry) => entry.authorId === authorId
    && entry.tags.map((tag) => tag.toLowerCase()).includes(`infringement:${infringementType}`)
    && entry.tags.map((tag) => tag.toLowerCase()).includes("moderation:strike")
    && Date.parse(entry.createdAt) >= cutoff).length;
}

async function closeCase(statePath: string, sourceMessageId: string, observedAt: Date, resolutionSummary: string, applyOperation = applyVoidSelfStateOperation): Promise<void> {
  await applyOperation({ canonicalPath: statePath }, { operation: "close_open_case", sourceMessageId, status: "resolved", resolvedAt: observedAt.toISOString(), resolutionSummary });
}

async function banDiscordMember(input: { botToken: string; guildId: string; userId: string; reason: string }): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/guilds/${input.guildId}/bans/${input.userId}`, {
    method: "PUT",
    headers: { Authorization: `Bot ${input.botToken}`, "Content-Type": "application/json", "X-Audit-Log-Reason": encodeURIComponent(input.reason) },
    body: JSON.stringify({ delete_message_seconds: 0 }),
  });
  if (!response.ok) throw new Error(`Discord ban failed with ${response.status}: ${(await response.text()).slice(0, 1000)}`);
}
