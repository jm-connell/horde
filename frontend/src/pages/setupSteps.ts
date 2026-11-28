export const STEPS = [
  "welcome",
  "downloads",
  "playback",
  "look",
  "ai",
  "youtube",
  "done",
] as const;
export type Step = (typeof STEPS)[number];

/**
 * The wizard's steps for this install. The desktop app plays its videos in
 * its own window, so when that window decodes AV1 the default (AV1 only) is
 * already right and the playback step is left out. Settings → Library still
 * has the choice, for a household that shares Horde with other devices.
 */
export function wizardSteps(
  runtime: "server" | "desktop" | undefined,
  av1Here: boolean
): readonly Step[] {
  return runtime === "desktop" && av1Here
    ? STEPS.filter((s) => s !== "playback")
    : STEPS;
}
