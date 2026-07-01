/* Minimal Google Cast Web Sender types for Horde casting. */

interface Window {
  __onGCastApiAvailable?: (isAvailable: boolean) => void;
  cast: typeof cast;
  chrome: typeof chrome;
}

declare namespace cast {
  namespace framework {
    enum CastState {
      NO_DEVICES_AVAILABLE = "no_devices_available",
      NOT_CONNECTED = "not_connected",
      CONNECTING = "connecting",
      CONNECTED = "connected",
    }

    enum SessionState {
      NO_SESSION = "no_session",
      SESSION_STARTING = "session_starting",
      SESSION_STARTED = "session_started",
      SESSION_START_FAILED = "session_start_failed",
      SESSION_ENDING = "session_ending",
      SESSION_ENDED = "session_ended",
      SESSION_RESUMED = "session_resumed",
    }

    enum CastContextEventType {
      CAST_STATE_CHANGED = "caststatechanged",
      SESSION_STATE_CHANGED = "sessionstatechanged",
    }

    enum RemotePlayerEventType {
      ANY_CHANGE = "anyChanged",
      IS_CONNECTED_CHANGED = "isConnectedChanged",
      IS_MEDIA_LOADED_CHANGED = "isMediaLoadedChanged",
      DURATION_CHANGED = "durationChanged",
      CURRENT_TIME_CHANGED = "currentTimeChanged",
      IS_PAUSED_CHANGED = "isPausedChanged",
      PLAYER_STATE_CHANGED = "playerStateChanged",
    }

    interface CastOptions {
      receiverApplicationId: string;
      autoJoinPolicy: chrome.cast.AutoJoinPolicy;
    }

    interface CastSession {
      getCastDevice(): { friendlyName: string };
      loadMedia(request: chrome.cast.media.LoadRequest): Promise<void>;
    }

    interface CastStateEventData {
      castState: CastState;
    }

    interface SessionStateEventData {
      sessionState: SessionState;
    }

    class CastContext {
      static getInstance(): CastContext;
      setOptions(options: CastOptions): void;
      getCurrentSession(): CastSession | null;
      requestSession(): Promise<CastSession>;
      getCastState(): CastState;
      endCurrentSession(stopCasting: boolean): void;
      addEventListener(
        type: CastContextEventType,
        handler: (event: CastStateEventData | SessionStateEventData) => void
      ): void;
      removeEventListener(
        type: CastContextEventType,
        handler: (event: CastStateEventData | SessionStateEventData) => void
      ): void;
    }

    class RemotePlayer {
      currentTime: number;
      duration: number;
      isPaused: boolean;
      isMediaLoaded: boolean;
    }

    class RemotePlayerController {
      constructor(player: RemotePlayer);
      playOrPause(): void;
      seek(): void;
      addEventListener(
        type: RemotePlayerEventType,
        handler: () => void
      ): void;
      removeEventListener(
        type: RemotePlayerEventType,
        handler: () => void
      ): void;
    }
  }
}

declare namespace chrome {
  namespace cast {
    enum AutoJoinPolicy {
      TAB_AND_ORIGIN_SCOPED = "tab_and_origin_scoped",
      ORIGIN_SCOPED = "origin_scoped",
      PAGE_SCOPED = "page_scoped",
    }

    namespace media {
      const DEFAULT_MEDIA_RECEIVER_APP_ID: string;

      enum StreamType {
        BUFFERED = "BUFFERED",
        LIVE = "LIVE",
        OTHER = "OTHER",
      }

      enum TrackType {
        TEXT = "TEXT",
        AUDIO = "AUDIO",
        VIDEO = "VIDEO",
      }

      enum TextTrackType {
        SUBTITLES = "SUBTITLES",
        CAPTIONS = "CAPTIONS",
        DESCRIPTIONS = "DESCRIPTIONS",
        CHAPTERS = "CHAPTERS",
        METADATA = "METADATA",
      }

      class GenericMediaMetadata {
        title?: string;
        images?: { url: string }[];
      }

      class Track {
        constructor(trackId: number, trackType: TrackType);
        trackContentId: string;
        trackContentType: string;
        subtype: TextTrackType;
        name: string;
        language: string;
      }

      class MediaInfo {
        constructor(contentId: string, contentType: string);
        streamType: StreamType;
        metadata: GenericMediaMetadata;
        tracks: Track[];
        activeTrackIds: number[];
      }

      class LoadRequest {
        constructor(media: MediaInfo);
        currentTime: number;
        autoplay: boolean;
      }
    }
  }
}
