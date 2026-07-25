/** Minimal typings for the Shaka DASH build used by VideoPlayer. */
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

  export interface ShakaPlayer {
    attach(element: HTMLMediaElement): Promise<void>;
    load(manifestUri: string): Promise<void>;
    destroy(): Promise<void>;
    configure(config: Record<string, unknown>): void;
    getConfiguration(): Record<string, unknown>;
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    getVariantTracks(): ShakaVariantTrack[];
    selectVariantTrack(track: ShakaVariantTrack, clearBuffer?: boolean): void;
    getStats(): ShakaStats;
    retryStreaming(retryDelay?: number): boolean;
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
