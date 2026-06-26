export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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
