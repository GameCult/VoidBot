export async function openOwnerDmChannel(
  botToken: string,
  recipientId: string,
): Promise<string> {
  const response = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient_id: recipientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to open Discord DM channel: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord DM channel creation returned no channel id.");
  }

  return payload.id;
}

export async function postDiscordMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<{ id: string }> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      allowed_mentions: {
        parse: [],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post Discord message: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { id?: string };

  if (!payload.id) {
    throw new Error("Discord message post returned no message id.");
  }

  return { id: payload.id };
}
