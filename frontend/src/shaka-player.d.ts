/** Minimal typings for the Shaka DASH build used by VideoPlayer. */
declare module "shaka-player/dist/shaka-player.dash.js" {
  export interface ShakaVariantTrack {
    id: number;
    active: boolean;
    height: number | null;
    width: number | null;
    bandwidth: number;
  }

  export interface ShakaPlayer {
    attach(element: HTMLMediaElement): Promise<void>;
    load(manifestUri: string): Promise<void>;
    destroy(): Promise<void>;
    configure(config: Record<string, unknown>): void;
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    getVariantTracks(): ShakaVariantTrack[];
    selectVariantTrack(track: ShakaVariantTrack, clearBuffer?: boolean): void;
  }

  export interface ShakaNamespace {
    Player: {
      new (): ShakaPlayer;
      isBrowserSupported(): boolean;
    };
    polyfill: {
      installAll(): void;
    };
  }

  export const Player: ShakaNamespace["Player"];
  export const polyfill: ShakaNamespace["polyfill"];
}
