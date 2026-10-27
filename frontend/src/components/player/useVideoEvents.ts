import type { MutableRefObject, SyntheticEvent } from "react";
import type { StreamType } from "../videoPlayerTypes";

interface Options {
  prevTimeRef: MutableRefObject<number>;
  isSeekingRef: MutableRefObject<boolean>;
  pendingSeekRef: MutableRefObject<number>;
  /** SponsorBlock check run on every timeupdate. */
  handleSkipTimeUpdate: (
    video: HTMLVideoElement,
    time: number,
    prevTime: number
  ) => void;
  streamType: StreamType;
  compatMode: boolean;
  effectiveSrc: string;
  mediaSuspended: boolean;
  chromecastCasting: boolean;
  setPlaying: (playing: boolean) => void;
  setCurrent: (sec: number) => void;
  setDuration: (sec: number) => void;
  setVideoAspect: (aspect: number) => void;
  setMediaError: (message: string | null) => void;
  setCaptionMode: () => void;
  hideBuffering: () => void;
  scheduleBuffering: () => void;
  enterCompatMode: () => boolean;
  onProgress?: (sec: number) => void;
  onEnded?: () => void;
  /** Library file failed to play; resolves true when the caller recovers. */
  onSourceError?: (error: MediaError | null) => Promise<boolean>;
}

type VideoEvent = SyntheticEvent<HTMLVideoElement>;

/**
 * The <video> element's media event handlers: play state, the clock and
 * SponsorBlock skipping, buffering, metadata (duration, aspect, resume
 * position) and error recovery. Spread the result onto the element.
 */
export function useVideoEvents({
  prevTimeRef,
  isSeekingRef,
  pendingSeekRef,
  handleSkipTimeUpdate,
  streamType: effectiveStreamType,
  compatMode,
  effectiveSrc,
  mediaSuspended,
  chromecastCasting,
  setPlaying,
  setCurrent,
  setDuration,
  setVideoAspect,
  setMediaError,
  setCaptionMode,
  hideBuffering,
  scheduleBuffering,
  enterCompatMode,
  onProgress,
  onEnded,
  onSourceError,
}: Options) {
  return {
    onPlay: () => {
      setPlaying(true);
      setCaptionMode();
    },
    onPause: () => setPlaying(false),
    onTimeUpdate: (e: VideoEvent) => {
      const t = e.currentTarget.currentTime;
      const prev = prevTimeRef.current;
      prevTimeRef.current = t;
      setCurrent(t);
      onProgress?.(t);
      if (t > prev + 0.02 && !e.currentTarget.paused) {
        hideBuffering();
      }
      handleSkipTimeUpdate(e.currentTarget, t, prev);
    },
    onSeeked: () => {
      isSeekingRef.current = false;
      hideBuffering();
    },
    onSeeking: () => {
      isSeekingRef.current = true;
    },
    onWaiting: scheduleBuffering,
    onPlaying: hideBuffering,
    onCanPlay: hideBuffering,
    onLoadedMetadata: (e: VideoEvent) => {
      const el = e.currentTarget;
      setDuration(el.duration);
      if (el.videoWidth > 0 && el.videoHeight > 0) {
        setVideoAspect(el.videoWidth / el.videoHeight);
      }
      const seekTarget = pendingSeekRef.current;
      if (seekTarget > 1 && seekTarget < el.duration) {
        el.currentTime = seekTarget;
      }
      pendingSeekRef.current = 0;
      if (!chromecastCasting && !mediaSuspended) {
        el.play().catch(() => undefined);
      }
    },
    onEnded,
    onError: (e: VideoEvent) => {
      hideBuffering();
      if (effectiveStreamType === "dash") {
        if (enterCompatMode()) return;
        setMediaError(
          "The preview stream failed. Check your connection and try again."
        );
        return;
      }
      if (compatMode) {
        setMediaError(
          "Compatibility-mode preview failed. Try again or download the video."
        );
        return;
      }
      if (!effectiveSrc) return;
      const el = e.currentTarget;
      const failedSrc = el.currentSrc;
      const fail = () =>
        setMediaError(
          "This video could not be played. Check your connection and try again."
        );
      if (!onSourceError) {
        fail();
        return;
      }
      void onSourceError(el.error).then((handled) => {
        // Ignore the answer if the player moved on to another file meanwhile.
        if (!handled && el.currentSrc === failedSrc) fail();
      });
    },
  };
}
