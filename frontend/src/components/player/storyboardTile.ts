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
