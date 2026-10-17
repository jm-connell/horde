import { useCallback, useEffect, useState, type RefObject } from "react";

type WebKitVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

export function useAirPlay(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string,
  /** Same media with a signed token, for the receiver (it sends no cookie). */
  signedSrc?: () => Promise<string | null>
) {
  const [available, setAvailable] = useState(false);
  const [casting, setCasting] = useState(false);

  useEffect(() => {
    const video = videoRef.current as WebKitVideo | null;
    if (!video) return;

    const onAvailability = (e: Event) => {
      const ce = e as Event & { availability?: string };
      setAvailable(ce.availability === "available");
    };

    const onWirelessChanged = () => {
      setCasting(!!video.webkitCurrentPlaybackTargetIsWireless);
    };

    video.addEventListener(
      "webkitplaybacktargetavailabilitychanged",
      onAvailability
    );
    video.addEventListener(
      "webkitcurrentplaybacktargetiswirelesschanged",
      onWirelessChanged
    );

    return () => {
      video.removeEventListener(
        "webkitplaybacktargetavailabilitychanged",
        onAvailability
      );
      video.removeEventListener(
        "webkitcurrentplaybacktargetiswirelesschanged",
        onWirelessChanged
      );
    };
  }, [videoRef, src]);

  const showPicker = useCallback(async () => {
    const video = videoRef.current as WebKitVideo | null;
    if (!video) return;
    // An Apple TV fetches the media URL itself, without our session cookie, so
    // hand it a signed URL. Only done when the user asks for AirPlay; normal
    // playback keeps the cookie-authenticated source.
    if (
      signedSrc &&
      video.currentSrc &&
      !video.currentSrc.startsWith("blob:")
    ) {
      try {
        const url = await signedSrc();
        if (url) {
          const at = video.currentTime;
          const wasPlaying = !video.paused;
          video.src = url;
          video.currentTime = at;
          if (wasPlaying) void video.play().catch(() => undefined);
        }
      } catch {
        // No token (offline, signed out): the picker still opens.
      }
    }
    video.webkitShowPlaybackTargetPicker?.();
  }, [videoRef, signedSrc]);

  return { available, casting, showPicker };
}
