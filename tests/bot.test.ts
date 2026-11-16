import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { MessageFlags, type Client, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import { canRunCommand } from '../src/commands.js';
import { readConfig } from '../src/config.js';
import { DiscordPanelGateway, type BotChannel } from '../src/discord.js';
import {
  DAILY_SCHEDULE_DAY, formatSchedule, parseEmoji, reactionKey, scheduleMinute, validateSchedule,
  type PanelState, type RoleEmoji, type RoleEmojiInput, type ScheduleInput,
} from '../src/domain.js';
import { RoleService, type PanelGateway, type ReactionEvent } from '../src/roles.js';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';

const guildId = '111111111111111111';
const channelId = '222222222222222222';
const roleId = '333333333333333333';
const otherRoleId = '444444444444444444';
const userId = '555555555555555555';
const mondayMorning = new Date('2026-11-16T00:05:00Z'); // 월요일 09:05 KST
const input: ScheduleInput = { day: 1, hour: 9, minute: 5, content: '출발합니다', roleId };

function memory(t: TestContext): Store {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

function mapping(emoji = '🎮', selectedRole = roleId): RoleEmojiInput {
  const parsed = parseEmoji(emoji);
  return { emojiKey: parsed.key, emojiDisplay: parsed.display, emojiReaction: parsed.reaction, roleId: selectedRole };
}

test('환경변수 누락 및 잘못된 채널 ID를 거부한다', () => {
  assert.throws(() => readConfig({}), /DISCORD_BOT_TOKEN/);
  assert.throws(() => readConfig({ DISCORD_BOT_TOKEN: 'test', SCHEDULE_ALERT_CHANNEL_ID: '#알림' }), /채널 ID/);
  assert.deepEqual(readConfig({
    DISCORD_BOT_TOKEN: ' test ', SCHEDULE_ALERT_CHANNEL_ID: channelId, ROLE_EMOJI_CHANNEL_ID: channelId,
  }), { token: 'test', scheduleChannelId: channelId, roleChannelId: channelId });
});

test('한국 시간의 일요일에서 월요일로 넘어가는 날짜·분을 계산한다', () => {
  assert.deepEqual(scheduleMinute(new Date('2026-11-15T14:59:59Z')), {
    day: 0, hour: 23, minute: 59, occurrence: '2026-11-15T23:59',
  });
  assert.deepEqual(scheduleMinute(new Date('2026-11-15T15:00:00Z')), {
    day: 1, hour: 0, minute: 0, occurrence: '2026-11-16T00:00',
  });
});

test('스케줄 입력의 잘못된 시간과 빈 내용을 거부한다', () => {
  for (const patch of [{ day: 8 }, { day: -1 }, { day: 1.5 }, { hour: 24 }, { minute: 60 }, { minute: 1.5 }, { content: '  ' }, { content: 'x'.repeat(1901) }]) {
    assert.throws(() => validateSchedule({ ...input, ...patch }));
  }
  assert.equal(validateSchedule({ ...input, content: ' 출발 ' }).content, '출발');
  assert.equal(validateSchedule({ ...input, day: DAILY_SCHEDULE_DAY }).day, DAILY_SCHEDULE_DAY);
});

test('복합 Unicode 이모지를 허용하고 변형 선택자와 커스텀 이모지 이름을 정규화한다', () => {
  assert.equal(parseEmoji('❤️').key, reactionKey({ id: null, name: '❤' }));
  assert.equal(parseEmoji('👨‍👩‍👧‍👦').display, '👨‍👩‍👧‍👦');
  assert.equal(parseEmoji('🇰🇷').display, '🇰🇷');
  assert.equal(parseEmoji('<:original:123456789012345678>').key, parseEmoji('<a:renamed:123456789012345678>').key);
  assert.throws(() => parseEmoji('🎮📢'));
  assert.throws(() => parseEmoji('hello'));
});

test('관리자는 역할 설정을 변경할 수 없고 서버 소유자만 변경한다', () => {
  for (const command of ['addroleemoji', 'modroleemoji', 'rmroleemoji']) {
    assert.equal(canRunCommand(command, false, true), false);
    assert.equal(canRunCommand(command, true, false), true);
  }
  assert.equal(canRunCommand('lsroleemoji', false, false), true);
  assert.equal(canRunCommand('addschedule', false, false), false);
  assert.equal(canRunCommand('addschedule', false, true), true);
  assert.equal(canRunCommand('lsschedule', false, false), false);
  assert.equal(canRunCommand('unknown', true, true), false);
});

test('삭제 후에도 ID를 유지하고 다른 서버의 항목을 수정하지 않는다', t => {
  const store = memory(t);
  const first = store.addSchedule(guildId, input);
  const second = store.addSchedule(guildId, { ...input, content: '두 번째' });
  store.removeSchedule(guildId, first.id);
  const third = store.addSchedule(guildId, input);
  assert.equal(store.schedules(guildId)[0]?.id, second.id);
  assert.ok(third.id > second.id);
  assert.throws(() => store.updateSchedule('other-guild', second.id, { hour: 12 }));
  assert.throws(() => store.removeSchedule('other-guild', second.id));
  const updated = store.updateSchedule(guildId, second.id, { hour: 0, minute: 0 });
  assert.equal(updated.content, '두 번째');
  assert.equal(formatSchedule(updated), `[${second.id}] 월:00:00 - 두 번째 <@&${roleId}>`);
});

test('매일과 특정 요일 사이의 변경은 같은 ID 한 건을 유지한다', t => {
  const store = memory(t);
  const schedule = store.addSchedule(guildId, input);
  const daily = store.updateSchedule(guildId, schedule.id, { day: DAILY_SCHEDULE_DAY });
  assert.equal(formatSchedule(daily), `[${schedule.id}] 매일:09:05 - 출발합니다 <@&${roleId}>`);
  for (let day = 0; day < 7; day++) {
    assert.deepEqual(store.dueSchedules(guildId, day, 9, 5).map(value => value.id), [schedule.id]);
  }
  store.updateSchedule(guildId, schedule.id, { day: 0 });
  assert.equal(store.schedules(guildId).length, 1);
  assert.equal(store.schedule(guildId, schedule.id).day, 0);
  assert.equal(store.dueSchedules(guildId, 0, 9, 5).length, 1);
  assert.equal(store.dueSchedules(guildId, 1, 9, 5).length, 0);
  store.removeSchedule(guildId, schedule.id);
  assert.equal(store.schedules(guildId).length, 0);
});

for (const keepSchedule of [true, false]) {
  test(`기존 DB 마이그레이션은 발송 이력과 삭제된 ID를 보존한다 (남은 스케줄: ${keepSchedule})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'gongsu-migration-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'bot.sqlite');
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        CREATE TABLE schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          day INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6),
          hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
          minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
          content TEXT NOT NULL,
          role_id TEXT NOT NULL
        );
        CREATE INDEX schedules_due ON schedules(guild_id, day, hour, minute);
        CREATE TABLE schedule_runs (
          schedule_id INTEGER NOT NULL,
          occurrence TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'claimed',
          detail TEXT,
          PRIMARY KEY (schedule_id, occurrence)
        );
      `);
      const insert = legacy.prepare('INSERT INTO schedules (id, guild_id, day, hour, minute, content, role_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const id of [1, 73]) insert.run(id, guildId, input.day, input.hour, input.minute, input.content, input.roleId);
      legacy.exec('DELETE FROM schedules WHERE id = 73');
      if (!keepSchedule) legacy.exec('DELETE FROM schedules');
      const run = legacy.prepare('INSERT INTO schedule_runs (schedule_id, occurrence, status) VALUES (?, ?, ?)');
      for (const id of [1, 73]) run.run(id, '2026-11-16T09:05', 'sent');
    } finally { legacy.close(); }

    let store = new Store(path);
    try {
      assert.deepEqual(store.schedules(guildId).map(schedule => ({ ...schedule })), keepSchedule ? [{ ...input, id: 1, guildId }] : []);
      assert.equal(store.claimSchedule(1, '2026-11-16T09:05'), false);
      assert.equal(store.claimSchedule(73, '2026-11-16T09:05'), false);
      const daily = store.addSchedule(guildId, { ...input, day: DAILY_SCHEDULE_DAY });
      assert.ok(daily.id > 73);
      const sent: number[] = [];
      const send = async (schedule: { id: number }): Promise<void> => { sent.push(schedule.id); };
      await new Scheduler(store, guildId, send).tick(mondayMorning);
      assert.deepEqual(sent, [daily.id]);
      store.close();
      store = new Store(path);
      assert.equal(store.schedule(guildId, daily.id).day, DAILY_SCHEDULE_DAY);
      const scheduler = new Scheduler(store, guildId, send);
      await scheduler.tick(mondayMorning);
      assert.deepEqual(sent, [daily.id]);
      await scheduler.tick(new Date('2026-11-17T00:05:00Z'));
      assert.deepEqual(sent, [daily.id, daily.id]);
    } finally { store.close(); }
  });
}

test('이모지와 역할 중복을 거부하고 잘못된 수정은 기존 설정을 유지한다', t => {
  const store = memory(t);
  const first = store.addRoleEmoji(guildId, mapping());
  const second = store.addRoleEmoji(guildId, mapping('📢', otherRoleId));
  assert.throws(() => store.addRoleEmoji(guildId, mapping('🎮', '666666666666666666')), /이모지/);
  assert.throws(() => store.addRoleEmoji(guildId, mapping('✅', roleId)), /역할/);
  assert.throws(() => store.updateRoleEmoji(guildId, second.id, mapping('📢', roleId)), /역할/);
  assert.equal(store.roleEmoji(guildId, second.id).roleId, otherRoleId);
  assert.equal(store.roleEmoji(guildId, first.id).roleId, roleId);
});

test('역할 안내 메시지는 이모지 20개까지 허용한다', t => {
  const store = memory(t);
  for (let index = 0; index < 20; index++) {
    store.addRoleEmoji(guildId, mapping(String.fromCodePoint(0x1f600 + index), String(BigInt(roleId) + BigInt(index))));
  }
  assert.throws(() => store.addRoleEmoji(guildId, mapping('🎮', '777777777777777777')), /최대 20/);
  assert.equal(store.roleEmojis(guildId).length, 20);
});

test('현재 분에 해당하는 스케줄만 보내고 다음 주에는 다시 보낸다', async t => {
  const store = memory(t);
  const due = store.addSchedule(guildId, input);
  store.addSchedule(guildId, { ...input, minute: 6 });
  store.addSchedule('other-guild', input);
  const sent: number[] = [];
  const scheduler = new Scheduler(store, guildId, async schedule => { sent.push(schedule.id); });
  await scheduler.tick(mondayMorning);
  await scheduler.tick(new Date('2026-11-16T00:05:59Z'));
  assert.deepEqual(sent, [due.id]);
  await scheduler.tick(new Date('2026-11-23T00:05:00Z'));
  assert.deepEqual(sent, [due.id, due.id]);
});

test('매일 스케줄은 한국 시간 자정에 매일 한 번 보내고 주간 스케줄과 함께 실행한다', async t => {
  const store = memory(t);
  const daily = store.addSchedule(guildId, { ...input, day: DAILY_SCHEDULE_DAY, hour: 0, minute: 0 });
  const weekly = store.addSchedule(guildId, { ...input, hour: 0, minute: 0 });
  store.addSchedule(guildId, { ...input, day: DAILY_SCHEDULE_DAY, hour: 0, minute: 1 });
  store.addSchedule('other-guild', { ...input, day: DAILY_SCHEDULE_DAY, hour: 0, minute: 0 });
  const sent: number[] = [];
  const expected: number[] = [];
  const scheduler = new Scheduler(store, guildId, async schedule => { sent.push(schedule.id); });
  const firstMidnight = Date.parse('2026-11-15T15:00:00Z'); // 월요일 00:00 KST
  for (let day = 0; day < 8; day++) {
    const midnight = firstMidnight + day * 24 * 60 * 60 * 1000;
    await scheduler.tick(new Date(midnight - 1000));
    assert.deepEqual(sent, expected);
    await scheduler.tick(new Date(midnight));
    await scheduler.tick(new Date(midnight + 59_000));
    expected.push(daily.id);
    if (day % 7 === 0) expected.push(weekly.id);
    assert.deepEqual(sent, expected);
  }
});

test('DB를 다시 열어도 설정과 같은 분의 발송 이력이 유지된다', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gongsu-bot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  let sent = 0;
  try {
    store.addSchedule(guildId, input);
    store.addRoleEmoji(guildId, mapping());
    store.savePanel({ guildId, channelId, messageId: 'panel-1', dirty: false });
    store.savePanelMappings(guildId, 'panel-1', [mapping()]);
    await new Scheduler(store, guildId, async () => { sent++; }).tick(mondayMorning);
    store.close();
    store = new Store(path);
    await new Scheduler(store, guildId, async () => { sent++; }).tick(mondayMorning);
    assert.equal(sent, 1);
    assert.equal(store.roleEmojis(guildId).length, 1);
    assert.equal(store.panel(guildId)?.messageId, 'panel-1');
    assert.deepEqual(store.panelMappings(guildId, 'panel-1'), [mapping()]);
    assert.equal(store.panelMappings(guildId, 'other-message'), null);
  } finally { store.close(); }
});

test('발송 실패를 같은 분에 재시도하지 않고 다른 스케줄은 발송한다', async t => {
  const store = memory(t);
  const failed = store.addSchedule(guildId, input);
  const success = store.addSchedule(guildId, input);
  const attempts: number[] = [];
  const logs: string[] = [];
  const scheduler = new Scheduler(store, guildId, async schedule => {
    attempts.push(schedule.id);
    if (schedule.id === failed.id) throw new Error('네트워크 응답 유실');
  }, message => { logs.push(message); });
  await scheduler.tick(mondayMorning);
  await scheduler.tick(mondayMorning);
  assert.deepEqual(attempts, [failed.id, success.id]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /네트워크 응답 유실/);
});

test('발송이 진행 중일 때 중복 tick이 같은 알림을 보내지 않는다', async t => {
  const store = memory(t);
  store.addSchedule(guildId, input);
  let release!: () => void;
  const delivery = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  const scheduler = new Scheduler(store, guildId, async () => { sent++; await delivery; });
  const first = scheduler.tick(mondayMorning);
  const second = scheduler.tick(mondayMorning);
  release();
  await Promise.all([first, second]);
  assert.equal(sent, 1);
});

class FakeGateway implements PanelGateway {
  messages = new Map<string, string>();
  reactions = new Map<string, Map<string, Set<string>>>();
  operations: string[] = [];
  assignments: { userId: string; roleId: string; enabled: boolean }[] = [];
  failReact = false;
  failDelete = false;
  failEdit = false;
  failRemove = false;
  beforeSync: (() => Promise<void>) | undefined;
  sequence = 0;

  async exists(panel: PanelState): Promise<boolean> {
    return panel.messageId !== null && this.messages.has(panel.messageId);
  }
  async delete(panel: PanelState): Promise<void> {
    if (this.failDelete) throw new Error('delete failed');
    this.operations.push(`delete:${panel.messageId}`);
    if (panel.messageId) {
      this.messages.delete(panel.messageId);
      this.reactions.delete(panel.messageId);
    }
  }
  async create(content: string): Promise<string> {
    const id = `panel-${++this.sequence}`;
    this.operations.push(`create:${id}`);
    this.messages.set(id, content);
    this.reactions.set(id, new Map());
    return id;
  }
  async edit(panel: PanelState, content: string): Promise<boolean> {
    if (this.failEdit) throw new Error('edit failed');
    if (!panel.messageId || !this.messages.has(panel.messageId)) return false;
    this.operations.push(`edit:${panel.messageId}`);
    this.messages.set(panel.messageId, content);
    return true;
  }
  async syncReactions(messageId: string, mappings: readonly RoleEmoji[], preservedKeys: ReadonlySet<string>): Promise<void> {
    await this.beforeSync?.();
    const reactions = this.reactions.get(messageId)!;
    for (const key of [...reactions.keys()]) {
      if (!preservedKeys.has(key)) {
        if (this.failRemove) throw new Error('remove failed');
        reactions.delete(key);
        this.operations.push(`remove:${key}`);
      }
    }
    for (const mapping of mappings) {
      if (reactions.get(mapping.emojiKey)?.has('bot')) continue;
      if (this.failReact) throw new Error('react failed');
      if (!reactions.has(mapping.emojiKey) && reactions.size >= 20) throw new Error('too many reactions');
      const users = reactions.get(mapping.emojiKey) ?? new Set<string>();
      users.add('bot');
      reactions.set(mapping.emojiKey, users);
      this.operations.push(`react:${mapping.emojiKey}`);
    }
  }
  choose(messageId: string, emoji: string, user = userId): void {
    this.reactions.get(messageId)!.get(parseEmoji(emoji).key)!.add(user);
  }
  async setRole(user: string, role: string, enabled: boolean): Promise<void> {
    await Promise.resolve();
    this.assignments.push({ userId: user, roleId: role, enabled });
  }
}

function roleFixture(t: TestContext) {
  const store = memory(t);
  const gateway = new FakeGateway();
  const service = new RoleService(store, guildId, channelId, gateway, () => {});
  const event = (messageId: string, added = true): ReactionEvent => ({
    guildId, channelId, messageId, userId, emojiKey: parseEmoji('🎮').key, added,
  });
  return { store, gateway, service, event };
}

test('역할 추가 시 같은 메시지를 수정하고 기존 사용자의 반응을 유지한다', async t => {
  const { store, gateway, service } = roleFixture(t);
  await service.ensurePanel();
  await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  gateway.choose('panel-1', '🎮');
  const result = await service.change(async () => store.addRoleEmoji(guildId, mapping('📢', otherRoleId)));
  assert.equal(result.panelUpdated, true);
  assert.equal(gateway.sequence, 1);
  assert.equal(gateway.operations.some(operation => operation.startsWith('delete:')), false);
  assert.match(gateway.messages.get('panel-1')!, /📢/);
  assert.equal(gateway.reactions.get('panel-1')!.get(parseEmoji('🎮').key)!.has(userId), true);
  assert.equal(gateway.messages.size, 1);
  assert.equal(store.panel(guildId)?.messageId, 'panel-1');
  assert.equal(store.panel(guildId)?.dirty, false);
  assert.equal(gateway.assignments.length, 0); // Refresh does not remove existing roles.
});

test('이모지 수정·삭제 시 해당 반응만 정리하고 나머지 반응과 역할을 보존한다', async t => {
  const { store, gateway, service } = roleFixture(t);
  await service.ensurePanel();
  const game = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  await service.change(async () => store.addRoleEmoji(guildId, mapping('📢', otherRoleId)));
  gateway.choose('panel-1', '🎮');
  gateway.choose('panel-1', '📢');
  await service.change(async () => store.updateRoleEmoji(guildId, game.value.id, mapping('🕹️')));
  const reactions = gateway.reactions.get('panel-1')!;
  assert.equal(reactions.has(parseEmoji('🎮').key), false);
  assert.deepEqual([...reactions.get(parseEmoji('🕹️').key)!], ['bot']);
  assert.equal(reactions.get(parseEmoji('📢').key)!.has(userId), true);
  await service.change(async () => store.removeRoleEmoji(guildId, game.value.id));
  assert.equal(reactions.has(parseEmoji('🕹️').key), false);
  assert.equal(reactions.get(parseEmoji('📢').key)!.has(userId), true);
  assert.equal(gateway.assignments.length, 0);
  assert.equal(gateway.sequence, 1);
});

test('구버전의 정상 안내 메시지를 처음 적용할 때도 기존 반응을 유지한다', async t => {
  const { store, gateway, service } = roleFixture(t);
  store.addRoleEmoji(guildId, mapping());
  const messageId = await gateway.create('기존 안내');
  store.savePanel({ guildId, channelId, messageId, dirty: false });
  await gateway.syncReactions(messageId, store.roleEmojis(guildId), new Set());
  gateway.choose(messageId, '🎮');
  assert.equal(store.panelMappings(guildId, messageId), null);
  await service.ensurePanel();
  assert.equal(gateway.sequence, 1);
  assert.equal(gateway.reactions.get(messageId)!.get(parseEmoji('🎮').key)!.has(userId), true);
  assert.equal(store.panelMappings(guildId, messageId)?.[0]?.roleId, roleId);
  assert.match(gateway.messages.get(messageId)!, /역할 선택/);
});

test('재시작 시 저장된 메시지를 재사용하고 유실된 경우 새로 생성한다', async t => {
  const { store, gateway, service } = roleFixture(t);
  await service.ensurePanel();
  const restarted = new RoleService(store, guildId, channelId, gateway);
  await restarted.ensurePanel();
  assert.equal(gateway.sequence, 1);
  gateway.messages.clear();
  await restarted.ensurePanel();
  assert.equal(gateway.sequence, 2);
  assert.equal(gateway.messages.size, 1);
});

test('현재 안내 메시지의 등록된 이모지만 처리하고 추가·취소 순서를 보존한다', async t => {
  const { store, gateway, service, event } = roleFixture(t);
  await service.ensurePanel();
  await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  await service.handleReaction(event('other-message'));
  await service.handleReaction({ ...event('panel-1'), channelId: 'other-channel' });
  await service.handleReaction({ ...event('panel-1'), guildId: 'other-guild' });
  await service.handleReaction({ ...event('panel-1'), emojiKey: parseEmoji('📢').key });
  assert.equal(gateway.assignments.length, 0);
  await Promise.all([
    service.handleReaction(event('panel-1', true)),
    service.handleReaction(event('panel-1', false)),
  ]);
  assert.deepEqual(gateway.assignments, [
    { userId, roleId, enabled: true }, { userId, roleId, enabled: false },
  ]);
});

test('이모지 등록 실패 후 같은 메시지를 재시도하여 복구한다', async t => {
  const { store, gateway, service, event } = roleFixture(t);
  await service.ensurePanel();
  gateway.failReact = true;
  const result = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  assert.equal(result.panelUpdated, false);
  assert.equal(store.roleEmojis(guildId).length, 1);
  assert.equal(store.panel(guildId)?.messageId, 'panel-1');
  assert.equal(store.panel(guildId)?.dirty, true);
  await service.handleReaction(event('panel-1'));
  assert.equal(gateway.assignments.length, 0);
  gateway.failReact = false;
  await service.ensurePanel();
  assert.equal(gateway.messages.size, 1);
  assert.equal(store.panel(guildId)?.messageId, 'panel-1');
  assert.equal(gateway.sequence, 1);
  assert.equal(store.panel(guildId)?.dirty, false);
});

test('수정 실패 시 반응을 변경된 역할에 적용하지 않고 같은 메시지에서 복구한다', async t => {
  const { store, gateway, service, event } = roleFixture(t);
  await service.ensurePanel();
  const first = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  gateway.choose('panel-1', '🎮');
  gateway.failEdit = true;
  const changed = await service.change(async () => store.updateRoleEmoji(guildId, first.value.id, mapping('🎮', otherRoleId)));
  assert.equal(changed.panelUpdated, false);
  await service.handleReaction(event('panel-1'));
  assert.equal(gateway.assignments.length, 0);
  assert.equal(store.panelMappings(guildId, 'panel-1')?.[0]?.roleId, roleId);
  gateway.failEdit = false;
  await service.ensurePanel();
  assert.equal(gateway.sequence, 1);
  assert.equal(gateway.reactions.get('panel-1')!.get(parseEmoji('🎮').key)!.has(userId), false);
  await service.handleReaction(event('panel-1'));
  assert.deepEqual(gateway.assignments, [{ userId, roleId: otherRoleId, enabled: true }]);
});

test('반응 정리 실패 후 재시작해도 마지막 적용 기록으로 변경된 이모지만 초기화한다', async t => {
  const { store, gateway, service } = roleFixture(t);
  await service.ensurePanel();
  const game = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  await service.change(async () => store.addRoleEmoji(guildId, mapping('📢', otherRoleId)));
  gateway.choose('panel-1', '🎮');
  gateway.choose('panel-1', '📢');
  gateway.failRemove = true;
  const changed = await service.change(async () => store.updateRoleEmoji(guildId, game.value.id, mapping('🎮', '666666666666666666')));
  assert.equal(changed.panelUpdated, false);
  assert.equal(store.panel(guildId)?.dirty, true);
  gateway.failRemove = false;
  const restarted = new RoleService(store, guildId, channelId, gateway);
  await restarted.ensurePanel();
  const reactions = gateway.reactions.get('panel-1')!;
  assert.equal(reactions.get(parseEmoji('🎮').key)!.has(userId), false);
  assert.equal(reactions.get(parseEmoji('📢').key)!.has(userId), true);
  assert.equal(gateway.sequence, 1);
  assert.equal(store.panel(guildId)?.dirty, false);
});

test('수정 중 도착한 반응을 새 역할에 잘못 연결하지 않고 변경 없는 역할의 취소는 처리한다', async t => {
  const { store, gateway, service, event } = roleFixture(t);
  await service.ensurePanel();
  const game = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  await service.change(async () => store.addRoleEmoji(guildId, mapping('📢', otherRoleId)));
  let started!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  gateway.beforeSync = async () => { started(); await paused; };
  const changing = service.change(async () => store.updateRoleEmoji(guildId, game.value.id, mapping('🎮', '666666666666666666')));
  await ready;
  const oldReaction = service.handleReaction(event('panel-1'));
  const unchangedReaction = service.handleReaction({ ...event('panel-1', false), emojiKey: parseEmoji('📢').key });
  release();
  await Promise.all([changing, oldReaction, unchangedReaction]);
  assert.deepEqual(gateway.assignments, [{ userId, roleId: otherRoleId, enabled: false }]);
  await service.handleReaction(event('panel-1'));
  assert.equal(gateway.assignments[1]?.roleId, '666666666666666666');
});

test('20개 이모지가 있는 메시지에서도 먼저 정리한 뒤 교체하며 기존 반응을 보존한다', async t => {
  const { store, gateway, service } = roleFixture(t);
  for (let index = 0; index < 20; index++) {
    store.addRoleEmoji(guildId, mapping(String.fromCodePoint(0x1f600 + index), String(BigInt(roleId) + BigInt(index))));
  }
  await service.ensurePanel();
  const first = store.roleEmojis(guildId)[0]!;
  gateway.choose('panel-1', String.fromCodePoint(0x1f601));
  const changed = await service.change(async () => store.updateRoleEmoji(guildId, first.id, mapping('🎮')));
  assert.equal(changed.panelUpdated, true);
  const reactions = gateway.reactions.get('panel-1')!;
  assert.equal(reactions.size, 20);
  assert.equal(reactions.has(first.emojiKey), false);
  assert.equal(reactions.has(parseEmoji('🎮').key), true);
  assert.equal(reactions.get(parseEmoji(String.fromCodePoint(0x1f601)).key)!.has(userId), true);
  assert.equal(gateway.sequence, 1);
});

test('Discord 수정 요청은 멘션을 차단하고 새 메시지에만 푸시 알림 억제 플래그를 지정한다', async () => {
  const sends: MessageCreateOptions[] = [];
  const edits: MessageEditOptions[] = [];
  const message = {
    author: { id: 'bot' },
    edit: async (options: MessageEditOptions) => { edits.push(options); },
  };
  const channel = {
    id: channelId, guildId,
    messages: { fetch: async () => message },
    send: async (options: MessageCreateOptions) => { sends.push(options); return { id: 'panel-1' }; },
  };
  const gateway = new DiscordPanelGateway({ user: { id: 'bot' } } as unknown as Client<true>, channel as unknown as BotChannel);
  const content = `<@&${roleId}>`;
  assert.equal(await gateway.edit({ guildId, channelId, messageId: 'panel-1', dirty: true }, content), true);
  assert.equal(sends.length, 0);
  assert.deepEqual(edits, [{ content, allowedMentions: { parse: [] } }]);
  await gateway.create(content);
  assert.deepEqual(sends, [{ content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications }]);
});
