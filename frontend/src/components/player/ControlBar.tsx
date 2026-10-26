import type { RefObject } from "react";
import { formatDuration, formatTimestamp, type Chapter } from "../../utils";
import type { QualityChoice } from "../videoPlayerQuality";
import type { StreamType, ViewMode } from "../videoPlayerTypes";
import FullscreenButton from "./FullscreenButton";
import QualityMenu from "./QualityMenu";
import ScrubBar from "./ScrubBar";
import SpeedMenu from "./SpeedMenu";
import VolumeControl from "./VolumeControl";
import { playerChromeBtn } from "./playerChrome";
import { activeChapterAt } from "./useChapters";
import { LIVE_EDGE_TOLERANCE_SEC } from "./useLiveWindow";
import type { PlayerMenu } from "./usePlayerMenu";
import { PauseIcon, PlayIcon } from "../icons";

interface Props {
  visible: boolean;
  isMobile: boolean;
  mode: ViewMode;
  playing: boolean;
  togglePlay: () => void;
  current: number;
  duration: number;
  seekTo: (sec: number) => void;
  /** Keep the bar up while the pointer is on a slider. */
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
  // Seek bar
  scrubberRef: RefObject<HTMLDivElement | null>;
  videoId?: number;
  chapters: Chapter[];
  hoveredChapter: Chapter | null;
  onHoverChapter: (startSec: number | null) => void;
  // Volume
  volume: number;
  muted: boolean;
  applyVolume: (value: number, persist: boolean) => void;
  onVolumeChange?: (volume: number) => void;
  toggleMute: () => void;
  // Popup menus (speed, quality)
  openMenu: PlayerMenu | null;
  onToggleMenu: (menu: PlayerMenu) => void;
  onCloseMenu: (menu: PlayerMenu) => void;
  rate: number;
  onRateChange: (rate: number) => void;
  streamType: StreamType;
  qualityChoice: QualityChoice;
  activeQuality: number | null;
  availableHeights: number[];
  onPickQuality: (choice: QualityChoice) => void;
  // Captions
  ccNotice: string | null;
  showCaptionsButton: boolean;
  subtitlesPending: boolean;
  hasTracks: boolean;
  captionsOn: boolean;
  onCycleCaptions: () => void;
  // Cast, PiP, view modes
  castAvailable: boolean;
  casting: boolean;
  castDeviceName: string | null;
  onCastClick: () => void;
  onTogglePiP: () => void;
  onToggleTheater: () => void;
  onToggleWindowed: () => void;
  isNativeFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** A live stream: the time readout becomes a LIVE / jump-to-live control. */
  live?: LiveControl | null;
}

export interface LiveControl {
  /** Seconds behind the live edge. */
  behindSec: number;
  /** False once the broadcast ended. */
  isLive: boolean;
  onGoLive: () => void;
}

/** The full-size player's bottom bar: seek bar, transport and option buttons. */
export default function ControlBar({
  visible,
  isMobile,
  mode,
  playing,
  togglePlay,
  current,
  duration,
  seekTo,
  onInteractionStart,
  onInteractionEnd,
  scrubberRef,
  videoId,
  chapters,
  hoveredChapter,
  onHoverChapter,
  volume,
  muted,
  applyVolume,
  onVolumeChange,
  toggleMute,
  openMenu,
  onToggleMenu,
  onCloseMenu,
  rate,
  onRateChange,
  streamType,
  qualityChoice,
  activeQuality,
  availableHeights,
  onPickQuality,
  ccNotice,
  showCaptionsButton,
  subtitlesPending,
  hasTracks,
  captionsOn,
  onCycleCaptions,
  castAvailable,
  casting,
  castDeviceName,
  onCastClick,
  onTogglePiP,
  onToggleTheater,
  onToggleWindowed,
  isNativeFullscreen,
  onToggleFullscreen,
  live = null,
}: Props) {
  const activeChapter =
    chapters.length > 0 ? activeChapterAt(chapters, current) : null;
  return (
    <div
      data-visible={visible}
      className={`player-controlbar absolute inset-x-0 bottom-0 bg-linear-to-t from-black/95 via-black/70 to-transparent px-4 pb-2 pt-10 transition-opacity duration-300 ${
        visible
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0"
      }`}
    >
      <ScrubBar
        scrubberRef={scrubberRef}
        videoId={videoId}
        current={current}
        duration={duration}
        chapters={chapters}
        hoveredChapter={hoveredChapter}
        onHoverChapter={onHoverChapter}
        seekTo={seekTo}
        formatTime={
          live
            ? (sec) => `-${formatTimestamp(Math.max(0, duration - sec))}`
            : undefined
        }
        onInteractionStart={onInteractionStart}
        onInteractionEnd={onInteractionEnd}
      />
      {ccNotice && (
        <div className="absolute left-4 top-4 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-white">
          {ccNotice}
        </div>
      )}
      <div className="mt-2 flex flex-nowrap items-center gap-x-3 text-gray-100 max-sm:gap-x-2">
        <button
          type="button"
          onClick={togglePlay}
          className="ui-player-chrome shrink-0 text-xl leading-none hover:text-accent"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>

        {!isMobile && (
          <VolumeControl
            volume={volume}
            muted={muted}
            applyVolume={applyVolume}
            onVolumeChange={onVolumeChange}
            toggleMute={toggleMute}
            onInteractionStart={onInteractionStart}
            onInteractionEnd={onInteractionEnd}
          />
        )}

        {live ? (
          <LiveReadout live={live} />
        ) : (
          <span className="flex min-w-0 items-center whitespace-nowrap text-xs tabular-nums text-gray-300">
            <span className="shrink-0">
              {formatDuration(current)} / {formatDuration(duration)}
            </span>
            {activeChapter && (
              <span className="ml-2 min-w-0 max-w-[140px] truncate text-gray-400">
                · {activeChapter.title}
              </span>
            )}
          </span>
        )}

        <div className="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap max-sm:gap-1">
          {streamType === "dash" && availableHeights.length > 0 && (
            <QualityMenu
              open={openMenu === "quality"}
              onToggle={() => onToggleMenu("quality")}
              onClose={() => onCloseMenu("quality")}
              choice={qualityChoice}
              activeQuality={activeQuality}
              heights={availableHeights}
              onPick={onPickQuality}
            />
          )}
          <SpeedMenu
            open={openMenu === "speed"}
            onToggle={() => onToggleMenu("speed")}
            onClose={() => onCloseMenu("speed")}
            rate={rate}
            onRateChange={onRateChange}
          />
          {showCaptionsButton && (
            <button
              type="button"
              onClick={onCycleCaptions}
              className={playerChromeBtn(captionsOn)}
              aria-label="CC (subtitles)"
              aria-pressed={captionsOn}
              title={
                subtitlesPending && !hasTracks
                  ? "Subtitles loading"
                  : "Subtitles"
              }
            >
              CC
            </button>
          )}
          {castAvailable && (
            <button
              type="button"
              onClick={onCastClick}
              aria-label={casting ? "Stop casting" : "Cast to TV"}
              className={playerChromeBtn(casting)}
              title={
                casting ? `Casting to ${castDeviceName ?? "TV"}` : "Cast to TV"
              }
            >
              Cast
            </button>
          )}
          {isMobile && (
            <FullscreenButton
              active={isNativeFullscreen}
              onClick={onToggleFullscreen}
            />
          )}
          {!isMobile && (
            <>
              <button
                type="button"
                onClick={onTogglePiP}
                className={playerChromeBtn(false)}
                aria-label="PiP (picture in picture)"
                title="Picture in picture"
              >
                PiP
              </button>
              <button
                type="button"
                onClick={onToggleTheater}
                className={playerChromeBtn(mode === "theater")}
                title="Theater mode (t)"
              >
                Theater
              </button>
              <button
                type="button"
                onClick={onToggleWindowed}
                className={playerChromeBtn(mode === "windowed")}
                aria-label="Fit window"
                aria-pressed={mode === "windowed"}
                title="Fit window (f)"
              >
                Fit
              </button>
              <FullscreenButton
                active={isNativeFullscreen}
                onClick={onToggleFullscreen}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "LIVE" at the edge; behind it, how far, and a click jumps back to live. */
function LiveReadout({ live }: { live: LiveControl }) {
  if (!live.isLive) {
    return <span className="text-xs text-gray-400">Stream ended</span>;
  }
  const atEdge = live.behindSec <= LIVE_EDGE_TOLERANCE_SEC;
  return (
    <button
      type="button"
      onClick={live.onGoLive}
      disabled={atEdge}
      className="ui-player-chrome flex items-center gap-1.5 text-xs tabular-nums text-gray-300 enabled:hover:text-white"
      title={atEdge ? "Watching live" : "Jump to live"}
      aria-label={
        atEdge
          ? "Live"
          : `${formatTimestamp(live.behindSec)} behind live. Jump to live`
      }
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${atEdge ? "bg-red-500" : "bg-gray-500"}`}
      />
      <span className={atEdge ? "text-gray-200" : undefined}>LIVE</span>
      {!atEdge && (
        <span className="text-gray-400">
          -{formatTimestamp(live.behindSec)}
        </span>
      )}
    </button>
  );
}
