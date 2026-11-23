import { useEffect, useRef } from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";
import {
  trackQuality,
  writeBandwidthEstimate,
  writeDowngrade,
} from "../utils/decodeCapability";

export const POLL_MS = 2000;
const DROP_RATIO_THRESHOLD = 0.1;
export const SUSTAINED_MS = 6000;
/** YouTube ladder steps for auto-downgrade. */
const QUALITY_STEPS = [2160, 1440, 1080, 720, 480];

export type HealthDowngrade = {
  /** Nominal YouTube quality ceiling (1080, 720, …). */
  maxHeight: number;
  blacklistAv1: boolean;
  notice: string;
};

export type FrameSample = {
  now: number;
  /** Shaka's running counts (`getStats()`). */
  dropped: number;
  decoded: number;
  /** The page's window has focus (`document.hasFocus()`). */
  focused: boolean;
};

/**
 * Tells when the decoder has kept dropping frames, sampled every `POLL_MS`.
 * `check` answers true once per bad stretch of `SUSTAINED_MS`. Samples taken
 * while another window has focus do not count: a fullscreen game on the
 * other monitor holding the GPU says nothing about what this device can
 * play, and the cut it would cause is remembered for later streams.
 */
export class FrameDropWatch {
  private prev: { dropped: number; decoded: number } | null = null;
  private badSince: number | null = null;

  check(s: FrameSample): boolean {
    if (!s.focused) {
      // Measure afresh once focus is back: no delta spans time away.
      this.prev = null;
      this.badSince = null;
      return false;
    }
    const prev = this.prev;
    this.prev = { dropped: s.dropped, decoded: s.decoded };
    if (!prev) return false;
    const dDrop = s.dropped - prev.dropped;
    const dDec = s.decoded - prev.decoded;
    if (dDec < 15) return false; // not enough samples

    if (dDrop / dDec < DROP_RATIO_THRESHOLD) {
      this.badSince = null;
      return false;
    }
    if (this.badSince == null) this.badSince = s.now;
    if (s.now - this.badSince < SUSTAINED_MS) return false;
    this.badSince = null;
    return true;
  }
}

type Options = {
  enabled: boolean;
  player: ShakaPlayer | null;
  onDowngrade: (next: HealthDowngrade) => void;
};

/**
 * Poll Shaka getStats() and auto-downgrade quality when the decoder is
 * dropping frames (the usual cause of perceived A/V desync at 4K AV1).
 */
export function usePlaybackHealth({
  enabled,
  player,
  onDowngrade,
}: Options): void {
  const onDowngradeRef = useRef(onDowngrade);
  onDowngradeRef.current = onDowngrade;

  useEffect(() => {
    if (!enabled || !player) return;
    const watch = new FrameDropWatch();

    const tick = () => {
      let stats: ReturnType<ShakaPlayer["getStats"]>;
      try {
        stats = player.getStats();
      } catch {
        return;
      }
      if (!stats) return;

      if (
        typeof stats.estimatedBandwidth === "number" &&
        stats.estimatedBandwidth > 100_000
      ) {
        writeBandwidthEstimate(stats.estimatedBandwidth);
      }

      const dropped = stats.droppedFrames ?? 0;
      const decoded = stats.decodedFrames ?? 0;
      if (
        watch.check({
          now: Date.now(),
          dropped,
          decoded,
          focused: document.hasFocus(),
        })
      ) {
        const tracks = player.getVariantTracks() ?? [];
        const active = tracks.find((t) => t.active);
        const currentQuality = active ? trackQuality(active) : 2160;
        const nextQuality =
          QUALITY_STEPS.find((q) => q < currentQuality) ?? 480;
        const isAv1 = (active?.videoCodec ?? "")
          .toLowerCase()
          .startsWith("av01");

        console.info("[preview-health] downgrade", {
          droppedFrames: dropped,
          decodedFrames: decoded,
          stallsDetected: stats.stallsDetected,
          gapsJumped: stats.gapsJumped,
          corruptedFrames: stats.corruptedFrames,
          currentQuality,
          nextQuality,
          activeWidth: active?.width,
          activeHeight: active?.height,
          isAv1,
        });

        writeDowngrade({
          maxHeight: nextQuality,
          blacklistAv1: isAv1,
        });
        onDowngradeRef.current({
          maxHeight: nextQuality,
          blacklistAv1: isAv1,
          notice: "Reduced quality for smooth playback",
        });
      }
    };

    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, player]);
}
