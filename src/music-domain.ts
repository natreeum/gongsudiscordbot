import { UserError } from './domain.js';

export const MAX_MUSIC_TRACKS = 10;

export interface MusicMetadata {
  url: string;
  title: string;
  duration: number;
}

export interface MusicTrack extends MusicMetadata {
  id: number;
  guildId: string;
  requestedBy: string;
  status: 'queued' | 'playing';
}

// Infrastructure failures retain the queue for a retry; a bad track is skipped.
export class MusicUnavailableError extends Error {}

export function youtubeUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new UserError('유효한 YouTube 영상 링크를 입력하세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new UserError('YouTube 영상의 http 또는 https 링크만 사용할 수 있습니다.');
  }
  let id: string | null = null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'youtu.be') {
    if (parts.length === 1) id = parts[0]!;
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0]!)) id = parts[1]!;
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new UserError('YouTube 단일 영상 링크를 입력하세요. 재생목록 전체 추가는 지원하지 않습니다.');
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

const characters = new Intl.Segmenter('ko', { granularity: 'grapheme' });

export function musicTitle(title: string): string {
  const clean = title.replace(/[\p{Cc}\p{Cf}]/gu, char => char === '\u200d' ? char : ' ').replace(/\s+/g, ' ').trim();
  const parts = [...characters.segment(clean)].map(part => part.segment);
  return parts.slice(0, 15).join('') + (parts.length > 15 ? '...' : '');
}

export function musicDuration(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

export function formatMusicTrack(track: MusicMetadata, marker: string | number): string {
  // Titles are external text. Escape Markdown without changing the displayed character count.
  const title = musicTitle(track.title).replace(/([\\`*_{}\[\]()<>#+.!|~\-])/g, '\\$1');
  return `[${marker}] ${title} ${musicDuration(track.duration)}`;
}

export function formatMusicQueue(tracks: readonly MusicTrack[]): string[] {
  let index = 0;
  return tracks.length
    ? tracks.map(track => formatMusicTrack(track, track.status === 'playing' ? '🎵' : ++index))
    : ['재생목록이 비어 있습니다.'];
}
