/**
 * Minimal typings for the Shaka 5 DASH and HLS builds used by VideoPlayer.
 * Keep in step with `node_modules/shaka-player/dist/shaka-player.dash.d.ts`:
 * nothing checks these against the real API.
 */
declare module "shaka-player/dist/shaka-player.dash.js" {
  export interface ShakaVariantTrack {
    id: number;
    active: boolean;
    height: number | null;
    width: number | null;
    bandwidth: number;
    videoCodec?: string | null;
    audioCodec?: string | null;
    frameRate?: number | null;
  }

  export interface ShakaStats {
    width?: number;
    height?: number;
    streamBandwidth?: number;
    decodedFrames?: number;
    droppedFrames?: number;
    corruptedFrames?: number;
    stallsDetected?: number;
    gapsJumped?: number;
    estimatedBandwidth?: number;
    loadLatency?: number;
    playTime?: number;
    pauseTime?: number;
    bufferingTime?: number;
  }

  export const enum ShakaErrorSeverity {
    RECOVERABLE = 1,
    CRITICAL = 2,
  }

  export interface ShakaError {
    severity?: number;
    category?: number;
    code?: number;
    message?: string;
    data?: unknown[];
  }

  export interface ShakaTextTrack {
    id: number;
    active: boolean;
    language: string;
    label: string | null;
    kind: string;
    mimeType?: string | null;
  }

  export interface ShakaPlayer {
    attach(element: HTMLMediaElement): Promise<void>;
    load(manifestUri: string): Promise<void>;
    destroy(): Promise<void>;
    unload?(initializeMediaSource?: boolean): Promise<void>;
    configure(config: Record<string, unknown>): void;
    getConfiguration(): Record<string, unknown>;
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    getVariantTracks(): ShakaVariantTrack[];
    selectVariantTrack(track: ShakaVariantTrack, clearBuffer?: boolean): void;
    getStats(): ShakaStats;
    retryStreaming(retryDelay?: number): boolean;
    isLive(): boolean;
    /** Seekable window in media time (a live stream's DVR window). */
    seekRange(): { start: number; end: number };
    goToLive(): void;
    addTextTrackAsync(
      uri: string,
      language: string,
      kind: string,
      mimeType?: string,
      codec?: string,
      label?: string,
      forced?: boolean
    ): Promise<ShakaTextTrack>;
    getTextTracks(): ShakaTextTrack[];
    /** Selecting a track shows it; `null` hides (unloads) text. */
    selectTextTrack(track: ShakaTextTrack | null): void;
  }

  export interface ShakaNamespace {
    Player: {
      new (): ShakaPlayer;
      isBrowserSupported(): boolean;
    };
    polyfill: {
      installAll(): void;
    };
    util?: {
      Error?: {
        Severity: {
          RECOVERABLE: number;
          CRITICAL: number;
        };
      };
    };
  }

  export const Player: ShakaNamespace["Player"];
  export const polyfill: ShakaNamespace["polyfill"];
}

/** The HLS build (live streams) exposes the same API. */
declare module "shaka-player/dist/shaka-player.hls.js" {
  export * from "shaka-player/dist/shaka-player.dash.js";
}
