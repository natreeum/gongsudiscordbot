import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canRunCommand } from '../src/commands.js';
import { readConfig } from '../src/config.js';
import { musicCommandDefinitions } from '../src/music-commands.js';
import {
  formatMusicQueue, musicDuration, musicTitle, MusicUnavailableError, youtubeUrl,
  type MusicMetadata, type MusicTrack,
} from '../src/music-domain.js';
import { MusicService, type MusicAccess, type MusicPlayback, type MusicSource } from '../src/music.js';
import { Store } from '../src/store.js';
import { youtubeMetadata } from '../src/youtube.js';

const guildId = '111111111111111111';
const owner = '222222222222222222';
const guest = '333333333333333333';
const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const metadata: MusicMetadata = { url, title: '테스트 곡', duration: 203 };
const access = (userId: string, dj = false): MusicAccess => ({ userId, isDJ: async () => dj });

class FakeSource implements MusicSource {
  async metadata(input: string, signal: AbortSignal): Promise<MusicMetadata> {
    signal.throwIfAborted();
    return { ...metadata, url: input };
  }
}

class FakePlayback implements MusicPlayback {
  sessions: { track: MusicTrack; signal: AbortSignal; ended: (error?: unknown) => void }[] = [];
  stops = 0;
  disconnects = 0;
  async play(track: MusicTrack, signal: AbortSignal, ended: (error?: unknown) => void): Promise<void> {
    this.sessions.push({ track, signal, ended });
  }
  stop(): void { this.stops++; }
  disconnect(): void { this.disconnects++; }
}

function setup(t: TestContext, source: MusicSource = new FakeSource()) {
  const store = new Store(':memory:');
  const playback = new FakePlayback();
  const logs: string[] = [];
  const music = new MusicService(store, guildId, source, playback, message => { logs.push(message); });
  t.after(async () => { await music.close(); store.close(); });
  return { store, playback, music, logs };
}

test('제목은 표시 글자 15개에 ...를 추가하고 시간은 전체 분·초를 표시한다', () => {
  assert.equal(musicTitle('가'.repeat(15)), '가'.repeat(15));
  assert.equal(musicTitle('가'.repeat(16)), '가'.repeat(15) + '...');
  assert.equal(musicTitle('👨‍👩‍👧‍👦'.repeat(16)), '👨‍👩‍👧‍👦'.repeat(15) + '...');
  assert.equal(musicTitle('곡\n제목'), '곡 제목');
  assert.equal(musicDuration(203), '03:23');
  assert.equal(musicDuration(3661), '61:01');
  const track: MusicTrack = { ...metadata, guildId, id: 90, requestedBy: owner, status: 'playing' };
  assert.deepEqual(formatMusicQueue([track, { ...track, id: 150, status: 'queued' }]), [
    '[🎵] 테스트 곡 03:23', '[1] 테스트 곡 03:23',
  ]);
});

test('단일 YouTube URL만 허용하고 외부 호스트 및 로컬 파일을 거부한다', () => {
  for (const input of [url, 'http://youtu.be/dQw4w9WgXcQ?t=10', 'https://youtube.com/shorts/dQw4w9WgXcQ', url + '&list=playlist']) {
    assert.equal(youtubeUrl(input), url);
  }
  for (const input of ['file:///etc/passwd', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ', 'https://youtube.com/playlist?list=123',
    'https://youtube.com:8000/watch?v=dQw4w9WgXcQ', 'https://youtu.be/too-short', '--exec something']) {
    assert.throws(() => youtubeUrl(input));
  }
  assert.deepEqual(youtubeMetadata({ title: '곡', duration: 203.1 }, url), { url, title: '곡', duration: 204 });
  for (const data of [{ is_live: true }, { live_status: 'is_upcoming' }, { duration: null }, { duration: 0 }, { title: '' }]) {
    assert.throws(() => youtubeMetadata({ title: '곡', duration: 203, ...data }, url));
  }
});

test('음악 환경변수는 함께 설정하고 음악 명령어는 일반 사용자에게 공개한다', () => {
  const env = { DISCORD_BOT_TOKEN: 'test', SCHEDULE_ALERT_CHANNEL_ID: guildId, ROLE_EMOJI_CHANNEL_ID: guildId };
  assert.equal(readConfig(env).music, undefined);
  assert.throws(() => readConfig({ ...env, MUSIC_VOICE_CHANNEL_ID: guildId }), /MUSIC_DJ_ROLE_ID/);
  assert.deepEqual(readConfig({ ...env, MUSIC_VOICE_CHANNEL_ID: guildId, MUSIC_DJ_ROLE_ID: owner }).music, {
    voiceChannelId: guildId, djRoleId: owner, ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg',
  });
  assert.equal(musicCommandDefinitions.length, 5);
  for (const command of musicCommandDefinitions) {
    assert.equal(canRunCommand(command.name, false, false), true);
    assert.equal(command.toJSON().default_member_permissions, undefined);
  }
});

test('현재 곡 포함 10곡을 저장하고 메타데이터 조회 중인 추가도 한도에 포함한다', async t => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { music, store } = setup(t, {
    metadata: async input => { await pending; return { ...metadata, url: input }; },
  });
  const additions = Array.from({ length: 10 }, () => music.add(url, owner));
  await assert.rejects(music.add(url, guest), /최대 10곡/);
  release();
  await Promise.all(additions);
  assert.equal(store.musicTracks(guildId).length, 10);
  assert.equal(store.musicTracks(guildId).filter(track => track.status === 'playing').length, 1);
  assert.throws(() => store.addMusicTrack(guildId, owner, metadata), /최대 10곡/);
});

test('등록자와 음악대장만 해당 곡을 변경하고 전체 삭제는 음악대장만 허용한다', async t => {
  const { music, store } = setup(t);
  const current = await music.add(url, owner);
  const waiting = await music.add(url, guest);
  await assert.rejects(music.skip(access(guest)), /등록자 또는 음악대장/);
  await assert.rejects(music.remove(1, access(owner)), /등록자 또는 음악대장/);
  await assert.rejects(music.clear(access(owner)), /음악대장/);
  await music.remove(1, access(guest));
  assert.ok(!store.musicTracks(guildId).some(track => track.id === waiting.id));
  await music.add(url, guest);
  assert.equal(await music.clear(access(guest, true)), 1);
  assert.equal(store.musicTracks(guildId)[0]?.id, current.id);
  await music.skip(access(guest, true));
  assert.equal(store.musicTracks(guildId).length, 0);
});

test('중복 다음곡 요청과 이전 곡의 종료 이벤트는 새로운 곡을 건너뛰지 않는다', async t => {
  const { music, playback, store } = setup(t);
  await music.add(url, owner);
  const second = await music.add(url, owner);
  const third = await music.add(url, owner);
  const firstSession = playback.sessions[0]!;
  const skips = await Promise.allSettled([music.skip(access(owner)), music.skip(access(owner))]);
  assert.equal(skips[0]?.status, 'fulfilled');
  assert.equal(skips[1]?.status, 'rejected');
  assert.equal(firstSession.signal.aborted, true);
  firstSession.ended();
  firstSession.ended(new Error('늦은 오류'));
  await music.idle();
  assert.equal(store.musicTracks(guildId)[0]?.id, second.id);
  const secondSession = playback.sessions[1]!;
  secondSession.ended();
  secondSession.ended();
  await music.idle();
  assert.equal(store.musicTracks(guildId)[0]?.id, third.id);
  playback.sessions[2]!.ended();
  await music.idle();
  assert.equal(store.musicTracks(guildId).length, 0);
  assert.ok(playback.disconnects > 0);
});

test('삭제 대기 중 해당 곡이 재생되면 다른 대기 곡을 대신 삭제하지 않는다', async t => {
  const { music, store } = setup(t);
  await music.add(url, owner);
  const second = await music.add(url, guest);
  const third = await music.add(url, guest);
  const results = await Promise.allSettled([music.skip(access(owner)), music.remove(1, access(guest))]);
  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'rejected');
  assert.deepEqual(store.musicTracks(guildId).map(track => track.id), [second.id, third.id]);
});

test('음원 오류는 다음 곡으로 넘기고 음성 연결 오류는 DB 목록을 유지한다', async t => {
  const { music, playback, store, logs } = setup(t);
  await music.add(url, owner);
  const next = await music.add(url, guest);
  playback.sessions[0]!.ended(new Error('영상 삭제됨'));
  await music.idle();
  assert.equal(store.musicTracks(guildId)[0]?.id, next.id);
  playback.sessions[1]!.ended(new MusicUnavailableError('음성 연결 끊김'));
  await music.idle();
  assert.equal(store.musicTracks(guildId)[0]?.id, next.id);
  assert.ok(music.list()[0]?.includes('복구 중'));
  assert.ok(logs.some(line => line.includes('목록 보존')));
  await music.skip(access(guest));
  assert.equal(store.musicTracks(guildId).length, 0);
});

test('메타데이터 실패는 목록을 바꾸지 않고 등록 예약을 해제한다', async t => {
  const { music, store } = setup(t, { metadata: async () => { throw new Error('조회 실패'); } });
  for (let index = 0; index < 11; index++) await assert.rejects(music.add(url, owner), /조회 실패/);
  assert.equal(store.musicTracks(guildId).length, 0);
});

test('종료는 진행 중인 메타데이터 조회를 취소하고 새 곡을 저장하지 않는다', async t => {
  const { music, store } = setup(t, {
    metadata: async (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('취소됨')), { once: true });
    }),
  });
  const addition = music.add(url, owner);
  const rejection = assert.rejects(addition, /취소됨/);
  await new Promise(resolve => setImmediate(resolve));
  await music.close();
  await rejection;
  assert.equal(store.musicTracks(guildId).length, 0);
});

test('재시작해도 현재 곡·대기 순서·등록자와 전체 길이를 DB에서 복원한다', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gongsu-music-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'bot.sqlite');
  let store = new Store(path);
  let playback = new FakePlayback();
  let music = new MusicService(store, guildId, new FakeSource(), playback, () => {});
  try {
    const first = await music.add(url, owner);
    const second = await music.add(url, guest);
    await music.close();
    store.close();
    store = new Store(path);
    playback = new FakePlayback();
    music = new MusicService(store, guildId, new FakeSource(), playback, () => {});
    await music.resume();
    const tracks = store.musicTracks(guildId);
    assert.deepEqual(tracks.map(track => [track.id, track.status, track.requestedBy, track.duration]), [
      [first.id, 'playing', owner, 203], [second.id, 'queued', guest, 203],
    ]);
    assert.equal(playback.sessions[0]?.track.id, first.id);
    assert.equal(store.musicTracks('another-guild').length, 0);
  } finally { await music.close(); store.close(); }
});
