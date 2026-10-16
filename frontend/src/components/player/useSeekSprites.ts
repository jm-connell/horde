import { useEffect, useState } from "react";
import { api } from "../../api";
import type { SpriteMeta } from "../../types";

/**
 * Seek-preview sprite sheet metadata for a library video. Asks the server to
 * generate the sheet when it is missing and polls for up to a minute.
 */
export function useSeekSprites(videoId: number | undefined): SpriteMeta | null {
  const [spriteMeta, setSpriteMeta] = useState<SpriteMeta | null>(null);

  useEffect(() => {
    if (videoId == null) {
      setSpriteMeta(null);
      return;
    }
    let cancelled = false;
    let pollTimer: number | null = null;
    const pollDeadline = Date.now() + 60_000;

    const applyMeta = (meta: SpriteMeta) => {
      if (!cancelled) setSpriteMeta(meta);
    };

    const load = async () => {
      try {
        const meta = await api.getSpriteMeta(videoId);
        applyMeta(meta);
        return;
      } catch {
        // missing — kick off generation
      }
      if (cancelled) return;
      try {
        const { status } = await api.ensureSprites(videoId);
        if (status === "ready") {
          const meta = await api.getSpriteMeta(videoId);
          applyMeta(meta);
          return;
        }
      } catch {
        return;
      }

      const poll = async () => {
        if (cancelled || Date.now() > pollDeadline) return;
        try {
          const meta = await api.getSpriteMeta(videoId);
          applyMeta(meta);
          return;
        } catch {
          pollTimer = window.setTimeout(poll, 2000);
        }
      };
      pollTimer = window.setTimeout(poll, 2000);
    };

    setSpriteMeta(null);
    void load();
    return () => {
      cancelled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [videoId]);

  return spriteMeta;
}
