export function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return "";
  return formatTimestamp(seconds);
}

export function formatTimestamp(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function parseTimestampToSeconds(
  h: string | undefined,
  min: string,
  sec: string
): number {
  return (
    (h ? parseInt(h, 10) * 3600 : 0) +
    parseInt(min, 10) * 60 +
    parseInt(sec, 10)
  );
}

// Inline timestamps in description text (H:MM:SS or MM:SS).
export const TIMESTAMP_INLINE_RE =
  /(?<!\d)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?!\d)/g;

export function parseInlineTimestamp(match: RegExpExecArray): number {
  const [, h, min, sec] = match;
  return parseTimestampToSeconds(h, min, sec);
}

export interface Chapter {
  startSec: number;
  title: string;
}

export function parseChapters(description: string | null): Chapter[] {
  if (!description) return [];
  const TIME_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\s*[-–—|·•:→]?\s*)(.+)/;
  const chapters: Chapter[] = [];
  for (const rawLine of description.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(TIME_RE);
    if (!m) continue;
    const [, h, min, sec, rest] = m;
    const secs = parseTimestampToSeconds(h, min, sec);
    const title = rest.trim().replace(/^\((.+)\)$/, "$1");
    if (title) chapters.push({ startSec: secs, title });
  }
  if (chapters.length < 2) return [];
  // Chapters must be in strictly ascending order to be valid
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].startSec <= chapters[i - 1].startSec) return [];
  }
  return chapters;
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

interface LangTrack {
  lang: string;
}

// Keep one track per base language so variants (en, en-orig, en-US) don't show
// as duplicate CC options. The original lang string is preserved for the URL.
export function dedupeSubtitleTracks<T extends LangTrack>(tracks: T[]): T[] {
  const byBase = new Map<string, T>();
  for (const track of tracks) {
    const base = track.lang.split("-")[0].toLowerCase();
    const existing = byBase.get(base);
    if (!existing || track.lang.toLowerCase() === base) {
      byBase.set(base, track);
    }
  }
  return Array.from(byBase.values());
}

export function formatResolution(height: number | null): string {
  if (!height || height <= 0) return "";
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  return `${height}p`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatViewCount(count: number | null): string {
  if (count === null || count < 0) return "";
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B views`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`;
  return `${count} views`;
}

export function youtubeThumbnailUrl(
  videoId: string | null,
  thumbnailUrl?: string | null
): string | null {
  const raw = thumbnailUrl?.trim();
  if (raw) {
    if (raw.startsWith("//")) return `https:${raw}`;
    if (raw.startsWith("http")) return raw;
  }
  if (videoId) return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  return null;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  return `${Math.floor(diffMo / 12)}y ago`;
}

/** Source URL for re-downloading; falls back to YouTube id in the file path. */
export function effectiveSourceUrl(video: {
  source_url: string | null;
  file_path: string;
}): string | null {
  if (video.source_url?.trim()) return video.source_url.trim();
  const match = video.file_path.match(/\[([A-Za-z0-9_-]{11})\]/);
  if (match) return `https://www.youtube.com/watch?v=${match[1]}`;
  return null;
}
