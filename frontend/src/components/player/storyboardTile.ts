import type { CSSProperties } from "react";
import type { Storyboard } from "../../types";

/**
 * The seek-preview tile for `time` from a YouTube storyboard: frames sit
 * `interval_sec` apart, `columns` x `rows` to a sheet, row-major.
 */
export function storyboardTileStyle(
  board: Storyboard,
  time: number
): CSSProperties | null {
  const perSheet = board.columns * board.rows;
  if (perSheet <= 0 || board.interval_sec <= 0 || board.sheets.length === 0) {
    return null;
  }
  const idx = Math.min(
    board.count - 1,
    Math.max(0, Math.floor(time / board.interval_sec))
  );
  const sheet = board.sheets[Math.floor(idx / perSheet)];
  if (!sheet) return null;
  const within = idx % perSheet;
  const col = within % board.columns;
  const row = Math.floor(within / board.columns);
  return {
    width: board.tile_width,
    height: board.tile_height,
    backgroundImage: `url(${JSON.stringify(sheet)})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${board.columns * board.tile_width}px ${board.rows * board.tile_height}px`,
    backgroundPosition: `-${col * board.tile_width}px -${row * board.tile_height}px`,
  };
}

/** Scrub previews are at most this share of the seek bar's width… */
const PREVIEW_MAX_SHARE = 0.4;
/** …but never shrunk below this (px). */
const PREVIEW_MIN_W = 140;

/**
 * How much to shrink a preview tile (drawn at its own size, often 320 px)
 * for a seek bar `barW` px wide: 1 on a desktop player, less on a phone.
 */
export function scrubPreviewScale(tileW: number, barW: number): number {
  if (tileW <= 0 || barW <= 0) return 1;
  const maxW = Math.max(PREVIEW_MIN_W, barW * PREVIEW_MAX_SHARE);
  return Math.min(1, maxW / tileW);
}
