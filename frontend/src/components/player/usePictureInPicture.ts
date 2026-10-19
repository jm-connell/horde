import { useCallback, useEffect, type RefObject } from "react";

/**
 * Picture in picture: the toggle behind the PiP buttons, and on phones
 * entering PiP when the tab is hidden mid-playback (leaving it on return).
 */
export function usePictureInPicture(
  videoRef: RefObject<HTMLVideoElement | null>,
  isMobile: boolean
) {
  const enterPiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v?.requestPictureInPicture) return;
    await v.requestPictureInPicture();
  }, [videoRef]);

  const requestPiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await enterPiP();
      }
    } catch {
      // PiP can be blocked by the browser; ignore.
    }
  }, [videoRef, enterPiP]);

  useEffect(() => {
    if (!isMobile) return;
    const onVisibility = () => {
      const v = videoRef.current;
      if (!v) return;
      if (
        document.hidden &&
        !v.paused &&
        document.pictureInPictureEnabled &&
        !document.pictureInPictureElement
      ) {
        enterPiP().catch(() => undefined);
      } else if (!document.hidden && document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [isMobile, enterPiP, videoRef]);

  return { requestPiP };
}
