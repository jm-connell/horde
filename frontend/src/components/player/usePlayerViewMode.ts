import { useCallback, useRef } from "react";
import type { ViewMode } from "../videoPlayerTypes";

/** Theater and fit-window toggles; fit-window remembers the mode it left. */
export function usePlayerViewMode(
  mode: ViewMode,
  onModeChange: (mode: ViewMode) => void
) {
  const modeBeforeWindowed = useRef<ViewMode>("standard");

  const toggleTheater = useCallback(() => {
    if (mode === "windowed") return;
    onModeChange(mode === "theater" ? "standard" : "theater");
  }, [mode, onModeChange]);

  const toggleWindowed = useCallback(() => {
    if (mode === "windowed") {
      onModeChange(modeBeforeWindowed.current);
    } else {
      modeBeforeWindowed.current = mode;
      onModeChange("windowed");
    }
  }, [mode, onModeChange]);

  const exitWindowed = useCallback(() => {
    onModeChange(modeBeforeWindowed.current);
  }, [onModeChange]);

  return { toggleTheater, toggleWindowed, exitWindowed };
}
