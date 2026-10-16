import type { ReactNode } from "react";
import type { SubtitleSize } from "../hooks/useSettings";
import type { SponsorSegment } from "../hooks/useSponsorBlock";
import type { SponsorBlockSkipMode } from "../sponsorBlock";
import type { Chapter } from "../utils";

export type ViewMode = "standard" | "theater" | "windowed";

export type StreamType = "file" | "dash";

export interface SubtitleSource {
  lang: string;
  src: string;
}

/** The video queued to start when this one ends. */
export interface UpNext {
  title: string;
  channel: string | null;
  poster: string | null;
  seconds: number;
}

export interface VideoPlayerProps {
  src: string;
  /** Progressive local/remote file (default) or adaptive DASH manifest. */
  streamType?: StreamType;
  /**
   * Progressive (<=720p) URL used when DASH is unsupported or fails critically.
   * Typically `/api/preview/stream?url=...`.
   */
  progressiveFallbackSrc?: string;
  videoId?: number;
  mimeType?: string;
  poster?: string | null;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  tracks?: SubtitleSource[];
  onEnded?: () => void;
  variant?: "full" | "mini";
  title?: string;
  onExpand?: () => void;
  onClose?: () => void;
  subtitleSize?: SubtitleSize;
  subtitleLeft?: number;
  subtitleOffset?: number;
  onSubtitlePositionChange?: (left: number, offset: number) => void;
  defaultRate?: number;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  initialPosition?: number;
  onProgress?: (sec: number) => void;
  chapters?: Chapter[];
  sponsorSegments?: SponsorSegment[];
  sponsorShowNotice?: boolean;
  sponsorSkipMode?: SponsorBlockSkipMode;
  subtitlesPending?: boolean;
  onSubtitlesRefresh?: () => void;
  miniWidth?: number | null;
  onMiniResize?: (
    width: number,
    origin: { left: number; top: number; height: number }
  ) => void;
  onMiniMove?: (left: number, top: number) => void;
  onMiniMoveEnd?: () => void;
  upNext?: UpNext | null;
  onCancelUpNext?: () => void;
  onPlayUpNext?: () => void;
  autoplayRelated?: boolean;
  /** Letter/punctuation/Space shortcuts (WCAG 2.1.4); arrows + Escape stay on. */
  singleKeyShortcuts?: boolean;
  onAutoplayRelatedChange?: (enabled: boolean) => void;
  /** Fires when the live DASH track quality changes (YouTube ladder height). */
  onActiveQualityChange?: (quality: number | null) => void;
  /** Fires with the pillarbox inset (px) when the picture doesn't fill its box. */
  onFrameInsetChange?: (inset: number) => void;
  /**
   * Unload live media (abort DASH fetches) while keeping the player shell.
   * Used so a newly clicked preview can load without waiting on the current one.
   */
  mediaSuspended?: boolean;
  /** Covers the video (e.g. "this device can't decode AV1"); src may be "". */
  blockingOverlay?: ReactNode;
  /** Library file failed to decode; return true when the caller recovers. */
  onSourceError?: () => boolean;
}
