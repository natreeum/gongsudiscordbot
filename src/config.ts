export interface Config {
  token: string;
  scheduleChannelId: string;
  roleChannelId: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} 환경변수가 필요합니다. .env.example을 확인하세요.`);
    return value;
  };
  const channelId = (name: string): string => {
    const value = required(name);
    if (!/^[1-9]\d{16,19}$/.test(value)) {
      throw new Error(`${name}은 Discord 채널 ID여야 합니다.`);
    }
    return value;
  };
  return {
    token: required('DISCORD_BOT_TOKEN'),
    scheduleChannelId: channelId('SCHEDULE_ALERT_CHANNEL_ID'),
    roleChannelId: channelId('ROLE_EMOJI_CHANNEL_ID'),
  };
}
