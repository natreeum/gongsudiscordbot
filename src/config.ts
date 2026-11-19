export interface MusicConfig {
  voiceChannelId: string;
  djRoleId: string;
  ytDlpPath: string;
  ffmpegPath: string;
}

export interface Config {
  token: string;
  scheduleChannelId: string;
  roleChannelId: string;
  music?: MusicConfig;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} 환경변수가 필요합니다. .env.example을 확인하세요.`);
    return value;
  };
  const channelId = (name: string, kind = '채널'): string => {
    const value = required(name);
    if (!/^[1-9]\d{16,19}$/.test(value)) {
      throw new Error(`${name}은 Discord ${kind} ID여야 합니다.`);
    }
    return value;
  };
  const musicEnabled = Boolean(env.MUSIC_VOICE_CHANNEL_ID?.trim() || env.MUSIC_DJ_ROLE_ID?.trim());
  const music: MusicConfig | undefined = musicEnabled ? {
    voiceChannelId: channelId('MUSIC_VOICE_CHANNEL_ID'),
    djRoleId: channelId('MUSIC_DJ_ROLE_ID', '역할'),
    ytDlpPath: env.YTDLP_PATH?.trim() || 'yt-dlp',
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
  } : undefined;
  return {
    token: required('DISCORD_BOT_TOKEN'),
    scheduleChannelId: channelId('SCHEDULE_ALERT_CHANNEL_ID'),
    roleChannelId: channelId('ROLE_EMOJI_CHANNEL_ID'),
    ...(music ? { music } : {}),
  };
}
