import { useCallback, useEffect, useState, type RefObject } from "react";

type WebKitVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

export function useAirPlay(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string
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

  const showPicker = useCallback(() => {
    const video = videoRef.current as WebKitVideo | null;
    video?.webkitShowPlaybackTargetPicker?.();
  }, [videoRef]);

  return { available, casting, showPicker };
}
