/** One-shot resume position for preview → watch (survives Strict Mode remounts). */
let pending: { videoId: number; resumeAt: number } | null = null;

/**
 * True when Watch is about to load a different target than the live player.
 * The current media must drop its fetches so the new meta/stream request
 * is not starved (DASH preview can pin the browser's per-origin sockets).
 */
export function shouldSuspendPlaybackForWatch(opts: {
  playingStreamUrl: string | null | undefined;
  playingVideoId: number | null | undefined;
  nextStreamUrl?: string | null;
  nextVideoId?: number | null;
}): boolean {
  if (opts.nextStreamUrl) {
    if (!opts.playingStreamUrl && opts.playingVideoId == null) return false;
    return opts.playingStreamUrl !== opts.nextStreamUrl;
  }
  if (opts.nextVideoId != null) {
    if (opts.playingStreamUrl) return true;
    return (
      opts.playingVideoId != null && opts.playingVideoId !== opts.nextVideoId
    );
  }
  return false;
}

export function setWatchResume(videoId: number, resumeAt: number): void {
  if (!Number.isFinite(resumeAt) || resumeAt <= 1) {
    pending = null;
    return;
  }
  pending = { videoId, resumeAt };
}

export function peekWatchResume(videoId: number): number | null {
  if (pending?.videoId !== videoId) return null;
  return pending.resumeAt;
}

export function clearWatchResume(videoId: number): void {
  if (pending?.videoId === videoId) pending = null;
}
