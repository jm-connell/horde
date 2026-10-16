import { useEffect, type RefObject } from "react";
import {
  isInteractiveControl,
  isTextEntryTarget,
  ownsArrowKeys,
} from "../../utils/keyboardTarget";
import type { ViewMode } from "../videoPlayerTypes";

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  mode: ViewMode;
  isMini: boolean;
  /** Letter/punctuation/Space shortcuts (WCAG 2.1.4); arrows + Escape stay on. */
  singleKeyShortcuts: boolean;
  volume: number;
  hasChapters: boolean;
  togglePlay: () => void;
  toggleTheater: () => void;
  toggleWindowed: () => void;
  /** Escape in fit-window mode: back to the mode before it. */
  exitWindowed: () => void;
  cycleCaptions: () => void;
  seekTo: (sec: number) => void;
  /** Start of the chapter after `time`, if there is one. */
  nextChapterStart: (time: number) => number | null;
  /** Set the volume and persist it. */
  applyVolume: (value: number, persist: boolean) => void;
  stepRate: (dir: 1 | -1) => void;
  revealControls: () => void;
}

/**
 * Window-level player shortcuts: Space/k, c, t, f, Escape, arrows, < >, n.
 * Typing in a field and Ctrl/Cmd/Alt chords are left alone, and buttons and
 * sliders keep the keys they already use.
 */
export function usePlayerKeyboard({
  videoRef,
  mode,
  isMini,
  singleKeyShortcuts,
  volume,
  hasChapters,
  togglePlay,
  toggleTheater,
  toggleWindowed,
  exitWindowed,
  cycleCaptions,
  seekTo,
  nextChapterStart,
  applyVolume,
  stepRate,
  revealControls,
}: Options) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Never hijack browser/OS shortcuts or typing.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntryTarget(e.target)) return;
      // WCAG 2.1.4: character-key shortcuts can be switched off in Settings.
      if (e.key.length === 1 && !singleKeyShortcuts) return;
      // Buttons and menu items own Space; sliders and menus own the arrows.
      if (e.key === " " && isInteractiveControl(e.target)) return;
      if (e.key.startsWith("Arrow") && ownsArrowKeys(e.target)) return;
      const isPlayerKey =
        e.key === " " ||
        e.key === "k" ||
        e.key === "c" ||
        e.key === "C" ||
        e.key === "t" ||
        e.key === "f" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === ">" ||
        e.key === "." ||
        e.key === "<" ||
        e.key === "," ||
        e.key === "n" ||
        (e.key === "Escape" && mode === "windowed");
      if (isPlayerKey && !isMini) revealControls();
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        cycleCaptions();
      } else if (e.key === "t") {
        toggleTheater();
      } else if (e.key === "f") {
        toggleWindowed();
      } else if (e.key === "Escape" && mode === "windowed") {
        exitWindowed();
      } else if (e.key === "ArrowRight" && videoRef.current) {
        seekTo(videoRef.current.currentTime + 5);
      } else if (e.key === "ArrowLeft" && videoRef.current) {
        seekTo(videoRef.current.currentTime - 5);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        applyVolume(Math.min(1, Math.round((volume + 0.05) * 100) / 100), true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        applyVolume(Math.max(0, Math.round((volume - 0.05) * 100) / 100), true);
      } else if (e.key === ">" || e.key === ".") {
        stepRate(1);
      } else if (e.key === "<" || e.key === ",") {
        stepRate(-1);
      } else if (e.key === "n" && hasChapters && videoRef.current) {
        e.preventDefault();
        const next = nextChapterStart(videoRef.current.currentTime);
        if (next != null) seekTo(next);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    singleKeyShortcuts,
    togglePlay,
    toggleTheater,
    toggleWindowed,
    exitWindowed,
    mode,
    stepRate,
    isMini,
    revealControls,
    hasChapters,
    nextChapterStart,
    cycleCaptions,
    seekTo,
    volume,
    applyVolume,
    videoRef,
  ]);
}
