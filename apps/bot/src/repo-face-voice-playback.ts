import { existsSync } from "node:fs";

import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { ChannelType, type Client, type VoiceBasedChannel } from "discord.js";

import {
  appendRepoFaceVoicePlayedEntry,
  loadRepoFaceVoiceOutboxEntries,
  loadRepoFaceVoicePlayedIds,
  type RepoFaceVoiceOutboxEntry,
} from "@voidbot/core";

export interface RepoFaceVoicePlaybackOptions {
  enabled: boolean;
  channelId?: string;
  outboxPath: string;
  playedPath: string;
  pollIntervalMs: number;
}

export function startRepoFaceVoicePlayback(
  client: Client,
  options: RepoFaceVoicePlaybackOptions,
): void {
  if (!options.enabled) {
    return;
  }
  if (!options.channelId) {
    console.warn("Repo Face Discord voice playback enabled without REPO_FACE_DISCORD_VOICE_CHANNEL_ID.");
    return;
  }

  const runtime = new RepoFaceVoicePlaybackRuntime(client, options);
  void runtime.poll();
  setInterval(() => {
    void runtime.poll();
  }, options.pollIntervalMs);
}

class RepoFaceVoicePlaybackRuntime {
  private readonly player: AudioPlayer;
  private connection?: VoiceConnection;
  private active = false;

  constructor(
    private readonly client: Client,
    private readonly options: RepoFaceVoicePlaybackOptions,
  ) {
    this.player = createAudioPlayer();
    this.player.on("error", (error) => {
      console.warn(`Repo Face voice player error: ${error.message}`);
      this.active = false;
    });
  }

  async poll(): Promise<void> {
    if (this.active) {
      return;
    }

    const entries = await loadRepoFaceVoiceOutboxEntries(this.options.outboxPath);
    if (entries.length === 0) {
      return;
    }
    const played = await loadRepoFaceVoicePlayedIds(this.options.playedPath);
    const entry = entries.find((candidate) => !played.has(candidate.id));
    if (!entry) {
      return;
    }

    await this.play(entry);
  }

  private async play(entry: RepoFaceVoiceOutboxEntry): Promise<void> {
    if (!existsSync(entry.audioPath)) {
      console.warn(`Repo Face voice audio is missing for ${entry.id}: ${entry.audioPath}`);
      return;
    }
    this.active = true;
    try {
      const channel = await this.resolveVoiceChannel();
      if (!hasHumanListener(channel)) {
        console.log(
          `Skipped repo Face voice playback for ${entry.id}: no human listeners in channel ${this.options.channelId}.`,
        );
        return;
      }
      const connection = await this.ensureConnection(channel);
      const resource = createAudioResource(entry.audioPath, {
        metadata: entry,
      });
      this.player.play(resource);
      connection.subscribe(this.player);
      await entersState(this.player, AudioPlayerStatus.Playing, 15_000);
      await entersState(this.player, AudioPlayerStatus.Idle, 180_000);
      await appendRepoFaceVoicePlayedEntry(this.options.playedPath, entry);
      console.log(
        `Played repo Face voice ${entry.id} for ${entry.displayName} in channel ${this.options.channelId}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Repo Face voice playback failed for ${entry.id}: ${message}`);
    } finally {
      this.active = false;
    }
  }

  private async resolveVoiceChannel(): Promise<VoiceBasedChannel> {
    const channel = await this.client.channels.fetch(this.options.channelId!);
    if (!channel || !("guild" in channel)) {
      throw new Error(`Configured voice channel ${this.options.channelId} was not found in a guild.`);
    }
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      throw new Error(`Configured channel ${this.options.channelId} is not a Discord voice/stage channel.`);
    }
    return channel;
  }

  private async ensureConnection(channel: VoiceBasedChannel): Promise<VoiceConnection> {
    if (
      this.connection &&
      this.connection.joinConfig.channelId === channel.id &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      return this.connection;
    }
    if (!("voiceAdapterCreator" in channel.guild)) {
      throw new Error(`Guild for voice channel ${channel.id} does not expose a voice adapter.`);
    }
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    this.connection.on("error", (error) => {
      console.warn(`Repo Face voice connection error in channel ${channel.id}: ${error.message}`);
      this.connection?.destroy();
      this.connection = undefined;
      this.active = false;
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    return this.connection;
  }
}

function hasHumanListener(channel: VoiceBasedChannel): boolean {
  return channel.members.some((member) => !member.user.bot);
}
