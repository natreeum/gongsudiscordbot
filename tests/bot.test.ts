import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canRunCommand } from '../src/commands.js';
import { readConfig } from '../src/config.js';
import {
  formatSchedule, parseEmoji, reactionKey, scheduleMinute, validateSchedule,
  type PanelState, type RoleEmojiInput, type ScheduleInput,
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
  for (const patch of [{ day: 7 }, { day: -1 }, { hour: 24 }, { minute: 60 }, { minute: 1.5 }, { content: '  ' }, { content: 'x'.repeat(1901) }]) {
    assert.throws(() => validateSchedule({ ...input, ...patch }));
  }
  assert.equal(validateSchedule({ ...input, content: ' 출발 ' }).content, '출발');
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
    await new Scheduler(store, guildId, async () => { sent++; }).tick(mondayMorning);
    store.close();
    store = new Store(path);
    await new Scheduler(store, guildId, async () => { sent++; }).tick(mondayMorning);
    assert.equal(sent, 1);
    assert.equal(store.roleEmojis(guildId).length, 1);
    assert.equal(store.panel(guildId)?.messageId, 'panel-1');
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
  reactions: string[] = [];
  operations: string[] = [];
  assignments: { userId: string; roleId: string; enabled: boolean }[] = [];
  failReact = false;
  failDelete = false;
  sequence = 0;

  async exists(panel: PanelState): Promise<boolean> {
    return panel.messageId !== null && this.messages.has(panel.messageId);
  }
  async delete(panel: PanelState): Promise<void> {
    if (this.failDelete) throw new Error('delete failed');
    this.operations.push(`delete:${panel.messageId}`);
    if (panel.messageId) this.messages.delete(panel.messageId);
  }
  async create(content: string): Promise<string> {
    const id = `panel-${++this.sequence}`;
    this.operations.push(`create:${id}`);
    this.messages.set(id, content);
    return id;
  }
  async react(messageId: string, emoji: string): Promise<void> {
    if (this.failReact) throw new Error('react failed');
    this.reactions.push(`${messageId}:${emoji}`);
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

test('설정 변경 시 기존 안내를 먼저 삭제하고 새 안내 하나를 유지한다', async t => {
  const { store, gateway, service } = roleFixture(t);
  await service.ensurePanel();
  const result = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  assert.equal(result.panelUpdated, true);
  assert.deepEqual(gateway.operations, ['create:panel-1', 'delete:panel-1', 'create:panel-2']);
  assert.equal(gateway.messages.size, 1);
  assert.equal(store.panel(guildId)?.dirty, false);
  assert.equal(gateway.assignments.length, 0); // Refresh does not remove existing roles.
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

test('새 안내 메시지의 등록된 이모지만 처리하고 추가·취소 순서를 보존한다', async t => {
  const { store, gateway, service, event } = roleFixture(t);
  await service.ensurePanel();
  await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  await service.handleReaction(event('panel-1')); // Retired message.
  await service.handleReaction({ ...event('panel-2'), channelId: 'other-channel' });
  await service.handleReaction({ ...event('panel-2'), guildId: 'other-guild' });
  await service.handleReaction({ ...event('panel-2'), emojiKey: parseEmoji('📢').key });
  assert.equal(gateway.assignments.length, 0);
  await Promise.all([
    service.handleReaction(event('panel-2', true)),
    service.handleReaction(event('panel-2', false)),
  ]);
  assert.deepEqual(gateway.assignments, [
    { userId, roleId, enabled: true }, { userId, roleId, enabled: false },
  ]);
});

test('이모지 등록 실패 후 DB 설정과 메시지 ID를 보존하고 복구한다', async t => {
  const { store, gateway, service, event } = roleFixture(t);
  await service.ensurePanel();
  gateway.failReact = true;
  const result = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  assert.equal(result.panelUpdated, false);
  assert.equal(store.roleEmojis(guildId).length, 1);
  assert.equal(store.panel(guildId)?.messageId, 'panel-2');
  assert.equal(store.panel(guildId)?.dirty, true);
  await service.handleReaction(event('panel-2'));
  assert.equal(gateway.assignments.length, 0);
  gateway.failReact = false;
  await service.ensurePanel();
  assert.equal(gateway.messages.size, 1);
  assert.equal(store.panel(guildId)?.messageId, 'panel-3');
  assert.equal(store.panel(guildId)?.dirty, false);
});

test('삭제 실패 시 이전 메시지 반응을 변경된 역할에 적용하지 않는다', async t => {
  const { store, gateway, service, event } = roleFixture(t);
  await service.ensurePanel();
  const first = await service.change(async () => store.addRoleEmoji(guildId, mapping()));
  gateway.failDelete = true;
  const changed = await service.change(async () => store.updateRoleEmoji(guildId, first.value.id, mapping('🎮', otherRoleId)));
  assert.equal(changed.panelUpdated, false);
  await service.handleReaction(event('panel-2'));
  assert.equal(gateway.assignments.length, 0);
  gateway.failDelete = false;
  await service.ensurePanel();
  await service.handleReaction(event('panel-3'));
  assert.deepEqual(gateway.assignments, [{ userId, roleId: otherRoleId, enabled: true }]);
});
