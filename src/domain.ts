import emojiRegex from 'emoji-regex';

export const TIME_ZONE = 'Asia/Seoul';
export const DAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
export const MAX_ROLE_EMOJIS = 20;
export const MAX_CONTENT_LENGTH = 1900;

export class UserError extends Error {}

export interface ScheduleInput {
  day: number;
  hour: number;
  minute: number;
  content: string;
  roleId: string;
}

export interface Schedule extends ScheduleInput {
  id: number;
  guildId: string;
}

export interface EmojiValue {
  key: string;
  display: string;
  reaction: string;
  customId: string | null;
}

export interface RoleEmojiInput {
  emojiKey: string;
  emojiDisplay: string;
  emojiReaction: string;
  roleId: string;
}

export interface RoleEmoji extends RoleEmojiInput {
  id: number;
  guildId: string;
}

export interface PanelState {
  guildId: string;
  channelId: string;
  messageId: string | null;
  dirty: boolean;
}

export function validateSchedule(input: ScheduleInput): ScheduleInput {
  for (const [name, value, max] of [
    ['요일', input.day, 6],
    ['시', input.hour, 23],
    ['분', input.minute, 59],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new UserError(`${name} 값은 0~${max} 범위의 정수여야 합니다.`);
    }
  }
  const content = input.content.trim();
  if (!content || content.length > MAX_CONTENT_LENGTH) {
    throw new UserError(`내용은 1~${MAX_CONTENT_LENGTH}자여야 합니다.`);
  }
  if (!/^[1-9]\d{16,19}$/.test(input.roleId)) {
    throw new UserError('유효한 역할을 선택하세요.');
  }
  return { ...input, content };
}

export function unicodeEmojiKey(value: string): string {
  return `unicode:${value.normalize('NFC').replace(/\uFE0F/g, '')}`;
}

export function parseEmoji(input: string): EmojiValue {
  const value = input.trim();
  const custom = /^<(a?):([A-Za-z0-9_]{2,32}):([1-9]\d{16,19})>$/.exec(value);
  if (custom) {
    const id = custom[3]!;
    return { key: `custom:${id}`, display: value, reaction: id, customId: id };
  }
  const matches = [...value.matchAll(emojiRegex())];
  if (matches.length !== 1 || matches[0]?.[0] !== value) {
    throw new UserError('이모지 하나를 입력하세요. 예: 🎮 또는 <:이름:ID> 형식의 서버 이모지');
  }
  return { key: unicodeEmojiKey(value), display: value, reaction: value, customId: null };
}

export function reactionKey(emoji: { id: string | null; name: string | null }): string | null {
  if (emoji.id) return `custom:${emoji.id}`;
  return emoji.name ? unicodeEmojiKey(emoji.name) : null;
}

const koreanClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function scheduleMinute(now: Date): {
  day: number; hour: number; minute: number; occurrence: string;
} {
  const parts = Object.fromEntries(koreanClock.formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    day: new Date(`${date}T00:00:00Z`).getUTCDay(),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    occurrence: `${date}T${parts.hour}:${parts.minute}`,
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

export function formatSchedule(schedule: Schedule): string {
  return `[${schedule.id}] ${DAYS[schedule.day]}:${pad(schedule.hour)}:${pad(schedule.minute)} - ${schedule.content} <@&${schedule.roleId}>`;
}

export function formatRoleEmoji(mapping: RoleEmoji): string {
  return `[${mapping.id}] ${mapping.emojiDisplay} <@&${mapping.roleId}>`;
}

export function messagePages(lines: string[], limit = 1950): string[] {
  const pages: string[] = [];
  let page = '';
  for (const line of lines) {
    if (line.length > limit) throw new Error('응답 한 줄이 Discord 메시지 길이를 초과했습니다.');
    if (page && page.length + 1 + line.length > limit) {
      pages.push(page);
      page = '';
    }
    page += `${page ? '\n' : ''}${line}`;
  }
  if (page) pages.push(page);
  return pages;
}

// One queue per guild: role configuration changes and reactions must stay ordered.
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
