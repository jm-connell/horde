import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  releaseActiveCardPreview,
  retainActiveCardPreview,
} from "../hooks/useCardPreview";
import { loadSettings, useSettings } from "../hooks/useSettings";
import { formatTimestamp } from "../utils";
import { PREVIEW_UNLOAD_DELAY_MS, reportPreviewTime } from "../utils/cardPreview";
import { scrubPositionFromClientX } from "./playerSeek";

function stopCardNav(e: { preventDefault: () => void; stopPropagation: () => void }) {
  e.preventDefault();
  e.stopPropagation();
}

function paintPreviewProgress(
  fill: HTMLDivElement | null,
  knob: HTMLDivElement | null,
  ratio: number
) {
  const clamped = Math.min(1, Math.max(0, ratio));
  if (fill) fill.style.transform = `scaleX(${clamped})`;
  if (knob) knob.style.left = `${clamped * 100}%`;
}

function cardForSeekBar(from: EventTarget | null): HTMLElement | null {
  if (!(from instanceof Element)) return null;
  const card = from.closest("a.ui-card");
  return card instanceof HTMLElement ? card : null;
}

function PreviewSeekBar({
  videoRef,
  videoId,
  startSec,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  videoId: number;
  startSec: number;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const retainedRef = useRef(false);
  const scrubCardRef = useRef<HTMLElement | null>(null);
  const scrubClearTimer = useRef<number | null>(null);
  const videoIdRef = useRef(videoId);
  const startSecRef = useRef(startSec);
  videoIdRef.current = videoId;
  startSecRef.current = startSec;

  const clearScrubLock = () => {
    if (scrubClearTimer.current != null) {
      window.clearTimeout(scrubClearTimer.current);
      scrubClearTimer.current = null;
    }
    scrubCardRef.current?.removeAttribute("data-preview-scrubbing");
    scrubCardRef.current = null;
  };

  useLayoutEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const paintFromVideo = () => {
      if (draggingRef.current) return;
      const duration = el.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        paintPreviewProgress(fillRef.current, knobRef.current, 0);
        return;
      }
      paintPreviewProgress(
        fillRef.current,
        knobRef.current,
        el.currentTime / duration
      );
    };

    paintFromVideo();
    el.addEventListener("timeupdate", paintFromVideo);
    el.addEventListener("seeked", paintFromVideo);
    el.addEventListener("durationchange", paintFromVideo);
    return () => {
      el.removeEventListener("timeupdate", paintFromVideo);
      el.removeEventListener("seeked", paintFromVideo);
      el.removeEventListener("durationchange", paintFromVideo);
    };
  }, [videoRef]);

  useEffect(() => {
    return () => {
      clearScrubLock();
      if (!retainedRef.current) return;
      retainedRef.current = false;
      releaseActiveCardPreview();
    };
  }, []);

  const setEngaged = (on: boolean) => {
    barRef.current?.toggleAttribute("data-engaged", on);
  };

  const showTip = (pct: number, time: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    tip.textContent = formatTimestamp(time);
    tip.style.left = `${Math.min(88, Math.max(12, pct))}%`;
    tip.style.opacity = "1";
  };

  const hideTip = () => {
    const tip = tipRef.current;
    if (!tip) return;
    tip.style.opacity = "0";
  };

  const positionFromEvent = (clientX: number) => {
    const bar = barRef.current;
    const el = videoRef.current;
    if (!bar || !el) return null;
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return scrubPositionFromClientX(
      clientX,
      bar.getBoundingClientRect(),
      duration
    );
  };

  const seekToClientX = (clientX: number) => {
    const el = videoRef.current;
    const pos = positionFromEvent(clientX);
    if (!el || !pos) return;
    el.currentTime = pos.time;
    paintPreviewProgress(fillRef.current, knobRef.current, pos.pct / 100);
    reportPreviewTime(videoIdRef.current, startSecRef.current, pos.time);
    showTip(pos.pct, pos.time);
  };

  const finishDrag = (clientX?: number, clientY?: number) => {
    if (!draggingRef.current && !retainedRef.current) return;
    draggingRef.current = false;
    const hit =
      clientX != null && clientY != null
        ? document.elementFromPoint(clientX, clientY)
        : null;
    const overBar = !!hit && !!barRef.current?.contains(hit);
    setEngaged(overBar);
    if (!overBar) hideTip();
    if (retainedRef.current) {
      retainedRef.current = false;
      releaseActiveCardPreview(clientX, clientY);
    }
    if (scrubClearTimer.current != null) {
      window.clearTimeout(scrubClearTimer.current);
    }
    scrubClearTimer.current = window.setTimeout(clearScrubLock, 80);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    stopCardNav(e);
    draggingRef.current = true;
    setEngaged(true);
    const card = cardForSeekBar(e.currentTarget);
    if (card) {
      scrubCardRef.current = card;
      card.setAttribute("data-preview-scrubbing", "");
    }
    if (!retainedRef.current) {
      retainedRef.current = true;
      retainActiveCardPreview();
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    seekToClientX(e.clientX);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) {
      seekToClientX(e.clientX);
      return;
    }
    const pos = positionFromEvent(e.clientX);
    if (!pos) return;
    showTip(pos.pct, pos.time);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    stopCardNav(e);
    finishDrag(e.clientX, e.clientY);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  const onLostCapture = () => {
    if (!draggingRef.current && !retainedRef.current) return;
    finishDrag();
  };

  const onPointerEnter = (e: PointerEvent<HTMLDivElement>) => {
    setEngaged(true);
    const pos = positionFromEvent(e.clientX);
    if (pos) showTip(pos.pct, pos.time);
  };

  const onPointerLeave = () => {
    if (draggingRef.current) return;
    setEngaged(false);
    hideTip();
  };

  return (
    <div
      ref={barRef}
      aria-label="Seek preview"
      data-horde="card-preview-seek"
      onClick={stopCardNav}
      onMouseDown={stopCardNav}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onLostCapture}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="group/seek absolute inset-x-0 bottom-0 z-20 h-4 cursor-pointer touch-none select-none"
    >
      <div
        ref={tipRef}
        className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-gray-100 opacity-0 transition-opacity"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-visible bg-white/20 transition-[height] group-hover/seek:h-1 group-data-[engaged]/seek:h-1">
        <div
          ref={fillRef}
          className="h-full w-full origin-left bg-accent will-change-transform"
          style={{ transform: "scaleX(0)" }}
        />
        <div
          ref={knobRef}
          className="absolute top-1/2 z-[1] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 shadow-sm group-hover/seek:opacity-100 group-data-[engaged]/seek:opacity-100"
          style={{ left: "0%" }}
        />
      </div>
    </div>
  );
}

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
  const [settings, update] = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const wantMutedRef = useRef(settings.previewMuted);
  const prefMutedRef = useRef(settings.previewMuted);
  const [mounted, setMounted] = useState(active);
  const [ready, setReady] = useState(false);
  const [playingMuted, setPlayingMuted] = useState(settings.previewMuted);
  wantMutedRef.current = settings.previewMuted;

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
    if (prefMutedRef.current === settings.previewMuted) return;
    prefMutedRef.current = settings.previewMuted;
    wantMutedRef.current = settings.previewMuted;
    const el = videoRef.current;
    if (!el) {
      setPlayingMuted(settings.previewMuted);
      return;
    }
    el.muted = settings.previewMuted;
    el.defaultMuted = settings.previewMuted;
    setPlayingMuted(settings.previewMuted);
    if (!settings.previewMuted) void el.play().catch(() => undefined);
  }, [settings.previewMuted]);

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
    prefMutedRef.current = next;
    update({ previewMuted: next });
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
        <>
          <PreviewSeekBar
            videoRef={videoRef}
            videoId={videoId}
            startSec={startSec}
          />
          <button
            type="button"
            onClick={toggleMute}
            onPointerDown={(e) => e.stopPropagation()}
            title={playingMuted ? "Unmute preview" : "Mute preview"}
            aria-label={playingMuted ? "Unmute preview" : "Mute preview"}
            className="absolute bottom-4 left-2 z-30 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-gray-100 opacity-80 ring-1 ring-white/15 hover:bg-black/75 hover:opacity-100"
          >
            <MuteGlyph muted={playingMuted} />
          </button>
        </>
      ) : null}
    </>
  );
}
