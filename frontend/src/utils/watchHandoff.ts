/** One-shot resume position for preview → watch (survives Strict Mode remounts). */
let pending: { videoId: number; resumeAt: number } | null = null;

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
