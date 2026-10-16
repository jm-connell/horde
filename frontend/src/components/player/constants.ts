export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
export const CONTROLS_HIDE_DELAY_MS = 2500;
export const HOLD_DELAY_MS = 250;
export const MIN_MINI_WIDTH = 160;
export const MAX_MINI_WIDTH = 960;
/** Mobile fires waiting/stalled during normal play; don't flash the overlay. */
export const BUFFERING_INDICATOR_DELAY_MS = 400;

export function snapRateToStep(r: number): number {
  if (SPEED_STEPS.includes(r)) return r;
  return SPEED_STEPS.reduce((best, s) =>
    Math.abs(s - r) < Math.abs(best - r) ? s : best
  );
}
