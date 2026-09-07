import type { SponsorSegment } from "../hooks/useSponsorBlock";

/** Ignore tiny backward jitter so normal playback does not unskip. */
const SEEK_BACK_EPS_SEC = 0.05;

export function sponsorSegmentKey(seg: {
  startSec: number;
  endSec: number;
}): string {
  return `${seg.startSec}-${seg.endSec}`;
}

/**
 * If the playhead jumped backward into a segment, stop auto-skipping it so
 * timeline / arrow-key seeks can watch a section that was already skipped.
 */
export function suppressSponsorSegmentsOnBackwardSeek(
  fromSec: number,
  toSec: number,
  segments: readonly SponsorSegment[],
  suppressed: Set<string>
): void {
  if (!(toSec < fromSec - SEEK_BACK_EPS_SEC)) return;
  for (const seg of segments) {
    if (toSec >= seg.startSec && toSec < seg.endSec) {
      suppressed.add(sponsorSegmentKey(seg));
    }
  }
}
