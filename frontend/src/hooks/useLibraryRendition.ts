import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Rendition } from "../api";
import type { CompatState, Video } from "../types";
import {
  checkOriginalSupport,
  chooseRendition,
  type OriginalSupport,
} from "../utils/playbackRendition";
import type { DownloadVideoCodec } from "./useSettings";

export type LibraryRenditionState = {
  /** null while checking, or when nothing playable exists for this device. */
  rendition: Rendition | null;
  checking: boolean;
  support: OriginalSupport;
  /** Sidecar job progress while the device waits on it. */
  compat: CompatState | null;
  /** True when the original failed to play (not just predicted to). */
  originalFailed: boolean;
  requestCompat: () => void;
  /** Play the original even though the device probably cannot decode it. */
  forceOriginal: () => void;
  /** VideoPlayer onError hook: returns true when handled here. */
  handleOriginalError: () => boolean;
};

const POLL_MS = 2000;

export function useLibraryRendition(
  video: Video | null,
  mode: DownloadVideoCodec,
  onCompatReady: (video: Video) => void
): LibraryRenditionState {
  const [support, setSupport] = useState<OriginalSupport>("unknown");
  const [checking, setChecking] = useState(true);
  const [forced, setForced] = useState(false);
  const [originalFailed, setOriginalFailed] = useState(false);
  const [compat, setCompat] = useState<CompatState | null>(null);
  const autoRequested = useRef<number | null>(null);
  const readyRef = useRef(onCompatReady);
  readyRef.current = onCompatReady;

  const videoId = video?.id ?? null;
  const offline = videoId != null && videoId < 0;

  useEffect(() => {
    setForced(false);
    setOriginalFailed(false);
    setCompat(video?.compat ?? null);
    if (!video || offline) {
      setSupport("unknown");
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    checkOriginalSupport(video).then((s) => {
      if (cancelled) return;
      setSupport(s);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check per file
  }, [videoId, video?.codec_string, video?.file_path]);

  const effectiveSupport: OriginalSupport = originalFailed
    ? "unsupported"
    : support;
  const choice = video
    ? chooseRendition(effectiveSupport, video, { forceOriginal: forced })
    : { rendition: null };
  const blocked = !checking && video != null && choice.rendition === null;

  const requestCompat = useCallback(() => {
    if (videoId == null || offline) return;
    api
      .requestCompat(videoId)
      .then(setCompat)
      .catch((err: unknown) =>
        setCompat({
          kind: "compat",
          status: "error",
          stage: null,
          progress: 0,
          error:
            err instanceof Error
              ? err.message
              : "Could not start the conversion",
        })
      );
  }, [videoId, offline]);

  // Sidecar mode promises "it just plays": start the copy without asking.
  useEffect(() => {
    if (!blocked || mode !== "sidecar" || videoId == null) return;
    if (autoRequested.current === videoId) return;
    const status = compat?.status ?? "none";
    if (status === "none") {
      autoRequested.current = videoId;
      requestCompat();
    }
  }, [blocked, mode, videoId, compat?.status, requestCompat]);

  // Poll while a job is pending; swap to the sidecar when it lands.
  const pending = compat?.status === "queued" || compat?.status === "running";
  useEffect(() => {
    if (!pending || videoId == null) return;
    const timer = window.setInterval(() => {
      api
        .getCompat(videoId)
        .then((state) => {
          setCompat(state);
          if (state.status === "ready") {
            api
              .getVideo(videoId)
              .then((v) => readyRef.current(v))
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, videoId]);

  const handleOriginalError = useCallback((): boolean => {
    if (!video || offline) return false;
    if (choice.rendition !== "original") return false;
    // H.264 originals failing is a real error (missing file, network).
    if (video.vcodec === "h264" && (video.bit_depth ?? 8) <= 8) return false;
    setForced(false);
    setOriginalFailed(true);
    return true;
  }, [video, offline, choice.rendition]);

  return {
    rendition: checking ? null : choice.rendition,
    checking,
    support: effectiveSupport,
    compat,
    originalFailed,
    requestCompat,
    forceOriginal: () => setForced(true),
    handleOriginalError,
  };
}
