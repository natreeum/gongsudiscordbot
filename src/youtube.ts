import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { MusicConfig } from './config.js';
import { errorMessage, UserError } from './domain.js';
import { MusicUnavailableError, youtubeUrl, type MusicMetadata } from './music-domain.js';
import type { MusicSource } from './music.js';

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 2000);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

function executionError(command: string, error: Error): Error {
  return new MusicUnavailableError(`${command} 실행 실패: ${error.message}`);
}

function capture(command: string, args: string[], signal: AbortSignal, timeout = 30_000): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const done = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error !== undefined) {
        terminate(child);
        reject(error);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const abort = (): void => done(signal.reason ?? new Error('작업이 취소되었습니다.'));
    const timer = setTimeout(() => done(new Error(`${command} 응답 시간 초과`)), timeout);
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) done(new Error('영상 정보 응답이 너무 큽니다.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.once('error', error => done(executionError(command, error)));
    child.once('close', code => done(code === 0 ? undefined : new Error(`${command} 종료 코드 ${code}: ${stderr.trim()}`)));
    if (signal.aborted) abort();
  });
}

export function youtubeMetadata(value: unknown, url: string): MusicMetadata {
  if (typeof value !== 'object' || value === null) throw new UserError('영상 정보를 확인할 수 없습니다.');
  const data = value as Record<string, unknown>;
  if (data.is_live || data.live_status === 'is_live' || data.live_status === 'is_upcoming'
    || data._type === 'playlist' || Array.isArray(data.entries)) {
    throw new UserError('라이브 방송, 공개 예정 영상, 재생목록은 등록할 수 없습니다.');
  }
  if (typeof data.title !== 'string' || !data.title.trim()
    || typeof data.duration !== 'number' || !Number.isFinite(data.duration)
    || data.duration <= 0 || !Number.isSafeInteger(Math.ceil(data.duration))) {
    throw new UserError('제목과 전체 재생시간을 확인할 수 있는 영상만 등록할 수 있습니다.');
  }
  return { url, title: data.title.trim().slice(0, 500), duration: Math.ceil(data.duration) };
}

export interface AudioPipeline {
  stream: Readable;
  close(): void;
}

export class YouTubeSource implements MusicSource {
  constructor(private readonly config: MusicConfig, private readonly log: (message: string) => void) {}

  private args(): string[] {
    return [
      '--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--no-cache-dir',
      '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '15', '--retries', '1', '--fragment-retries', '1',
    ];
  }

  async check(): Promise<void> {
    const signal = AbortSignal.timeout(10_000);
    await Promise.all([
      capture(this.config.ytDlpPath, ['--version'], signal, 10_000),
      capture(this.config.ffmpegPath, ['-version'], signal, 10_000),
    ]);
  }

  async metadata(input: string, signal: AbortSignal): Promise<MusicMetadata> {
    const url = youtubeUrl(input);
    try {
      const result = await capture(this.config.ytDlpPath, [...this.args(), '--dump-single-json', '--skip-download', '--', url], signal);
      return youtubeMetadata(JSON.parse(result), url);
    } catch (error) {
      if (signal.aborted || error instanceof UserError || error instanceof MusicUnavailableError) throw error;
      this.log(`[음악] YouTube 정보 조회 실패 | ${url} | ${errorMessage(error)}`);
      throw new UserError('영상 정보를 가져오지 못했습니다. 공개된 일반 YouTube 영상인지 확인하세요.');
    }
  }

  audio(input: string, signal: AbortSignal, failed: (error: Error) => void): AudioPipeline {
    signal.throwIfAborted();
    const url = youtubeUrl(input);
    const download = spawn(this.config.ytDlpPath, [...this.args(), '-f', 'bestaudio/best', '-o', '-', '--', url], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    const ffmpeg = spawn(this.config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let closed = false;
    let reported = false;
    let downloadError = '';
    let ffmpegError = '';
    let lastAudio = Date.now();
    const fail = (error: Error): void => {
      if (closed || reported || signal.aborted) return;
      reported = true;
      failed(error);
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastAudio > 45_000) fail(new Error('음원 수신이 45초 이상 중단되었습니다.'));
    }, 5000);
    watchdog.unref();
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      signal.removeEventListener('abort', close);
      download.stdout.unpipe(ffmpeg.stdin);
      ffmpeg.stdin.destroy();
      ffmpeg.stdout.destroy();
      download.stdout.destroy();
      terminate(download);
      terminate(ffmpeg);
    };
    signal.addEventListener('abort', close, { once: true });
    download.stderr.on('data', (chunk: Buffer) => { downloadError = (downloadError + chunk.toString('utf8')).slice(-4000); });
    ffmpeg.stderr.on('data', (chunk: Buffer) => { ffmpegError = (ffmpegError + chunk.toString('utf8')).slice(-4000); });
    download.once('error', error => fail(executionError(this.config.ytDlpPath, error)));
    ffmpeg.once('error', error => fail(executionError(this.config.ffmpegPath, error)));
    download.once('close', code => {
      if (code !== 0) fail(new Error(`YouTube 음원 수신 실패 (${code}): ${downloadError.trim()}`));
    });
    ffmpeg.once('close', code => {
      if (code !== 0) fail(new Error(`FFmpeg 변환 실패 (${code}): ${ffmpegError.trim()}`));
    });
    download.stdout.on('error', fail);
    ffmpeg.stdin.on('error', fail);
    ffmpeg.stdout.on('error', fail);
    ffmpeg.stdout.on('data', () => { lastAudio = Date.now(); });
    download.stdout.pipe(ffmpeg.stdin);
    if (signal.aborted) close();
    return { stream: ffmpeg.stdout, close };
  }
}
