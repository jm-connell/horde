import { useEffect } from "react";
import type { ViewMode } from "../videoPlayerTypes";

/**
 * Mirrors playback onto <body> for page chrome (background effects): a
 * full-size player is playing, and whether it covers most of the page.
 */
export function usePlayerBodyFlags(
  playing: boolean,
  isMini: boolean,
  mode: ViewMode
) {
  useEffect(() => {
    const body = document.body;
    if (playing && !isMini) body.dataset.playerPlaying = "true";
    else delete body.dataset.playerPlaying;
    // Fit-window playback covers the page; theater leaves the background visible.
    if (playing && !isMini && mode === "windowed") {
      body.dataset.playerCovering = "true";
    } else delete body.dataset.playerCovering;
    return () => {
      delete body.dataset.playerPlaying;
      delete body.dataset.playerCovering;
    };
  }, [playing, isMini, mode]);
}
