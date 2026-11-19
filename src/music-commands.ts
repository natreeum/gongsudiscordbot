import { SlashCommandBuilder, type ChatInputCommandInteraction, type Guild } from 'discord.js';
import { UserError } from './domain.js';
import { formatMusicTrack } from './music-domain.js';
import type { MusicAccess, MusicService } from './music.js';

export const musicCommandDefinitions = [
  new SlashCommandBuilder().setName('재생').setDescription('YouTube 곡을 재생목록에 추가합니다. (현재 곡 포함 최대 10곡)')
    .addStringOption(option => option.setName('링크').setDescription('YouTube 단일 영상 링크').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('다음곡').setDescription('현재 곡을 종료하고 다음 곡을 재생합니다. (등록자 또는 음악대장)'),
  new SlashCommandBuilder().setName('재생목록').setDescription('현재 곡과 대기 중인 재생목록을 확인합니다.'),
  new SlashCommandBuilder().setName('재생목록삭제').setDescription('대기 중인 곡을 삭제합니다. (해당 곡 등록자 또는 음악대장)')
    .addIntegerOption(option => option.setName('idx').setDescription('재생목록에 표시된 대기 번호 (1부터 시작)')
      .setRequired(true).setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('재생목록전체삭제').setDescription('현재 곡을 유지하고 대기 목록만 전체 삭제합니다. (음악대장)'),
];

export const musicCommandNames = new Set(musicCommandDefinitions.map(command => command.name));

export interface MusicCommandContext {
  guild: Guild;
  music?: MusicService;
  musicDjRoleId?: string;
}

export async function executeMusicCommand(interaction: ChatInputCommandInteraction, ctx: MusicCommandContext): Promise<string[]> {
  const { music, musicDjRoleId, guild } = ctx;
  if (!music || !musicDjRoleId) throw new UserError('음악 기능이 준비되지 않았습니다. 서버 운영자가 설정과 시작 로그를 확인해야 합니다.');
  const access: MusicAccess = {
    userId: interaction.user.id,
    isDJ: async () => {
      // Fresh role membership; Administrator and server ownership do not bypass this rule.
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      return musicDjRoleId !== guild.id && member.roles.cache.has(musicDjRoleId);
    },
  };
  switch (interaction.commandName) {
    case '재생': {
      const track = await music.add(interaction.options.getString('링크', true), access.userId);
      return ['재생목록에 추가했습니다.', formatMusicTrack(track, '+')];
    }
    case '다음곡':
      await music.skip(access);
      return ['현재 곡을 종료했습니다. 다음 곡이 있으면 이어서 재생합니다.'];
    case '재생목록':
      return music.list();
    case '재생목록삭제':
      await music.remove(interaction.options.getInteger('idx', true), access);
      return ['선택한 대기 곡을 삭제했습니다.'];
    case '재생목록전체삭제':
      return [`대기 중인 ${await music.clear(access)}곡을 삭제했습니다. 현재 곡은 유지됩니다.`];
    default: throw new UserError('지원하지 않는 음악 명령어입니다.');
  }
}
