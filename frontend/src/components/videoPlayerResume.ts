/**
 * Whether a resume position should move the playhead.
 *
 * Sprite sheets, subtitles, and chapters refresh the playing video every few
 * seconds. Each refresh republishes `last_position_sec`, which is the last
 * progress save (at most once every 5s) and therefore sits a second or two
 * behind live playback. Seeking to it jumps the video backward for as long
 * as that work runs.
 *
 * Apply the position when the media source changes, or before playback has
 * left the start. Once this source is already playing, leave the playhead
 * alone — user seeks go through the player, not this prop.
 */
export function shouldApplyResumePosition(opts: {
  currentTime: number;
  resumeAt: number;
  sourceChanged: boolean;
}): boolean {
  if (!(opts.resumeAt > 1)) return false;
  if (opts.sourceChanged) return true;
  return !(opts.currentTime > 1);
}
