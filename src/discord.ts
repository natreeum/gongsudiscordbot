import {
  ChannelType, MessageFlags, PermissionFlagsBits,
  type Client, type Guild, type Role, type TextChannel, type NewsChannel,
} from 'discord.js';
import { reactionKey, UserError, type EmojiValue, type PanelState, type RoleEmoji, type Schedule } from './domain.js';
import type { PanelGateway } from './roles.js';

export type BotChannel = TextChannel | NewsChannel;

export function hasDiscordCode(error: unknown, ...codes: number[]): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'number' && codes.includes(error.code);
}

export async function textChannel(client: Client, id: string): Promise<BotChannel> {
  const channel = await client.channels.fetch(id);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    throw new Error(`채널 ${id}은 서버의 텍스트 채널 또는 공지 채널이어야 합니다.`);
  }
  return channel;
}

export async function assertChannelPermissions(channel: BotChannel, reactions: boolean): Promise<void> {
  const bot = await channel.guild.members.fetchMe();
  const permissions = channel.permissionsFor(bot);
  const required: [bigint, string][] = [
    [PermissionFlagsBits.ViewChannel, '채널 보기'],
    [PermissionFlagsBits.SendMessages, '메시지 보내기'],
    [PermissionFlagsBits.ReadMessageHistory, '메시지 기록 보기'],
  ];
  if (reactions) required.push(
    [PermissionFlagsBits.AddReactions, '반응 추가'],
    [PermissionFlagsBits.ManageMessages, '메시지 관리 (변경된 이모지의 반응 정리)'],
  );
  const missing = required.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
  if (missing.length) throw new Error(`#${channel.name} 채널에 봇 권한이 없습니다: ${missing.join(', ')}`);
  if (reactions && !bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('봇에 역할 관리 권한이 필요합니다.');
  }
}

export async function mentionRole(channel: BotChannel, roleId: string): Promise<Role> {
  const role = await channel.guild.roles.fetch(roleId);
  if (!role || role.id === channel.guild.id) throw new UserError('@everyone 이외의 서버 역할을 선택하세요.');
  const bot = await channel.guild.members.fetchMe();
  if (!role.mentionable && !channel.permissionsFor(bot)?.has(PermissionFlagsBits.MentionEveryone)) {
    throw new UserError('선택한 역할을 멘션할 수 없습니다. 역할의 멘션 허용 또는 봇의 모든 역할 멘션 권한을 설정하세요.');
  }
  return role;
}

export async function assignableRole(guild: Guild, roleId: string): Promise<Role> {
  const [role, bot] = await Promise.all([guild.roles.fetch(roleId), guild.members.fetchMe()]);
  if (!role || role.id === guild.id || role.managed) {
    throw new UserError('@everyone 및 봇·연동 관리 역할은 등록할 수 없습니다.');
  }
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles) || bot.roles.highest.comparePositionTo(role) <= 0) {
    throw new UserError('봇에 역할 관리 권한을 부여하고, 봇 역할을 대상 역할보다 위에 배치하세요.');
  }
  return role;
}

export async function usableEmoji(guild: Guild, emoji: EmojiValue): Promise<void> {
  if (!emoji.customId) return;
  const found = await guild.emojis.fetch(emoji.customId).catch(error => {
    if (hasDiscordCode(error, 10014)) return null;
    throw error;
  });
  if (!found || !found.available) throw new UserError('이 서버에서 사용 가능한 커스텀 이모지를 선택하세요.');
  const bot = await guild.members.fetchMe();
  if (found.roles.cache.size && !found.roles.cache.some(role => bot.roles.cache.has(role.id))) {
    throw new UserError('봇이 사용할 수 없는 역할 제한 이모지입니다.');
  }
}

export async function sendSchedule(channel: BotChannel, schedule: Schedule): Promise<void> {
  await mentionRole(channel, schedule.roleId);
  await channel.send({
    content: `${schedule.content}\n<@&${schedule.roleId}>`,
    // Ignore user mentions, @everyone, and other role mentions pasted into the content.
    allowedMentions: { parse: [], roles: [schedule.roleId], users: [], repliedUser: false },
  });
}

export class DiscordPanelGateway implements PanelGateway {
  private readonly client: Client<true>;
  private readonly channel: BotChannel;

  constructor(client: Client<true>, channel: BotChannel) {
    this.client = client;
    this.channel = channel;
  }

  private async message(panel: PanelState) {
    if (!panel.messageId) return null;
    try {
      const channel = panel.channelId === this.channel.id
        ? this.channel : await textChannel(this.client, panel.channelId);
      if (channel.guildId !== this.channel.guildId) throw new Error('저장된 안내 메시지의 서버가 일치하지 않습니다.');
      const message = await channel.messages.fetch({ message: panel.messageId, force: true });
      if (message.author.id !== this.client.user.id) {
        throw new Error('저장된 안내 메시지가 이 봇의 메시지가 아닙니다.');
      }
      return message;
    } catch (error) {
      if (hasDiscordCode(error, 10008, 10003)) return null;
      throw error;
    }
  }

  async exists(panel: PanelState): Promise<boolean> {
    return await this.message(panel) !== null;
  }

  async delete(panel: PanelState): Promise<void> {
    const message = await this.message(panel);
    if (message) {
      try { await message.delete(); }
      catch (error) { if (!hasDiscordCode(error, 10008)) throw error; }
    }
  }

  async create(content: string): Promise<string> {
    return (await this.channel.send({
      content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications,
    })).id;
  }

  async edit(panel: PanelState, content: string): Promise<boolean> {
    const message = await this.message(panel);
    if (!message) return false;
    try {
      // Edit requests do not inherit the original allowed_mentions; always send it explicitly.
      await message.edit({ content, allowedMentions: { parse: [] } });
      return true;
    } catch (error) {
      if (hasDiscordCode(error, 10008)) return false;
      throw error;
    }
  }

  async syncReactions(messageId: string, mappings: readonly RoleEmoji[], preservedKeys: ReadonlySet<string>): Promise<void> {
    const message = await this.channel.messages.fetch({ message: messageId, force: true });
    const seeded = new Set<string>();
    // Remove stale/changed emoji first, including users' reactions. This also leaves
    // space for a replacement when the message already has Discord's 20 emoji limit.
    for (const reaction of [...message.reactions.cache.values()]) {
      const key = reactionKey(reaction.emoji);
      if (key && preservedKeys.has(key)) {
        if (reaction.me) seeded.add(key);
      } else {
        // Emits messageReactionRemoveEmoji, not individual messageReactionRemove events.
        await reaction.remove();
      }
    }
    for (const mapping of mappings) {
      if (!seeded.has(mapping.emojiKey)) await message.react(mapping.emojiReaction);
    }
  }

  async setRole(userId: string, roleId: string, enabled: boolean): Promise<void> {
    if (userId === this.client.user.id) return;
    const guild = this.channel.guild;
    const member = await guild.members.fetch({ user: userId, force: true }).catch(error => {
      if (hasDiscordCode(error, 10007, 10013)) return null;
      throw error;
    });
    if (!member || member.user.bot) return;
    await assignableRole(guild, roleId);
    // The single-role endpoints are idempotent and do not replace the member's role list.
    if (enabled) await member.roles.add(roleId, '역할 안내 메시지 이모지 선택');
    else await member.roles.remove(roleId, '역할 안내 메시지 이모지 취소');
  }
}
