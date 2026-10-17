/** Minimal typings for the Shaka DASH and HLS builds used by VideoPlayer. */
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

  export interface ShakaTextDisplayer {
    destroy(): void;
    setTextVisibility(visible: boolean): void;
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
    selectTextTrack(track: ShakaTextTrack | null): void;
    setTextTrackVisibility(visible: boolean): void;
    isTextTrackVisible(): boolean;
  }

  export interface ShakaNamespace {
    Player: {
      new (): ShakaPlayer;
      isBrowserSupported(): boolean;
    };
    polyfill: {
      installAll(): void;
    };
    text?: {
      SimpleTextDisplayer: new (
        video: HTMLMediaElement,
        label?: string
      ) => ShakaTextDisplayer;
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
