import { useEffect, useState } from "react";

export interface SponsorSegment {
  startSec: number;
  endSec: number;
  category: string;
}

function extractYouTubeId(
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

const CATEGORIES = ["sponsor", "selfpromo", "interaction", "intro", "outro"];

export function useSponsorBlock(
  sourceUrl: string | null,
  filePath: string,
  enabled: boolean
): SponsorSegment[] {
  const [segments, setSegments] = useState<SponsorSegment[]>([]);

  useEffect(() => {
    if (!enabled) {
      setSegments([]);
      return;
    }
    const ytId = extractYouTubeId(sourceUrl, filePath);
    if (!ytId) {
      setSegments([]);
      return;
    }

    let cancelled = false;
    const cats = encodeURIComponent(JSON.stringify(CATEGORIES));
    fetch(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${ytId}&categories=${cats}`
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
            data.map((s) => ({
              startSec: s.segment[0],
              endSec: s.segment[1],
              category: s.category,
            }))
          );
        }
      )
      .catch(() => {
        if (!cancelled) setSegments([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sourceUrl, filePath, enabled]);

  return segments;
}
