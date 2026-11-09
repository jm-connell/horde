import { useCallback, useEffect, useState, type RefObject } from "react";

/** Safari's older API, the one iOS (and a Home Screen app) also has. */
type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
  autoPictureInPicture?: boolean;
};

/** Whether this browser can put `video` in picture in picture. */
export function pipSupported(video: HTMLVideoElement | null): boolean {
  if (typeof document === "undefined") return false;
  if (document.pictureInPictureEnabled) return true;
  const v = video as WebkitVideo | null;
  return !!v?.webkitSupportsPresentationMode?.("picture-in-picture");
}

/**
 * Picture in picture: the toggle behind the PiP buttons (Safari on iPhone
 * through its own API), and leaving the page mid-playback: browsers that can
 * switch to PiP by themselves are asked to (``autopictureinpicture``, the
 * Media Session action), and phones also try when the tab is hidden.
 */
export function usePictureInPicture(
  videoRef: RefObject<HTMLVideoElement | null>,
  isMobile: boolean
) {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(pipSupported(videoRef.current));
  }, [videoRef]);

  const enterPiP = useCallback(async () => {
    const v = videoRef.current as WebkitVideo | null;
    if (!v) return;
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
      await v.requestPictureInPicture();
      return;
    }
    if (v.webkitSupportsPresentationMode?.("picture-in-picture"))
      v.webkitSetPresentationMode?.("picture-in-picture");
  }, [videoRef]);

  const requestPiP = useCallback(async () => {
    const v = videoRef.current as WebkitVideo | null;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.webkitPresentationMode === "picture-in-picture") {
        v.webkitSetPresentationMode?.("inline");
      } else {
        await enterPiP();
      }
    } catch {
      // PiP can be blocked by the browser; ignore.
    }
  }, [videoRef, enterPiP]);

  // On phones, let the browser switch to PiP by itself when the app is left
  // while the video plays (Safari, and Chrome for installed apps and the Media
  // Session action). Unsupported pieces are skipped. Not on a computer: a tab
  // switch there should not pop the video out.
  useEffect(() => {
    const v = videoRef.current as WebkitVideo | null;
    if (!v || !isMobile) return;
    v.autoPictureInPicture = true;
    v.setAttribute("autopictureinpicture", "");
    const session = navigator.mediaSession as
      | (MediaSession & {
          setActionHandler(action: string, handler: (() => void) | null): void;
        })
      | undefined;
    try {
      session?.setActionHandler("enterpictureinpicture", () => {
        enterPiP().catch(() => undefined);
      });
    } catch {
      // This browser does not know the action.
    }
    return () => {
      try {
        session?.setActionHandler("enterpictureinpicture", null);
      } catch {
        // As above.
      }
      v.autoPictureInPicture = false;
      v.removeAttribute("autopictureinpicture");
    };
  }, [videoRef, enterPiP, isMobile]);

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

  return { requestPiP, pipSupported: supported };
}
