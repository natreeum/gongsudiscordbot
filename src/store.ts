import { DatabaseSync } from 'node:sqlite';
import {
  MAX_ROLE_EMOJIS, UserError, validateSchedule,
  type PanelState, type RoleEmoji, type RoleEmojiInput,
  type Schedule, type ScheduleInput,
} from './domain.js';

const scheduleColumns = 'id, guild_id AS guildId, day, hour, minute, content, role_id AS roleId';
const roleColumns = 'id, guild_id AS guildId, emoji_key AS emojiKey, emoji_display AS emojiDisplay, emoji_reaction AS emojiReaction, role_id AS roleId';

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        day INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6),
        hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
        minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
        content TEXT NOT NULL,
        role_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(guild_id, day, hour, minute);
      CREATE TABLE IF NOT EXISTS schedule_runs (
        schedule_id INTEGER NOT NULL,
        occurrence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'claimed',
        detail TEXT,
        PRIMARY KEY (schedule_id, occurrence)
      );
      CREATE TABLE IF NOT EXISTS role_emojis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        emoji_key TEXT NOT NULL,
        emoji_display TEXT NOT NULL,
        emoji_reaction TEXT NOT NULL,
        role_id TEXT NOT NULL,
        UNIQUE (guild_id, emoji_key),
        UNIQUE (guild_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS role_panels (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        dirty INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS role_panel_snapshots (
        guild_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        mappings_json TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  schedules(guildId: string): Schedule[] {
    return this.db.prepare(`SELECT ${scheduleColumns} FROM schedules WHERE guild_id = ? ORDER BY id`)
      .all(guildId) as unknown as Schedule[];
  }

  schedule(guildId: string, id: number): Schedule {
    const row = this.db.prepare(`SELECT ${scheduleColumns} FROM schedules WHERE guild_id = ? AND id = ?`)
      .get(guildId, id) as unknown as Schedule | undefined;
    if (!row) throw new UserError(`[${id}] 스케줄이 없습니다.`);
    return row;
  }

  addSchedule(guildId: string, input: ScheduleInput): Schedule {
    const value = validateSchedule(input);
    const result = this.db.prepare('INSERT INTO schedules (guild_id, day, hour, minute, content, role_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guildId, value.day, value.hour, value.minute, value.content, value.roleId);
    return this.schedule(guildId, Number(result.lastInsertRowid));
  }

  updateSchedule(guildId: string, id: number, patch: Partial<ScheduleInput>): Schedule {
    const value = validateSchedule({ ...this.schedule(guildId, id), ...patch });
    this.db.prepare('UPDATE schedules SET day = ?, hour = ?, minute = ?, content = ?, role_id = ? WHERE guild_id = ? AND id = ?')
      .run(value.day, value.hour, value.minute, value.content, value.roleId, guildId, id);
    return this.schedule(guildId, id);
  }

  removeSchedule(guildId: string, id: number): void {
    this.schedule(guildId, id);
    this.db.prepare('DELETE FROM schedules WHERE guild_id = ? AND id = ?').run(guildId, id);
  }

  dueSchedules(guildId: string, day: number, hour: number, minute: number): Schedule[] {
    return this.db.prepare(`SELECT ${scheduleColumns} FROM schedules WHERE guild_id = ? AND day = ? AND hour = ? AND minute = ? ORDER BY id`)
      .all(guildId, day, hour, minute) as unknown as Schedule[];
  }

  claimSchedule(id: number, occurrence: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO schedule_runs (schedule_id, occurrence) VALUES (?, ?)')
      .run(id, occurrence).changes === 1;
  }

  finishSchedule(id: number, occurrence: string, error?: string): void {
    this.db.prepare('UPDATE schedule_runs SET status = ?, detail = ? WHERE schedule_id = ? AND occurrence = ?')
      .run(error === undefined ? 'sent' : 'failed', error?.slice(0, 1000) ?? null, id, occurrence);
  }

  roleEmojis(guildId: string): RoleEmoji[] {
    return this.db.prepare(`SELECT ${roleColumns} FROM role_emojis WHERE guild_id = ? ORDER BY id`)
      .all(guildId) as unknown as RoleEmoji[];
  }

  roleEmoji(guildId: string, id: number): RoleEmoji {
    const row = this.roleEmojis(guildId).find(value => value.id === id);
    if (!row) throw new UserError(`[${id}] 이모지·역할 설정이 없습니다.`);
    return row;
  }

  private checkMapping(guildId: string, input: RoleEmojiInput, excludingId?: number): void {
    const rows = this.roleEmojis(guildId);
    if (excludingId === undefined && rows.length >= MAX_ROLE_EMOJIS) {
      throw new UserError(`하나의 안내 메시지에는 최대 ${MAX_ROLE_EMOJIS}개의 이모지를 등록할 수 있습니다.`);
    }
    if (rows.some(row => row.id !== excludingId && row.emojiKey === input.emojiKey)) {
      throw new UserError('이미 등록된 이모지입니다.');
    }
    if (rows.some(row => row.id !== excludingId && row.roleId === input.roleId)) {
      throw new UserError('이미 등록된 역할입니다. 역할 하나에는 이모지 하나만 연결할 수 있습니다.');
    }
  }

  addRoleEmoji(guildId: string, input: RoleEmojiInput): RoleEmoji {
    return this.transaction(() => {
      this.checkMapping(guildId, input);
      const result = this.db.prepare('INSERT INTO role_emojis (guild_id, emoji_key, emoji_display, emoji_reaction, role_id) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, input.emojiKey, input.emojiDisplay, input.emojiReaction, input.roleId);
      this.markPanelDirty(guildId);
      return this.roleEmoji(guildId, Number(result.lastInsertRowid));
    });
  }

  updateRoleEmoji(guildId: string, id: number, input: RoleEmojiInput): RoleEmoji {
    return this.transaction(() => {
      this.roleEmoji(guildId, id);
      this.checkMapping(guildId, input, id);
      this.db.prepare('UPDATE role_emojis SET emoji_key = ?, emoji_display = ?, emoji_reaction = ?, role_id = ? WHERE guild_id = ? AND id = ?')
        .run(input.emojiKey, input.emojiDisplay, input.emojiReaction, input.roleId, guildId, id);
      this.markPanelDirty(guildId);
      return this.roleEmoji(guildId, id);
    });
  }

  removeRoleEmoji(guildId: string, id: number): void {
    this.transaction(() => {
      this.roleEmoji(guildId, id);
      this.db.prepare('DELETE FROM role_emojis WHERE guild_id = ? AND id = ?').run(guildId, id);
      this.markPanelDirty(guildId);
    });
  }

  panel(guildId: string): PanelState | null {
    const row = this.db.prepare('SELECT guild_id AS guildId, channel_id AS channelId, message_id AS messageId, dirty FROM role_panels WHERE guild_id = ?')
      .get(guildId) as unknown as Omit<PanelState, 'dirty'> & { dirty: number } | undefined;
    return row ? { ...row, dirty: row.dirty === 1 } : null;
  }

  savePanel(panel: PanelState): void {
    this.db.prepare(`INSERT INTO role_panels (guild_id, channel_id, message_id, dirty) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, dirty = excluded.dirty`)
      .run(panel.guildId, panel.channelId, panel.messageId, Number(panel.dirty));
  }

  markPanelDirty(guildId: string): void {
    this.db.prepare('UPDATE role_panels SET dirty = 1 WHERE guild_id = ?').run(guildId);
  }

  panelMappings(guildId: string, messageId: string): RoleEmojiInput[] | null {
    const row = this.db.prepare('SELECT mappings_json FROM role_panel_snapshots WHERE guild_id = ? AND message_id = ?')
      .get(guildId, messageId);
    return row ? JSON.parse(String(row.mappings_json)) as RoleEmojiInput[] : null;
  }

  savePanelMappings(guildId: string, messageId: string, mappings: readonly RoleEmojiInput[]): void {
    this.db.prepare(`INSERT INTO role_panel_snapshots (guild_id, message_id, mappings_json) VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET message_id = excluded.message_id, mappings_json = excluded.mappings_json`)
      .run(guildId, messageId, JSON.stringify(mappings));
  }
}
