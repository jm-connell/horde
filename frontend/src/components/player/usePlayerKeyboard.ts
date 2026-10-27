import { useEffect, type RefObject } from "react";
import {
  isInteractiveControl,
  isTextEntryTarget,
  ownsArrowKeys,
} from "../../utils/keyboardTarget";
import { actionForKey, type HotkeyMap } from "../../hotkeys";
import type { ViewMode } from "../videoPlayerTypes";

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  mode: ViewMode;
  isMini: boolean;
  /** Letter/punctuation/Space shortcuts (WCAG 2.1.4); arrows + Escape stay on. */
  singleKeyShortcuts: boolean;
  /** The user's key for each action. */
  hotkeys: HotkeyMap;
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
 * Window-level player shortcuts (rebindable, see `hotkeys.ts`), plus Escape to
 * leave fit-window mode.
 * Typing in a field and Ctrl/Cmd/Alt chords are left alone, and buttons and
 * sliders keep the keys they already use.
 */
export function usePlayerKeyboard({
  videoRef,
  mode,
  isMini,
  singleKeyShortcuts,
  hotkeys,
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
      if (e.key === "Escape" && mode === "windowed") {
        if (!isMini) revealControls();
        exitWindowed();
        return;
      }
      // WCAG 2.1.4: character-key shortcuts can be switched off in Settings.
      if (e.key.length === 1 && !singleKeyShortcuts) return;
      // Buttons and menu items own Space; sliders and menus own the arrows.
      if (e.key === " " && isInteractiveControl(e.target)) return;
      if (e.key.startsWith("Arrow") && ownsArrowKeys(e.target)) return;
      const action = actionForKey(hotkeys, e.key);
      if (!action || action === "focusSearch") return;
      // A bound key never also does its browser default (Space scrolling).
      e.preventDefault();
      if (!isMini) revealControls();
      const video = videoRef.current;
      switch (action) {
        case "playPause":
          togglePlay();
          break;
        case "captions":
          cycleCaptions();
          break;
        case "theater":
          toggleTheater();
          break;
        case "fitWindow":
          toggleWindowed();
          break;
        case "seekForward":
          if (video) seekTo(video.currentTime + 5);
          break;
        case "seekBack":
          if (video) seekTo(video.currentTime - 5);
          break;
        case "volumeUp":
          applyVolume(
            Math.min(1, Math.round((volume + 0.05) * 100) / 100),
            true
          );
          break;
        case "volumeDown":
          applyVolume(
            Math.max(0, Math.round((volume - 0.05) * 100) / 100),
            true
          );
          break;
        case "speedUp":
          stepRate(1);
          break;
        case "speedDown":
          stepRate(-1);
          break;
        case "nextChapter": {
          if (!hasChapters || !video) break;
          const next = nextChapterStart(video.currentTime);
          if (next != null) seekTo(next);
          break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    hotkeys,
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
