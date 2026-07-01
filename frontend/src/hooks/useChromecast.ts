import { useCallback, useEffect, useRef, useState } from "react";

const CAST_SENDER_URL =
  "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

export interface CastMediaInfo {
  contentUrl: string;
  mimeType: string;
  title: string;
  posterUrl?: string | null;
  currentTime: number;
  subtitles: { lang: string; src: string }[];
  activeSubtitleLang?: string | null;
}

let scriptPromise: Promise<void> | null = null;

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function loadCastScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.cast?.framework) {
      resolve();
      return;
    }
    window.__onGCastApiAvailable = (isAvailable: boolean) => {
      if (isAvailable) resolve();
      else reject(new Error("Cast API unavailable"));
    };
    const existing = document.querySelector(
      `script[src="${CAST_SENDER_URL}"]`
    );
    if (existing) {
      const waitForCast = () => {
        if (window.cast?.framework) resolve();
        else window.setTimeout(waitForCast, 50);
      };
      waitForCast();
      return;
    }
    const script = document.createElement("script");
    script.src = CAST_SENDER_URL;
    script.async = true;
    script.onerror = () => reject(new Error("Failed to load Cast SDK"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function useChromecast() {
  const [available, setAvailable] = useState(false);
  const [casting, setCasting] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [remoteCurrentTime, setRemoteCurrentTime] = useState(0);
  const [remoteDuration, setRemoteDuration] = useState(0);
  const [remoteIsPaused, setRemoteIsPaused] = useState(true);

  const remotePlayerRef = useRef<cast.framework.RemotePlayer | null>(null);
  const remoteControllerRef =
    useRef<cast.framework.RemotePlayerController | null>(null);
  const sessionEndPositionRef = useRef(0);
  const onSessionEndRef = useRef<((position: number) => void) | null>(null);

  const syncRemoteState = useCallback(() => {
    const player = remotePlayerRef.current;
    if (!player) return;
    sessionEndPositionRef.current = player.currentTime;
    setRemoteCurrentTime(player.currentTime);
    setRemoteDuration(player.duration);
    setRemoteIsPaused(player.isPaused);
  }, []);

  const attachRemoteListeners = useCallback(() => {
    const controller = remoteControllerRef.current;
    if (!controller) return;
    const handler = () => syncRemoteState();
    const events = [
      cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
      cast.framework.RemotePlayerEventType.DURATION_CHANGED,
      cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
      cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
      cast.framework.RemotePlayerEventType.ANY_CHANGE,
    ];
    for (const type of events) {
      controller.addEventListener(type, handler);
    }
    syncRemoteState();
    return () => {
      for (const type of events) {
        controller.removeEventListener(type, handler);
      }
    };
  }, [syncRemoteState]);

  useEffect(() => {
    if (isIOS()) return;

    let cancelled = false;
    let cleanupRemote: (() => void) | undefined;
    let onCastStateChanged: (() => void) | undefined;
    let onSessionStateChanged:
      | ((event: cast.framework.SessionStateEventData) => void)
      | undefined;

    loadCastScript()
      .then(() => {
        if (cancelled) return;

        const castFramework = window.cast.framework;
        const ctx = castFramework.CastContext.getInstance();
        ctx.setOptions({
          receiverApplicationId:
            chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        });

        onCastStateChanged = () => {
          const state = ctx.getCastState();
          setAvailable(
            state !== castFramework.CastState.NO_DEVICES_AVAILABLE
          );
        };

        onSessionStateChanged = (
          event: cast.framework.SessionStateEventData
        ) => {
          const session = ctx.getCurrentSession();
          if (
            event.sessionState ===
              castFramework.SessionState.SESSION_STARTED ||
            event.sessionState === castFramework.SessionState.SESSION_RESUMED
          ) {
            const player = new castFramework.RemotePlayer();
            const controller = new castFramework.RemotePlayerController(
              player
            );
            remotePlayerRef.current = player;
            remoteControllerRef.current = controller;
            cleanupRemote?.();
            cleanupRemote = attachRemoteListeners();
            setCasting(true);
            setDeviceName(session?.getCastDevice()?.friendlyName ?? null);
          } else if (
            event.sessionState === castFramework.SessionState.SESSION_ENDED
          ) {
            const pos =
              remotePlayerRef.current?.currentTime ??
              sessionEndPositionRef.current;
            cleanupRemote?.();
            cleanupRemote = undefined;
            remotePlayerRef.current = null;
            remoteControllerRef.current = null;
            setCasting(false);
            setDeviceName(null);
            onSessionEndRef.current?.(pos);
          }
        };

        const onSessionStateChangedWrapper = (
          event:
            | cast.framework.SessionStateEventData
            | cast.framework.CastStateEventData
        ) => {
          if ("sessionState" in event) {
            onSessionStateChanged?.(event);
          }
        };

        ctx.addEventListener(
          castFramework.CastContextEventType.CAST_STATE_CHANGED,
          onCastStateChanged
        );
        ctx.addEventListener(
          castFramework.CastContextEventType.SESSION_STATE_CHANGED,
          onSessionStateChangedWrapper
        );
        onCastStateChanged();

        return () => {
          if (onCastStateChanged) {
            ctx.removeEventListener(
              castFramework.CastContextEventType.CAST_STATE_CHANGED,
              onCastStateChanged
            );
          }
          ctx.removeEventListener(
            castFramework.CastContextEventType.SESSION_STATE_CHANGED,
            onSessionStateChangedWrapper
          );
        };
      })
      .catch(() => {
        // Cast SDK unavailable in this browser.
      });

    return () => {
      cancelled = true;
      cleanupRemote?.();
    };
  }, [attachRemoteListeners]);

  const castMedia = useCallback(async (info: CastMediaInfo) => {
    const ctx = window.cast?.framework?.CastContext?.getInstance();
    if (!ctx) return;

    let session = ctx.getCurrentSession();
    if (!session) {
      session = await ctx.requestSession();
    }

    const mediaInfo = new chrome.cast.media.MediaInfo(
      info.contentUrl,
      info.mimeType
    );
    mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;

    const metadata = new chrome.cast.media.GenericMediaMetadata();
    metadata.title = info.title;
    if (info.posterUrl) {
      metadata.images = [{ url: info.posterUrl }];
    }
    mediaInfo.metadata = metadata;

    if (info.subtitles.length > 0) {
      mediaInfo.tracks = info.subtitles.map((sub, i) => {
        const track = new chrome.cast.media.Track(
          i + 1,
          chrome.cast.media.TrackType.TEXT
        );
        track.trackContentId = sub.src;
        track.trackContentType = "text/vtt";
        track.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
        track.name = sub.lang;
        track.language = sub.lang;
        return track;
      });

      if (info.activeSubtitleLang) {
        const idx = info.subtitles.findIndex(
          (s) => s.lang === info.activeSubtitleLang
        );
        if (idx >= 0) {
          mediaInfo.activeTrackIds = [idx + 1];
        }
      }
    }

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = info.currentTime;
    request.autoplay = true;

    await session.loadMedia(request);
    setCasting(true);
    setDeviceName(session.getCastDevice()?.friendlyName ?? null);

    if (!remotePlayerRef.current) {
      const player = new cast.framework.RemotePlayer();
      const controller = new cast.framework.RemotePlayerController(player);
      remotePlayerRef.current = player;
      remoteControllerRef.current = controller;
      attachRemoteListeners();
    }
    syncRemoteState();
  }, [attachRemoteListeners, syncRemoteState]);

  const stop = useCallback(() => {
    const ctx = window.cast?.framework?.CastContext?.getInstance();
    ctx?.endCurrentSession(true);
  }, []);

  const remotePlay = useCallback(() => {
    remoteControllerRef.current?.playOrPause();
    window.setTimeout(syncRemoteState, 100);
  }, [syncRemoteState]);

  const remoteSeek = useCallback(
    (time: number) => {
      const player = remotePlayerRef.current;
      const controller = remoteControllerRef.current;
      if (!player || !controller) return;
      player.currentTime = time;
      controller.seek();
      syncRemoteState();
    },
    [syncRemoteState]
  );

  const setOnSessionEnd = useCallback((fn: (position: number) => void) => {
    onSessionEndRef.current = fn;
  }, []);

  return {
    available,
    casting,
    deviceName,
    remoteCurrentTime,
    remoteDuration,
    remoteIsPaused,
    castMedia,
    stop,
    remotePlay,
    remoteSeek,
    setOnSessionEnd,
  };
}
