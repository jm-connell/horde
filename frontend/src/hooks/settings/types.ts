import type { ViewMode } from "../../components/videoPlayerTypes";
import type { SavedCustomFont, UiFont } from "../../fonts";
import type { HotkeyOverrides } from "../../hotkeys";
import type { LoadingStyle } from "../../loadingStyles";
import type {
  SponsorBlockCategoryMap,
  SponsorBlockSkipMode,
} from "../../sponsorBlock";

export type { LoadingStyle };

export type { SponsorBlockCategoryMap, SponsorBlockSkipMode };

export type { SavedCustomFont, UiFont };

export type SubtitleSize = "small" | "medium" | "large";
export type Theme =
  | "default"
  | "oled"
  | "terminal"
  | "nord"
  | "light"
  | "indigo"
  | "cyber"
  | "sunset"
  | "forest"
  | "slate"
  | "earthy"
  | "frozen"
  | "mocha"
  | "custom";

export interface CustomColors {
  accent: string;
  background: string;
}

export type ChannelSort =
  "recent_download" | "video_count" | "alphabetical" | "subscriber_count";

export type LibrarySort =
  | "added_at"
  | "published_at"
  | "title"
  | "duration"
  | "file_size"
  | "view_count"
  | "random";

export type BackgroundEffect =
  | "none"
  | "custom-image"
  | "rain"
  | "constellation"
  | "perlin-flow"
  | "matrix"
  | "snow"
  | "fireflies"
  | "dust"
  | "bokeh"
  | "warp-grid"
  | "scanlines"
  | "grain"
  | "modern-grid"
  | "flowing-gradient"
  | "lightspeed"
  | "galaxy";

export type FlowingGradientPreset = "theme" | "rgb" | "cool" | "warm" | "mono";

export type HoverMotion = "off" | "subtle" | "lift" | "glow";
export type NavIndicator = "none" | "liquid" | "underline" | "fade";
/** App text size (rem root). Replaces the old multi-step UI scale. */
export type FontSize = "small" | "medium" | "large" | "xl";

export interface CustomThemePreset {
  id: string;
  name: string;
  customColors: CustomColors;
  backgroundEffect: BackgroundEffect;
  backgroundOpacity: number;
  backgroundEffectSpeed: number;
  backgroundEffectSize: number;
  backgroundEffectColorMode: "accent" | "custom";
  backgroundEffectColor: string;
  flowingGradientPreset: FlowingGradientPreset;
  customBackgroundId: string | null;
  customBackgroundMime: string | null;
  customBackgroundBlur: number;
  customBackgroundTint: string;
  customBackgroundTintOpacity: number;
  pauseBackgroundWhileWatching: boolean;
  navIndicator: NavIndicator;
  hoverMotion: HoverMotion;
  translucentPanelStrength: number;
  translucentPanelBlur: number;
  translucentPanelTintEnabled: boolean;
  translucentPanelTint: string;
  translucentPanelTintStrength: number;
  translucentPanelLegibility: boolean;
  loadingStyle: LoadingStyle;
  fontSize: FontSize;
  uiFont: string;
  /** User CSS overlay; empty on older snapshots. */
  customCss: string;
  /** Whether the overlay is injected. Inferred from non-empty CSS on old snapshots. */
  customCssEnabled: boolean;
}

export type StreamQuality = "auto" | "2160" | "1440" | "1080" | "720" | "480";

/**
 * Playback-compatibility mode (persisted as `download_video_codec`):
 * - av1: AV1/VP9 originals only (smallest; newest devices).
 * - h264_native: YouTube's H.264, capped at 1080p, never converted.
 * - h264_convert: H.264 at full resolution; >1080p converted on this server.
 * - sidecar: AV1 original + a ≤1080p H.264 copy beside it.
 */
export type DownloadVideoCodec =
  "av1" | "h264_native" | "h264_convert" | "sidecar";

export type CompatCopyResolution = "1080p" | "source";

export interface Settings {
  theme: Theme;
  customColors: CustomColors;
  customThemes: CustomThemePreset[];
  /** Raw CSS injected after built-in theme styles when `customCssEnabled`. */
  customCss: string;
  /** When false, the CSS editor is hidden and the overlay is not injected. */
  customCssEnabled: boolean;
  backgroundEffect: BackgroundEffect;
  backgroundOpacity: number;
  backgroundEffectSpeed: number;
  backgroundEffectSize: number;
  backgroundEffectColorMode: "accent" | "custom";
  backgroundEffectColor: string;
  flowingGradientPreset: FlowingGradientPreset;
  customBackgroundId: string | null;
  customBackgroundMime: string | null;
  customBackgroundBlur: number;
  customBackgroundTint: string;
  customBackgroundTintOpacity: number;
  pauseBackgroundWhileWatching: boolean;
  navIndicator: NavIndicator;
  hoverMotion: HoverMotion;
  /** 0–1; higher = more see-through. 0 is fully opaque. */
  translucentPanelStrength: number;
  /** 0–1; higher = stronger backdrop blur on translucent panels. */
  translucentPanelBlur: number;
  /** Mix a user-picked color into panel fills. */
  translucentPanelTintEnabled: boolean;
  /** Hex tint mixed into `.ui-panel` / `.ui-card` when enabled. */
  translucentPanelTint: string;
  /** 0–1 mix toward `translucentPanelTint`. */
  translucentPanelTintStrength: number;
  /** Raise opacity on panels marked .ui-panel-legible / .ui-menu. */
  translucentPanelLegibility: boolean;
  loadingStyle: LoadingStyle;
  /** Rem-based text size applied to documentElement font-size. */
  fontSize: FontSize;
  /** App typeface (builtin id, saved custom id, or "custom" while adding). */
  uiFont: UiFont;
  /** Permanently saved custom fonts (URL or uploaded file). */
  customFonts: SavedCustomFont[];
  showDescription: boolean;
  subtitleSize: SubtitleSize;
  /** Horizontal caption position (% from left). Default is left-padded so text reads centered-ish. */
  subtitleLeft: number;
  /** Vertical caption position (% from bottom). */
  subtitleOffset: number;
  defaultPlaybackRate: number;
  /** Temporary rate while holding click on the video. */
  holdPlaybackRate: number;
  volume: number;
  playbackMode: ViewMode;
  lastCustomChannel: string;
  showContinueWatching: boolean;
  /** "For you" also lists followed channels' indexed uploads that are not downloaded. */
  recommendStreams: boolean;
  /** List followed channels that are live in the library sidebar. */
  showLiveStreams: boolean;
  showDownloadNavBadge: boolean;
  normalizeVolumeOnDownload: boolean;
  downloadVideoCodec: DownloadVideoCodec;
  /** Short-side cap for H.264 copies: 1080p (cheap) or source (up to 4K). */
  compatCopyResolution: CompatCopyResolution;
  channelSort: ChannelSort;
  channelOrder: "asc" | "desc";
  defaultLibrarySort: LibrarySort;
  showProgressOnContinueWatching: boolean;
  showProgressOnAllVideos: boolean;
  showCardDates: boolean;
  progressExpiryDays: number;
  sponsorBlockEnabled: boolean;
  sponsorBlockShowNotice: boolean;
  sponsorBlockSkipMode: SponsorBlockSkipMode;
  sponsorBlockCategories: SponsorBlockCategoryMap;
  sidebarCollapsed: boolean;
  chaptersExpanded: boolean;
  descriptionExpanded: boolean;
  /** Watch-page AI panel open/closed (persists across videos and restarts). */
  aiExpanded: boolean;
  /** History page stats band showing its details (charts) or only the tiles. */
  historyStatsExpanded: boolean;
  showRelatedVideos: boolean;
  /**
   * When true, show an up-next countdown after a video ends (the queue still
   * advances immediately): the channel's next upload when it clearly continues
   * the series, even if it is not downloaded, otherwise a related video.
   */
  autoplayRelated: boolean;
  /** Single-character player shortcuts (WCAG 2.1.4: must be switchable off). */
  playerShortcuts: boolean;
  /** Rebound shortcuts; actions not listed keep their default keys. */
  hotkeys: HotkeyOverrides;
  /**
   * Thumbnail previews: on hover with a fine pointer, or when a card is
   * uniquely centered on touch screens.
   */
  previewOnHover: boolean;
  /** Thumbnail preview audio muted. Synced, not shown in Settings. */
  previewMuted: boolean;
  /** On a channel page, include uploads that are not yet in the library. */
  showUndownloadedOnChannel: boolean;
  /** Default quality for adaptive stream playback (Auto = ABR within device cap). */
  defaultStreamQuality: StreamQuality;
}
