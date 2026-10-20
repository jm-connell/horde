import type { ConfirmOptions } from "../components/ConfirmDialog";
import { formatSize } from "../utils";

/** Past live streams longer than this get a storage warning before download. */
export const LONG_STREAM_SEC = 2 * 60 * 60;

/** A recording of a finished live stream, from yt-dlp's live_status. */
export function isPastStream(liveStatus: string | null | undefined): boolean {
  return liveStatus === "was_live" || liveStatus === "post_live";
}

export function isLongStream(
  pastStream: boolean,
  durationSec: number | null | undefined
): boolean {
  return pastStream && durationSec != null && durationSec > LONG_STREAM_SEC;
}

function hoursLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The confirm dialog shown before downloading a long past live stream.
 * `sizeBytes` is the estimated size at the chosen quality, when known.
 */
export function longStreamConfirm(
  durationSec: number,
  sizeBytes?: number | null
): ConfirmOptions {
  const storage = sizeBytes
    ? `about ${formatSize(sizeBytes)} of storage at this quality`
    : "a lot of storage (often several GB at high quality)";
  return {
    title: "Download a long livestream?",
    body: `This livestream is ${hoursLabel(durationSec)} long. Downloading it can take a while and use ${storage}.`,
    confirmLabel: "Download anyway",
  };
}
