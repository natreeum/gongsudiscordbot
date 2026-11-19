import {
  MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ChatInputCommandInteraction, type Guild,
} from 'discord.js';
import {
  DAILY_SCHEDULE_DAY, DAYS, MAX_CONTENT_LENGTH, UserError, errorMessage, formatRoleEmoji, formatSchedule,
  messagePages, parseEmoji, type RoleEmojiInput, type ScheduleInput,
} from './domain.js';
import { assignableRole, mentionRole, usableEmoji, type BotChannel } from './discord.js';
import { RoleService } from './roles.js';
import { Store } from './store.js';
import { executeMusicCommand, musicCommandDefinitions, musicCommandNames, type MusicCommandContext } from './music-commands.js';
import { MusicUnavailableError } from './music-domain.js';

function command(name: string, description: string, ownerOnly = false): SlashCommandBuilder {
  return new SlashCommandBuilder().setName(name).setDescription(description)
    .setDefaultMemberPermissions(ownerOnly ? 0n : PermissionFlagsBits.ManageGuild);
}

function scheduleOptions(builder: SlashCommandBuilder, required: boolean): SlashCommandBuilder {
  return builder
    .addIntegerOption(option => option.setName('day').setDescription('반복할 요일 또는 매일 (한국 시간)')
      .setRequired(required).addChoices(
        ...DAYS.map((name, value) => ({ name: `${name}요일`, value })),
        { name: '매일', value: DAILY_SCHEDULE_DAY },
      ))
    .addIntegerOption(option => option.setName('hour').setDescription('시 (0~23)').setRequired(required).setMinValue(0).setMaxValue(23))
    .addIntegerOption(option => option.setName('minute').setDescription('분 (0~59)').setRequired(required).setMinValue(0).setMaxValue(59))
    .addStringOption(option => option.setName('content').setDescription('전송할 내용').setRequired(required).setMinLength(1).setMaxLength(MAX_CONTENT_LENGTH))
    .addRoleOption(option => option.setName('role').setDescription('멘션할 역할').setRequired(required)) as SlashCommandBuilder;
}

function indexOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(option => option.setName('idx').setDescription('목록에 표시된 고유 ID')
    .setRequired(true).setMinValue(1)) as SlashCommandBuilder;
}

function roleOptions(builder: SlashCommandBuilder, required: boolean): SlashCommandBuilder {
  return builder.addStringOption(option => option.setName('emoji').setDescription('이모지 하나 (예: 🎮 또는 서버 커스텀 이모지)')
    .setRequired(required).setMinLength(1).setMaxLength(100))
    .addRoleOption(option => option.setName('role').setDescription('이모지 선택으로 부여할 역할').setRequired(required)) as SlashCommandBuilder;
}

export const commandDefinitions = [
  scheduleOptions(command('addschedule', '매주 또는 매일 반복되는 스케줄을 추가합니다.'), true),
  command('lsschedule', '등록된 스케줄 목록을 확인합니다.'),
  scheduleOptions(indexOption(command('modschedule', '기존 스케줄에서 지정한 항목을 수정합니다.')), false),
  indexOption(command('rmschedule', '스케줄을 삭제합니다.')),
  roleOptions(command('addroleemoji', '선택 가능한 이모지·역할을 추가합니다. (서버 소유자 전용)', true), true),
  // Listing does not change the role configuration and is available to all members.
  new SlashCommandBuilder().setName('lsroleemoji').setDescription('선택 가능한 이모지·역할 목록을 확인합니다.'),
  roleOptions(indexOption(command('modroleemoji', '이모지·역할 설정을 수정합니다. (서버 소유자 전용)', true)), false),
  indexOption(command('rmroleemoji', '이모지·역할 설정을 삭제합니다. (서버 소유자 전용)', true)),
  ...musicCommandDefinitions,
];

const names = new Set(commandDefinitions.map(definition => definition.name));
const roleMutations = new Set(['addroleemoji', 'modroleemoji', 'rmroleemoji']);

export function canRunCommand(name: string, owner: boolean, manageGuild: boolean): boolean {
  if (!names.has(name)) return false;
  if (roleMutations.has(name)) return owner;
  // Music mutations enforce requester/DJ permissions against the selected track.
  if (musicCommandNames.has(name)) return true;
  if (name === 'lsroleemoji') return true;
  return owner || manageGuild;
}

export interface CommandContext extends MusicCommandContext {
  store: Store;
  roles: RoleService;
  guild: Guild;
  scheduleChannel: BotChannel;
}

function schedulePatch(interaction: ChatInputCommandInteraction): Partial<ScheduleInput> {
  const patch: Partial<ScheduleInput> = {};
  const { options } = interaction;
  const day = options.getInteger('day');
  const hour = options.getInteger('hour');
  const minute = options.getInteger('minute');
  const content = options.getString('content');
  const role = options.getRole('role');
  if (day !== null) patch.day = day;
  if (hour !== null) patch.hour = hour;
  if (minute !== null) patch.minute = minute;
  if (content !== null) patch.content = content;
  if (role !== null) patch.roleId = role.id;
  return patch;
}

async function roleInput(interaction: ChatInputCommandInteraction, guild: Guild, existing?: RoleEmojiInput): Promise<RoleEmojiInput> {
  const rawEmoji = interaction.options.getString('emoji');
  const role = interaction.options.getRole('role');
  if (existing && rawEmoji === null && role === null) throw new UserError('수정할 emoji 또는 role을 지정하세요.');
  const emoji = parseEmoji(rawEmoji ?? existing!.emojiDisplay);
  const roleId = role?.id ?? existing!.roleId;
  await Promise.all([usableEmoji(guild, emoji), assignableRole(guild, roleId)]);
  return { emojiKey: emoji.key, emojiDisplay: emoji.display, emojiReaction: emoji.reaction, roleId };
}

const panelResult = (updated: boolean): string => updated
  ? '\n역할 안내 메시지를 갱신했습니다.'
  : '\n설정은 저장됐지만 안내 메시지를 갱신하지 못했습니다. 30초마다 자동 재시도합니다. 갱신 전까지 반응 처리가 중지됩니다.';

async function execute(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<string[]> {
  if (musicCommandNames.has(interaction.commandName)) return executeMusicCommand(interaction, ctx);
  const { store, guild, roles, scheduleChannel } = ctx;
  const guildId = guild.id;
  switch (interaction.commandName) {
    case 'addschedule': {
      const input: ScheduleInput = {
        day: interaction.options.getInteger('day', true),
        hour: interaction.options.getInteger('hour', true),
        minute: interaction.options.getInteger('minute', true),
        content: interaction.options.getString('content', true),
        roleId: interaction.options.getRole('role', true).id,
      };
      await mentionRole(scheduleChannel, input.roleId);
      return ['스케줄을 추가했습니다. (한국 시간)', formatSchedule(store.addSchedule(guildId, input))];
    }
    case 'lsschedule': {
      const list = store.schedules(guildId);
      return list.length ? ['스케줄 목록 (Asia/Seoul, 지정 요일 또는 매일 반복)', ...list.map(formatSchedule)] : ['등록된 스케줄이 없습니다.'];
    }
    case 'modschedule': {
      const id = interaction.options.getInteger('idx', true);
      const patch = schedulePatch(interaction);
      if (!Object.keys(patch).length) throw new UserError('수정할 항목을 하나 이상 지정하세요.');
      const previous = store.schedule(guildId, id);
      await mentionRole(scheduleChannel, patch.roleId ?? previous.roleId);
      // Re-read inside updateSchedule so concurrent modifications retain other fields.
      return ['스케줄을 수정했습니다.', formatSchedule(store.updateSchedule(guildId, id, patch))];
    }
    case 'rmschedule': {
      const id = interaction.options.getInteger('idx', true);
      store.removeSchedule(guildId, id);
      return [`[${id}] 스케줄을 삭제했습니다.`];
    }
    case 'lsroleemoji': {
      const list = store.roleEmojis(guildId);
      return list.length ? list.map(formatRoleEmoji) : ['등록된 이모지·역할이 없습니다.'];
    }
    case 'addroleemoji': {
      const result = await roles.change(async () => store.addRoleEmoji(guildId, await roleInput(interaction, guild)));
      return [`이모지·역할을 추가했습니다.${panelResult(result.panelUpdated)}`, formatRoleEmoji(result.value)];
    }
    case 'modroleemoji': {
      const id = interaction.options.getInteger('idx', true);
      const result = await roles.change(async () => {
        const input = await roleInput(interaction, guild, store.roleEmoji(guildId, id));
        return store.updateRoleEmoji(guildId, id, input);
      });
      return [`이모지·역할을 수정했습니다.${panelResult(result.panelUpdated)}`, formatRoleEmoji(result.value)];
    }
    case 'rmroleemoji': {
      const id = interaction.options.getInteger('idx', true);
      const result = await roles.change(async () => store.removeRoleEmoji(guildId, id));
      return [`[${id}] 이모지·역할 설정을 삭제했습니다. 기존에 부여된 역할은 유지됩니다.${panelResult(result.panelUpdated)}`];
    }
    default: throw new UserError('지원하지 않는 명령어입니다.');
  }
}

export async function handleCommand(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!names.has(interaction.commandName)) return;
  try {
    if (!interaction.inGuild() || interaction.guildId !== ctx.guild.id) throw new UserError('설정된 서버에서만 사용할 수 있습니다.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Fetch the current owner; Discord command visibility alone is not authorization.
    const guild = roleMutations.has(interaction.commandName) ? await ctx.guild.fetch() : ctx.guild;
    if (!canRunCommand(interaction.commandName, interaction.user.id === guild.ownerId,
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false)) {
      throw new UserError(roleMutations.has(interaction.commandName)
        ? '서버 소유자만 역할 설정을 변경할 수 있습니다.' : '서버 관리 권한이 필요합니다.');
    }
    const pages = messagePages(await execute(interaction, { ...ctx, guild }));
    await interaction.editReply({ content: pages[0]!, allowedMentions: { parse: [] } });
    for (const page of pages.slice(1)) {
      await interaction.followUp({ content: page, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    if (!(error instanceof UserError)) console.error(`명령어 ${interaction.commandName} 실패: ${errorMessage(error)}`);
    const content = error instanceof UserError ? error.message
      : error instanceof MusicUnavailableError ? '음악 실행 환경을 사용할 수 없습니다. 서버 운영자가 로그와 yt-dlp·FFmpeg 설치를 확인해야 합니다.'
        : '처리하지 못했습니다. 봇 권한 및 서버 로그를 확인하세요.';
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (replyError) {
      console.error(`명령어 오류 응답 실패: ${errorMessage(replyError)}`);
    }
  }
}
