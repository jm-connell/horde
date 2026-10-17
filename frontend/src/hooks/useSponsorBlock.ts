import { useEffect, useState } from "react";
import type { SponsorBlockCategory } from "../sponsorBlock";
import { connectivity } from "../offline/connectivity";
import { getAllItems, type OfflineSponsorSegment } from "../offline/db";

export interface SponsorSegment {
  startSec: number;
  endSec: number;
  category: string;
}

export function extractYouTubeId(
  sourceUrl: string | null,
  filePath: string
): string | null {
  for (const text of [sourceUrl ?? "", filePath]) {
    const m =
      text.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
      text.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
      text.match(/\[([A-Za-z0-9_-]{11})\]/);
    if (m) return m[1];
  }
  return null;
}

/** Segments saved with a downloaded copy of this YouTube video, if any. */
async function offlineSponsorSegments(
  ytId: string
): Promise<OfflineSponsorSegment[] | null> {
  try {
    for (const item of await getAllItems()) {
      if (!item.sponsorSegments) continue;
      if (
        extractYouTubeId(item.video.source_url, item.video.file_path) === ytId
      ) {
        return item.sponsorSegments;
      }
    }
  } catch {
    // IndexedDB unavailable
  }
  return null;
}

export function useSponsorBlock(
  sourceUrl: string | null,
  filePath: string,
  enabled: boolean,
  categories: readonly SponsorBlockCategory[]
): SponsorSegment[] {
  const [segments, setSegments] = useState<SponsorSegment[]>([]);
  const catsKey = categories.join(",");

  useEffect(() => {
    const cats = catsKey ? (catsKey.split(",") as SponsorBlockCategory[]) : [];
    if (!enabled || cats.length === 0) {
      setSegments([]);
      return;
    }
    const ytId = extractYouTubeId(sourceUrl, filePath);
    if (!ytId) {
      setSegments([]);
      return;
    }

    let cancelled = false;
    const allowed = new Set(cats);
    const encoded = encodeURIComponent(JSON.stringify(cats));
    const applyOfflineSegments = () =>
      offlineSponsorSegments(ytId).then((segs) => {
        if (cancelled || !segs) return false;
        setSegments(
          segs.filter((s) => allowed.has(s.category as SponsorBlockCategory))
        );
        return true;
      });
    if (connectivity.offlineMode) {
      void applyOfflineSegments().then((ok) => {
        if (!ok && !cancelled) setSegments([]);
      });
      return () => {
        cancelled = true;
      };
    }
    fetch(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${ytId}&categories=${encoded}`
    )
      .then((r) => (r.ok ? r.json() : []))
      .then(
        (
          data: {
            segment: [number, number];
            category: string;
          }[]
        ) => {
          if (cancelled || !Array.isArray(data)) return;
          setSegments(
            data
              .filter((s) => allowed.has(s.category as SponsorBlockCategory))
              .map((s) => ({
                startSec: s.segment[0],
                endSec: s.segment[1],
                category: s.category,
              }))
          );
        }
      )
      .catch(() =>
        applyOfflineSegments().then((ok) => {
          if (!ok && !cancelled) setSegments([]);
        })
      );

    return () => {
      cancelled = true;
    };
  }, [sourceUrl, filePath, enabled, catsKey]);

  return segments;
}
