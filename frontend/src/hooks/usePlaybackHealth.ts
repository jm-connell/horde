import { useEffect, useRef } from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";
import {
  writeBandwidthEstimate,
  writeDowngrade,
} from "../utils/decodeCapability";

const POLL_MS = 2000;
const DROP_RATIO_THRESHOLD = 0.1;
const SUSTAINED_MS = 6000;
const HEIGHT_STEPS = [2160, 1440, 1080, 720, 480];

export type HealthDowngrade = {
  maxHeight: number;
  blacklistAv1: boolean;
  notice: string;
};

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
  const prevRef = useRef<{
    dropped: number;
    decoded: number;
    at: number;
  } | null>(null);
  const badSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !player) return;

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
      const now = Date.now();
      const prev = prevRef.current;
      prevRef.current = { dropped, decoded, at: now };

      if (!prev) return;
      const dDrop = dropped - prev.dropped;
      const dDec = decoded - prev.decoded;
      if (dDec < 15) return; // not enough samples

      const ratio = dDrop / dDec;
      if (ratio >= DROP_RATIO_THRESHOLD) {
        if (badSinceRef.current == null) badSinceRef.current = now;
        if (now - badSinceRef.current < SUSTAINED_MS) return;

        const tracks = player.getVariantTracks() ?? [];
        const active = tracks.find((t) => t.active);
        const currentHeight = active?.height ?? 2160;
        const nextHeight =
          HEIGHT_STEPS.find((h) => h < currentHeight) ?? 480;
        const isAv1 = (active?.videoCodec ?? "")
          .toLowerCase()
          .startsWith("av01");

        console.info("[preview-health] downgrade", {
          droppedFrames: dropped,
          decodedFrames: decoded,
          ratio,
          stallsDetected: stats.stallsDetected,
          gapsJumped: stats.gapsJumped,
          corruptedFrames: stats.corruptedFrames,
          currentHeight,
          nextHeight,
          isAv1,
        });

        writeDowngrade({
          maxHeight: nextHeight,
          blacklistAv1: isAv1,
        });
        onDowngradeRef.current({
          maxHeight: nextHeight,
          blacklistAv1: isAv1,
          notice: "Reduced quality for smooth playback",
        });
        badSinceRef.current = null;
      } else {
        badSinceRef.current = null;
      }
    };

    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [enabled, player]);
}
