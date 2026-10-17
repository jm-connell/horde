import type { SubtitleSize } from "../../hooks/useSettings";
import type { ViewMode } from "../videoPlayerTypes";

interface LayoutInput {
  isMini: boolean;
  isMobile: boolean;
  isNativeFullscreen: boolean;
  mode: ViewMode;
  /** Width / height of the picture once known. */
  videoAspect: number | null;
  /** The host lets the mini player be dragged. */
  canMoveMini: boolean;
  subtitleSize: SubtitleSize;
}

/** Class names and inline style for the player's wrapper, stage and <video>. */
export function playerLayout({
  isMini,
  isMobile,
  isNativeFullscreen,
  mode,
  videoAspect,
  canMoveMini,
  subtitleSize,
}: LayoutInput) {
  const wrapperClass = isMini
    ? `player-mini relative w-full overflow-hidden bg-black leading-none${canMoveMini ? " cursor-grab active:cursor-grabbing" : ""}`
    : isNativeFullscreen
      ? "relative flex h-full w-full items-center justify-center overflow-hidden bg-black leading-none"
      : mode === "windowed"
        ? "relative flex h-full w-full items-center justify-center overflow-hidden bg-black leading-none"
        : "relative w-full overflow-hidden bg-black leading-none";

  const innerClass =
    !isMini && (mode === "windowed" || isNativeFullscreen)
      ? "relative h-full w-full leading-none"
      : "relative w-full leading-none";

  const miniStyle =
    isMini && videoAspect
      ? { aspectRatio: `${videoAspect}` as const }
      : isMini
        ? { aspectRatio: "16 / 9" as const }
        : undefined;

  const videoClass = isMini
    ? "block h-full w-full bg-black object-contain"
    : isNativeFullscreen || mode === "windowed"
      ? "block h-full w-full object-contain"
      : isMobile
        ? "mx-auto block max-h-[70vh] w-full bg-black object-contain"
        : "mx-auto block max-h-[85vh] w-full bg-black object-contain";
  const subtitleClass = `sub-${subtitleSize}`;
  return { wrapperClass, innerClass, miniStyle, videoClass, subtitleClass };
}
