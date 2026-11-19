import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
  NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  type AudioResource, type VoiceConnection,
} from '@discordjs/voice';
import { ChannelType, Events, PermissionFlagsBits, type Client, type VoiceChannel } from 'discord.js';
import type { MusicConfig } from './config.js';
import { errorMessage } from './domain.js';
import { MusicUnavailableError, type MusicTrack } from './music-domain.js';
import type { MusicPlayback } from './music.js';
import { YouTubeSource, type AudioPipeline } from './youtube.js';

export async function musicChannel(client: Client<true>, guildId: string, config: MusicConfig): Promise<VoiceChannel> {
  const channel = await client.channels.fetch(config.voiceChannelId, { force: true });
  if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== guildId) {
    throw new MusicUnavailableError('MUSIC_VOICE_CHANNEL_ID는 설정된 서버의 일반 음성채널이어야 합니다.');
  }
  const bot = await channel.guild.members.fetchMe({ force: true });
  const permissions = channel.permissionsFor(bot);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new MusicUnavailableError('음악 음성채널에 봇의 채널 보기·연결·말하기 권한이 필요합니다.');
  }
  if (bot.voice.serverMute) throw new MusicUnavailableError('서버에서 봇의 음소거를 해제해야 합니다.');
  return channel;
}

export class DiscordMusicPlayback implements MusicPlayback {
  private readonly player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  private connection: VoiceConnection | undefined;
  private cleanup: (() => void) | undefined;
  private connectionFailed: ((error: Error) => void) | undefined;

  constructor(
    private readonly client: Client<true>,
    private readonly guildId: string,
    private readonly config: MusicConfig,
    private readonly source: YouTubeSource,
    private readonly log: (message: string) => void,
  ) {
    // Always consume late errors, including those from a resource already stopped.
    this.player.on('error', error => this.log(`[음악] 오디오 플레이어 오류: ${errorMessage(error)}`));
    client.on(Events.VoiceStateUpdate, (_oldState, state) => {
      if (state.guild.id !== guildId || state.id !== client.user.id || !this.connection) return;
      if (state.channelId !== config.voiceChannelId || state.serverMute) {
        this.connectionFailed?.(new MusicUnavailableError('봇이 지정 음성채널에서 나갔거나 서버 음소거 상태가 되었습니다.'));
      }
    });
  }

  async play(track: MusicTrack, signal: AbortSignal, ended: (error?: unknown) => void): Promise<void> {
    signal.throwIfAborted();
    this.stop();
    let pipeline: AudioPipeline | undefined;
    let removePlayerListeners = (): void => {};
    let closed = false;
    let reported = false;
    const done = (error?: unknown): void => {
      if (closed || reported || signal.aborted) return;
      reported = true;
      ended(error);
    };
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', abort);
      removePlayerListeners();
      pipeline?.close();
    };
    const abort = (): void => {
      if (this.cleanup === cleanup) this.stop();
      else cleanup();
    };
    this.cleanup = cleanup;
    this.connectionFailed = done;
    signal.addEventListener('abort', abort, { once: true });

    let connection: VoiceConnection;
    try {
      const channel = await musicChannel(this.client, this.guildId, this.config);
      signal.throwIfAborted();
      if (!this.connection || this.connection.state.status === VoiceConnectionStatus.Destroyed) {
        const created = joinVoiceChannel({
          channelId: channel.id, guildId: channel.guildId, adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: true, selfMute: false,
        });
        this.connection = created;
        created.on('error', error => {
          if (this.connection === created) this.connectionFailed?.(new MusicUnavailableError(errorMessage(error)));
        });
        created.on('stateChange', (_previous, state) => {
          if (this.connection !== created) return;
          if (state.status === VoiceConnectionStatus.Disconnected || state.status === VoiceConnectionStatus.Destroyed) {
            this.connectionFailed?.(new MusicUnavailableError('Discord 음성 연결이 끊겼습니다.'));
          }
        });
      }
      connection = this.connection;
      connection.subscribe(this.player);
      await entersState(connection, VoiceConnectionStatus.Ready, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new MusicUnavailableError(`음성채널 연결 실패: ${errorMessage(error)}`);
    }
    signal.throwIfAborted();
    pipeline = this.source.audio(track.url, signal, done);
    let resource: AudioResource;
    try { resource = createAudioResource(pipeline.stream, { inputType: StreamType.Raw }); }
    catch (error) { throw new MusicUnavailableError(`음성 인코더 초기화 실패: ${errorMessage(error)}`); }
    const stateChange = (): void => {
      if (this.player.state.status === AudioPlayerStatus.Idle) done();
    };
    const playerError = (error: { resource: unknown; message: string }): void => {
      if (error.resource === resource) done(new Error(error.message));
    };
    this.player.on('stateChange', stateChange);
    this.player.on('error', playerError);
    removePlayerListeners = () => {
      this.player.off('stateChange', stateChange);
      this.player.off('error', playerError);
    };
    this.player.play(resource);
    await entersState(this.player, AudioPlayerStatus.Playing, AbortSignal.any([signal, AbortSignal.timeout(45_000)]));
  }

  stop(): void {
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    this.connectionFailed = undefined;
    cleanup?.();
    this.player.stop(true);
  }

  disconnect(): void {
    this.stop();
    const connection = this.connection;
    this.connection = undefined;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }
}
