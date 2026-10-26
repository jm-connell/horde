import { useCallback, useEffect, useRef, useState } from "react";
import { CONTROLS_HIDE_DELAY_MS } from "./constants";

interface Options {
  isMini: boolean;
  playing: boolean;
  /** A control-bar popup is open: keep the bar up. */
  menuOpen: boolean;
  revealMiniControls: () => void;
}

/**
 * Auto-hide for the full player's control bar: it fades out a moment after
 * the pointer stops moving while playing, and stays up while paused, while a
 * menu is open, or while a slider is being dragged.
 */
export function useControlsVisibility({
  isMini,
  playing,
  menuOpen,
  revealMiniControls,
}: Options) {
  const hideControlsTimer = useRef<number | null>(null);
  const controlsInteracting = useRef(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const clearHideControlsTimer = useCallback(() => {
    if (hideControlsTimer.current !== null) {
      clearTimeout(hideControlsTimer.current);
      hideControlsTimer.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback(() => {
    clearHideControlsTimer();
    if (!playing || menuOpen || controlsInteracting.current) return;
    hideControlsTimer.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimer.current = null;
    }, CONTROLS_HIDE_DELAY_MS);
  }, [playing, menuOpen, clearHideControlsTimer]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  /** Phones: a tap on the picture hides the controls it revealed. */
  const hideControls = useCallback(() => {
    if (menuOpen || controlsInteracting.current) return;
    clearHideControlsTimer();
    setControlsVisible(false);
  }, [menuOpen, clearHideControlsTimer]);

  const onPlayerMouseMove = useCallback(() => {
    if (isMini) {
      revealMiniControls();
      return;
    }
    revealControls();
  }, [isMini, revealControls, revealMiniControls]);

  const onPlayerMouseLeave = useCallback(() => {
    if (isMini || !playing || menuOpen || controlsInteracting.current) return;
    clearHideControlsTimer();
    setControlsVisible(false);
  }, [isMini, playing, menuOpen, clearHideControlsTimer]);

  const onControlsInteractionStart = useCallback(() => {
    controlsInteracting.current = true;
    clearHideControlsTimer();
    setControlsVisible(true);
  }, [clearHideControlsTimer]);

  const onControlsInteractionEnd = useCallback(() => {
    controlsInteracting.current = false;
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => {
    if (isMini) return;
    if (!playing) {
      clearHideControlsTimer();
      setControlsVisible(true);
    } else {
      scheduleHideControls();
    }
  }, [isMini, playing, clearHideControlsTimer, scheduleHideControls]);

  useEffect(() => {
    if (isMini) return;
    if (menuOpen) {
      clearHideControlsTimer();
      setControlsVisible(true);
    } else if (playing) {
      scheduleHideControls();
    }
  }, [isMini, menuOpen, playing, clearHideControlsTimer, scheduleHideControls]);

  useEffect(() => () => clearHideControlsTimer(), [clearHideControlsTimer]);

  return {
    controlsVisible,
    revealControls,
    hideControls,
    onPlayerMouseMove,
    onPlayerMouseLeave,
    onControlsInteractionStart,
    onControlsInteractionEnd,
  };
}
