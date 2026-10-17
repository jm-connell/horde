import { useCallback, useEffect, useRef, type RefObject } from "react";
import { absoluteUrl, api, streamUrl, withMediaToken } from "../../api";
import { useAirPlay } from "../../hooks/useAirPlay";
import { useChromecast } from "../../hooks/useChromecast";
import type { SubtitleSource } from "../videoPlayerTypes";

interface Options {
  videoRef: RefObject<HTMLVideoElement>;
  videoId?: number;
  src: string;
  mimeType: string;
  title?: string;
  poster: string | null;
  tracks: SubtitleSource[];
  captionLang: string | null;
  onProgress?: (sec: number) => void;
  setCurrent: (sec: number) => void;
  setDuration: (sec: number) => void;
  setPlaying: (playing: boolean) => void;
}

/**
 * Chromecast and AirPlay: availability, the Cast button action, and keeping
 * the player's clock and play state in step with a Chromecast receiver.
 */
export function useCasting({
  videoRef,
  videoId,
  src,
  mimeType,
  title,
  poster,
  tracks,
  captionLang,
  onProgress,
  setCurrent,
  setDuration,
  setPlaying,
}: Options) {
  const chromecast = useChromecast();
  const signedAirPlaySrc = useCallback(async () => {
    if (videoId == null) return null;
    const { token } = await api.getMediaToken(videoId);
    return withMediaToken(src, token);
  }, [videoId, src]);
  const airplay = useAirPlay(videoRef, src, signedAirPlaySrc);
  // Destructured so hook dependency arrays list the stable callbacks rather
  // than the whole (per-render) hook result objects.
  const {
    castMedia: castChromecastMedia,
    stop: stopChromecast,
    remotePlay: toggleChromecastPlay,
    remoteSeek: seekChromecast,
    setOnSessionEnd: setChromecastOnSessionEnd,
  } = chromecast;
  const { showPicker: showAirPlayPicker } = airplay;

  const available = chromecast.available || airplay.available;
  const casting = chromecast.casting || airplay.casting;
  const deviceName = chromecast.casting
    ? chromecast.deviceName
    : airplay.casting
      ? "AirPlay"
      : null;

  useEffect(() => {
    setChromecastOnSessionEnd((position) => {
      const v = videoRef.current;
      if (!v) return;
      if (position > 0) {
        v.currentTime = position;
        setCurrent(position);
        onProgress?.(position);
      }
      v.play().catch(() => undefined);
    });
  }, [setChromecastOnSessionEnd, onProgress, videoRef, setCurrent]);

  // The <video> is paused while the receiver plays, so it reports no
  // progress: report the receiver's, so the account's other devices (and this
  // one after the cast) resume from where the TV got to.
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  useEffect(() => {
    if (!chromecast.casting || chromecast.remoteCurrentTime <= 0) return;
    onProgressRef.current?.(chromecast.remoteCurrentTime);
  }, [chromecast.casting, chromecast.remoteCurrentTime]);

  useEffect(() => {
    if (!chromecast.casting) return;
    setCurrent(chromecast.remoteCurrentTime);
    setDuration(chromecast.remoteDuration);
    setPlaying(!chromecast.remoteIsPaused);
  }, [
    chromecast.casting,
    chromecast.remoteCurrentTime,
    chromecast.remoteDuration,
    chromecast.remoteIsPaused,
    setCurrent,
    setDuration,
    setPlaying,
  ]);

  const startChromecast = useCallback(async () => {
    const v = videoRef.current;
    if (!v || videoId == null) return;
    v.pause();
    try {
      // The receiver fetches these itself and sends no cookie: sign them.
      const { token } = await api.getMediaToken(videoId);
      const signed = (path: string) => absoluteUrl(withMediaToken(path, token));
      await castChromecastMedia({
        contentUrl: signed(streamUrl(videoId)),
        mimeType,
        title: title ?? "Video",
        posterUrl: poster ? signed(poster) : null,
        currentTime: v.currentTime,
        subtitles: tracks.map((t) => ({
          lang: t.lang,
          src: signed(t.src),
        })),
        activeSubtitleLang: captionLang,
      });
    } catch {
      // User cancelled device picker or load failed.
    }
  }, [
    videoRef,
    videoId,
    mimeType,
    title,
    poster,
    tracks,
    captionLang,
    castChromecastMedia,
  ]);

  const onCastClick = useCallback(() => {
    if (chromecast.casting) {
      stopChromecast();
      return;
    }
    if (chromecast.available) {
      void startChromecast();
      return;
    }
    if (airplay.available) {
      showAirPlayPicker();
    }
  }, [
    chromecast.casting,
    chromecast.available,
    stopChromecast,
    startChromecast,
    airplay.available,
    showAirPlayPicker,
  ]);

  return {
    /** Chromecast or AirPlay can be started. */
    available,
    /** Chromecast or AirPlay is playing. */
    casting,
    /** Only Chromecast takes over transport and seeking from the <video>. */
    chromecastCasting: chromecast.casting,
    deviceName,
    onCastClick,
    toggleChromecastPlay,
    seekChromecast,
  };
}
