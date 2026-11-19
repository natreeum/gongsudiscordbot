import { errorMessage, SerialQueue, UserError } from './domain.js';
import {
  formatMusicQueue, MAX_MUSIC_TRACKS, MusicUnavailableError, youtubeUrl,
  type MusicMetadata, type MusicTrack,
} from './music-domain.js';
import { Store } from './store.js';

export interface MusicSource {
  metadata(url: string, signal: AbortSignal): Promise<MusicMetadata>;
}

export interface MusicPlayback {
  play(track: MusicTrack, signal: AbortSignal, ended: (error?: unknown) => void): Promise<void>;
  stop(): void;
  disconnect(): void;
}

export interface MusicAccess {
  userId: string;
  isDJ(): Promise<boolean>;
}

interface PlaybackSession {
  track: MusicTrack;
  abort: AbortController;
}

export class MusicService {
  private readonly changes = new SerialQueue();
  private readonly additions = new SerialQueue();
  private readonly shutdown = new AbortController();
  private active: PlaybackSession | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private pendingAdditions = 0;
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly guildId: string,
    private readonly source: MusicSource,
    private readonly playback: MusicPlayback,
    private readonly log: (message: string) => void = console.log,
  ) {}

  resume(): Promise<void> {
    return this.changes.run(async () => { this.ensurePlayback(); });
  }

  list(): string[] {
    this.assertOpen();
    const lines = formatMusicQueue(this.store.musicTracks(this.guildId));
    return this.retryTimer ? ['음성 재생 연결을 복구 중입니다. 재생목록은 보존됩니다.', ...lines] : lines;
  }

  async add(input: string, userId: string): Promise<MusicTrack> {
    this.assertOpen();
    const url = youtubeUrl(input);
    if (this.store.musicTracks(this.guildId).length + this.pendingAdditions >= MAX_MUSIC_TRACKS) {
      throw new UserError(`재생 중이거나 등록 처리 중인 곡을 포함해 최대 ${MAX_MUSIC_TRACKS}곡까지 등록할 수 있습니다.`);
    }
    this.pendingAdditions++;
    try {
      // Preserve request order without blocking skip/delete behind metadata retrieval.
      return await this.additions.run(async () => {
        this.assertOpen();
        const metadata = await this.source.metadata(url, this.shutdown.signal);
        return this.changes.run(async () => {
          this.assertOpen();
          const track = this.store.addMusicTrack(this.guildId, userId, { ...metadata, url });
          this.log(`[음악] 곡 등록 | ID: ${track.id} | 등록자: ${userId}`);
          this.ensurePlayback();
          return track;
        });
      });
    } finally { this.pendingAdditions--; }
  }

  skip(access: MusicAccess): Promise<void> {
    this.assertOpen();
    // Bind the command to this track, not whichever track is playing after an await.
    const target = this.store.musicTracks(this.guildId).find(track => track.status === 'playing');
    return this.changes.run(async () => {
      this.assertOpen();
      if (!target) throw new UserError('현재 재생 중인 곡이 없습니다.');
      await this.authorize(target, access);
      const current = this.store.musicTracks(this.guildId).find(track => track.status === 'playing');
      if (current?.id !== target.id) throw new UserError('이미 다음 곡으로 변경되었습니다. 재생목록을 다시 확인하세요.');
      this.cancelPlayback();
      this.store.removeMusicTrack(this.guildId, target.id);
      this.log(`[음악] 곡 건너뛰기 | ID: ${target.id} | 요청자: ${access.userId}`);
      this.ensurePlayback();
    });
  }

  remove(index: number, access: MusicAccess): Promise<void> {
    this.assertOpen();
    const target = Number.isInteger(index) && index >= 1
      ? this.store.musicTracks(this.guildId).filter(track => track.status === 'queued')[index - 1] : undefined;
    return this.changes.run(async () => {
      this.assertOpen();
      if (!target) throw new UserError('해당 번호의 대기 곡이 없습니다. 재생목록을 다시 확인하세요.');
      await this.authorize(target, access);
      if (!this.store.musicTracks(this.guildId).some(track => track.id === target.id && track.status === 'queued')) {
        throw new UserError('해당 곡이 재생되었거나 삭제되었습니다. 재생목록을 다시 확인하세요.');
      }
      this.store.removeMusicTrack(this.guildId, target.id);
      this.log(`[음악] 대기 곡 삭제 | ID: ${target.id} | 요청자: ${access.userId}`);
    });
  }

  clear(access: MusicAccess): Promise<number> {
    return this.changes.run(async () => {
      this.assertOpen();
      if (!await access.isDJ()) throw new UserError('음악대장 역할 보유자만 대기 목록을 전체 삭제할 수 있습니다.');
      this.assertOpen();
      const count = this.store.clearWaitingMusic(this.guildId);
      this.log(`[음악] 대기 목록 전체 삭제 | ${count}곡 | 요청자: ${access.userId}`);
      return count;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    this.cancelPlayback();
    this.playback.disconnect();
    await Promise.all([this.changes.idle(), this.additions.idle()]);
    // Keep the playing row so a restart resumes this track from the beginning.
  }

  async idle(): Promise<void> { await this.changes.idle(); }

  private assertOpen(): void {
    if (this.closed) throw new UserError('봇이 종료 중입니다. 잠시 후 다시 시도하세요.');
  }

  private async authorize(track: MusicTrack, access: MusicAccess): Promise<void> {
    if (track.requestedBy !== access.userId && !await access.isDJ()) {
      throw new UserError('해당 곡의 등록자 또는 음악대장 역할 보유자만 사용할 수 있습니다.');
    }
    this.assertOpen();
  }

  private cancelPlayback(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const session = this.active;
    this.active = undefined;
    session?.abort.abort();
    this.playback.stop();
  }

  private ensurePlayback(): void {
    if (this.closed || this.active || this.retryTimer) return;
    const track = this.store.claimMusicTrack(this.guildId);
    if (!track) {
      this.playback.disconnect();
      this.log('[음악] 재생목록 비어 있음 | 음성채널 연결 해제');
      return;
    }
    const session: PlaybackSession = { track, abort: new AbortController() };
    this.active = session;
    this.log(`[음악] 재생 준비 | ID: ${track.id} | ${track.url}`);
    const ended = (error?: unknown): void => {
      if (this.closed || this.active !== session) return;
      void this.changes.run(async () => { this.finish(session, error); })
        .catch(failure => this.log(`[음악] 곡 전환 실패: ${errorMessage(failure)}`));
    };
    void this.playback.play(track, session.abort.signal, ended)
      .then(() => {
        if (!this.closed && this.active === session) this.log(`[음악] 재생 시작 | ID: ${track.id}`);
      })
      .catch(ended);
  }

  private finish(session: PlaybackSession, error?: unknown): void {
    if (this.closed || this.active !== session) return;
    this.cancelPlayback();
    if (error instanceof MusicUnavailableError) {
      this.playback.disconnect();
      this.log(`[음악] 연결/실행 환경 오류 (목록 보존, 30초 후 재시도): ${errorMessage(error)}`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.resume().catch(failure => this.log(`[음악] 복구 실패: ${errorMessage(failure)}`));
      }, 30_000);
      this.retryTimer.unref();
      return;
    }
    this.store.removeMusicTrack(this.guildId, session.track.id);
    this.log(error === undefined
      ? `[음악] 재생 완료 | ID: ${session.track.id}`
      : `[음악] 재생 실패, 다음 곡으로 이동 | ID: ${session.track.id} | ${errorMessage(error)}`);
    this.ensurePlayback();
  }
}
