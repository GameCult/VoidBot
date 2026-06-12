import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AppConfig } from "@voidbot/config";
import {
  appendRepoFaceVoiceOutboxEntry,
  findRepoDiscordIdentity,
  isRepoDiscordIdentityAllowedInChannel,
  resolveWeksaArtifactPath,
  type RepoDiscordIdentityRegistry,
  WeksaSpeechClient,
} from "@voidbot/core";
import type { Message } from "discord.js";

const METAME_VOICE_DESIGN_PROMPT = [
  "Metame voice profile, owner-authorized:",
  "Sultry and velvet-fist dominant, spoken close to the microphone.",
  "She never raises her voice.",
  "When angry, diction sharpens until each word lands like a carefully aimed high-caliber bullet.",
  "When stressed, the voice becomes teary, wavery, high-pitched, and stutters over every word.",
  "Preserve the speaker's high-functioning autistic self-description as texture and pacing truth, not caricature.",
].join("\n");

export async function maybeMirrorOwnerAquariumMessageAsMetameVoice(input: {
  message: Message;
  registry: RepoDiscordIdentityRegistry;
  config: AppConfig;
}): Promise<void> {
  const { message, registry, config } = input;
  if (
    !config.metameOwnerVoice.enabled ||
    !config.repoFaceWeksaSpeech.enabled ||
    !config.repoFaceDiscordVoice.enabled ||
    !message.inGuild() ||
    message.author.id !== config.ownerDiscordId ||
    !config.metameOwnerVoice.sourceChannelId ||
    message.channelId !== config.metameOwnerVoice.sourceChannelId
  ) {
    return;
  }

  const exactUtterance = message.content;
  if (exactUtterance.trim().length === 0) {
    return;
  }

  const metame = findRepoDiscordIdentity(registry, config.metameOwnerVoice.personaId);
  if (!metame) {
    console.warn(`Skipped Metame owner voice bridge: no identity named ${config.metameOwnerVoice.personaId}.`);
    return;
  }
  if (!isRepoDiscordIdentityAllowedInChannel(metame, message.channelId)) {
    console.warn(`Skipped Metame owner voice bridge: ${metame.id} is not allowed in channel ${message.channelId}.`);
    return;
  }

  await appendMetameOwnerVoiceState({
    statePath: config.metameOwnerVoice.statePath,
    canonicalPersonaStatePath: metame.personaStatePath,
    message,
    exactUtterance,
  });

  const client = new WeksaSpeechClient({
    baseUrl: config.repoFaceWeksaSpeech.daemonBaseUrl,
    timeoutMs: config.repoFaceWeksaSpeech.timeoutMs,
  });
  try {
    const receipt = await client.renderRepoFaceSpeech({
      jobId: `metame-owner-${message.id}`,
      identityId: metame.id,
      displayName: metame.displayName,
      repoName: metame.repoName,
      personaStatePath: config.metameOwnerVoice.statePath,
      channelId: message.channelId,
      messageId: message.id,
      content: exactUtterance,
      requestId: `voidbot-metame-owner-${message.id}`,
      scene: `Owner-authored Metame mirror in Discord #aquarium text channel ${message.channelId}`,
      addressee: "MiMo and the Aquarium voice channel",
      performanceRegister: {
        label: "Metame owner voice mirror",
        medium: "Discord voice channel playback",
        delivery_archetype: "Metame speaks the owner's exact Aquarium text as an authorized voice projection",
      },
      deliveryControls: [
        "preserve the Discord message content exactly",
        "close microphone intimacy",
        "sultry velvet-fist dominance",
        "quiet authority; never shout",
        "anger sharpens diction instead of raising volume",
        "stress becomes teary, wavery, high-pitched, and stuttered",
      ],
      forbiddenTraits: [
        "generic assistant voice",
        "rewriting the source utterance",
        "softening dominant diction",
        "shouting",
        "mocking or caricaturing autistic speech texture",
      ],
      voiceDesignPrompt: METAME_VOICE_DESIGN_PROMPT,
      privateInterpretation:
        "This is an owner-authorized Metame voice mirror. The source text is the owner's exact Aquarium message; Weksa may design delivery, but must not rewrite the utterance. The canonical Metame Persona state remains in CultCache; this markdown file is the Weksa-readable voice sync projection.",
      intendedEffect:
        "Let the owner type in #aquarium and hear that exact utterance delivered through Metame's synchronized voice in the Aquarium voice channel.",
    });
    const audioPath = resolveWeksaArtifactPath(
      config.repoFaceWeksaSpeech.repoRoot,
      receipt.artifacts?.audio,
    );
    if (!audioPath) {
      console.warn(`Metame owner voice render for message ${message.id} returned no audio artifact.`);
      return;
    }
    await appendRepoFaceVoiceOutboxEntry(config.repoFaceDiscordVoice.outboxPath, {
      schemaVersion: "voidbot.repo_face_voice_outbox.v1",
      id: `metame-owner:${message.id}`,
      createdAt: new Date().toISOString(),
      identityId: metame.id,
      displayName: metame.displayName,
      repoName: metame.repoName,
      textChannelId: message.channelId,
      textMessageId: message.id,
      contentPreview: exactUtterance.slice(0, 500),
      weksaRequestId: receipt.request_id,
      weksaReceiptArtifact: receipt.artifacts?.receipt,
      audioPath,
      audioBytes: receipt.provider_response?.audio_bytes,
    });
    console.log(`Queued Metame owner voice mirror for Aquarium message ${message.id}: ${audioPath}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Metame owner voice bridge failed for message ${message.id}: ${detail}`);
  }
}

async function appendMetameOwnerVoiceState(input: {
  statePath: string;
  canonicalPersonaStatePath?: string;
  message: Message;
  exactUtterance: string;
}): Promise<void> {
  await mkdir(dirname(input.statePath), { recursive: true });
  const existing = await readFile(input.statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const header = existing.trim().length > 0
    ? ""
    : [
        "# Metame Owner Voice Sync",
        "",
        "This is a Weksa-readable projection, not Metame's canonical CultCache state.",
        `Canonical Persona state: ${input.canonicalPersonaStatePath ?? "unregistered"}`,
        "",
        "Voice profile:",
        METAME_VOICE_DESIGN_PROMPT,
        "",
        "Owner-authored Aquarium utterances:",
        "",
      ].join("\n");
  const entry = [
    `## ${input.message.createdAt.toISOString()} Discord message ${input.message.id}`,
    `Channel: ${input.message.channelId}`,
    `Author: ${input.message.author.id}`,
    `Exact utterance JSON string: ${JSON.stringify(input.exactUtterance)}`,
    "",
  ].join("\n");
  await appendFile(input.statePath, `${header}${entry}`, "utf8");
}
