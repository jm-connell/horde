import type { ViewMode } from "../videoPlayerTypes";

/** From this window width the player keeps room for a panel beside the picture. */
export const PLAYER_ASIDE_QUERY = "(min-width: 1024px)";

/**
 * Theater and fit window on a wide window: the player offers the page an
 * element beside the picture (the watch page puts the live chat in it).
 * The player and the page both ask this, so they never disagree.
 */
export function besidePictureOnDesktop(mode: ViewMode, wide: boolean): boolean {
  return wide && mode !== "standard";
}

/** What opens the panel beside the picture while it is closed. */
export interface AsideOpener {
  label: string;
  open: () => void;
}
