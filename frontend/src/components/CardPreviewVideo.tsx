import { useEffect, useRef, useState, type MouseEvent } from "react";
import { loadSettings } from "../hooks/useSettings";
import {
  PREVIEW_MUTE_EVENT,
  PREVIEW_UNLOAD_DELAY_MS,
  readPreviewMuted,
  reportPreviewTime,
  writePreviewMuted,
} from "../utils/cardPreview";

function MuteGlyph({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M11 5 6 9H2v6h4l5 4V5z" />
        <path d="m22 9-6 6M16 9l6 6" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

export default function CardPreviewVideo({
  videoId,
  src,
  startSec,
  active,
}: {
  videoId: number;
  src: string;
  startSec: number;
  active: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wantMutedRef = useRef(readPreviewMuted());
  const [mounted, setMounted] = useState(active);
  const [ready, setReady] = useState(false);
  const [playingMuted, setPlayingMuted] = useState(true);

  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => {
      setMounted(false);
      setReady(false);
    }, PREVIEW_UNLOAD_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [active]);

  useEffect(() => {
    const sync = () => {
      const muted = readPreviewMuted();
      wantMutedRef.current = muted;
      const el = videoRef.current;
      if (el) {
        el.muted = muted;
        el.defaultMuted = muted;
      }
      setPlayingMuted(muted || Boolean(el?.muted));
    };
    window.addEventListener(PREVIEW_MUTE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PREVIEW_MUTE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !mounted) return;

    el.playsInline = true;
    el.volume = loadSettings().volume;

    if (!active) {
      el.pause();
      return;
    }

    const applyMute = (muted: boolean) => {
      el.muted = muted;
      el.defaultMuted = muted;
      setPlayingMuted(muted);
    };

    const begin = () => {
      applyMute(wantMutedRef.current);
      void el.play().catch(() => {
        if (!wantMutedRef.current) {
          applyMute(true);
          void el.play().catch(() => undefined);
        }
      });
    };
    const onLoadedData = () => setReady(true);
    const onTimeUpdate = () => {
      reportPreviewTime(videoId, startSec, el.currentTime);
    };
    const onEnded = () => {
      el.currentTime = startSec;
      begin();
    };
    const tryPlay = () => {
      if (startSec > 0 && Math.abs(el.currentTime - startSec) > 0.35) {
        el.addEventListener("seeked", begin, { once: true });
        el.currentTime = startSec;
        return;
      }
      begin();
    };

    applyMute(wantMutedRef.current);
    el.addEventListener("loadeddata", onLoadedData);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("ended", onEnded);
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      onLoadedData();
      tryPlay();
    } else {
      el.addEventListener("loadeddata", tryPlay, { once: true });
    }

    return () => {
      el.removeEventListener("loadeddata", onLoadedData);
      el.removeEventListener("loadeddata", tryPlay);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("seeked", begin);
      el.pause();
    };
  }, [active, mounted, src, startSec, videoId]);

  const toggleMute = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = videoRef.current;
    const next = !(el?.muted ?? playingMuted);
    wantMutedRef.current = next;
    writePreviewMuted(next);
    if (el) {
      el.muted = next;
      el.defaultMuted = next;
      setPlayingMuted(next);
      if (!next) void el.play().catch(() => undefined);
    } else {
      setPlayingMuted(next);
    }
  };

  if (!mounted) return null;

  return (
    <>
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden
        tabIndex={-1}
        className={`pointer-events-none absolute inset-0 z-[1] h-full w-full object-cover transition-opacity duration-200 ${
          ready && active ? "opacity-100" : "opacity-0"
        }`}
        data-horde="card-preview"
      />
      {ready && active ? (
        <button
          type="button"
          onClick={toggleMute}
          onPointerDown={(e) => e.stopPropagation()}
          title={playingMuted ? "Unmute preview" : "Mute preview"}
          aria-label={playingMuted ? "Unmute preview" : "Mute preview"}
          className="absolute bottom-2 left-2 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-gray-100 opacity-80 ring-1 ring-white/15 hover:bg-black/75 hover:opacity-100"
        >
          <MuteGlyph muted={playingMuted} />
        </button>
      ) : null}
    </>
  );
}
