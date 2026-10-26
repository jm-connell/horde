/**
 * Type-only guard for the hand-written typings in shaka-player.d.ts: `tsc`
 * fails here when they declare a Player method the installed Shaka build no
 * longer has (as Shaka 5 did with `setTextTrackVisibility`). Never imported
 * at runtime.
 */
import type realShaka from "../node_modules/shaka-player/dist/shaka-player.dash";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";

type MissingFromShaka = Exclude<
  keyof ShakaPlayer,
  keyof InstanceType<typeof realShaka.Player>
>;

export const shakaTypingsMatch: [MissingFromShaka] extends [never]
  ? true
  : MissingFromShaka = true;
