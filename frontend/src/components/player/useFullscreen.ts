import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Native fullscreen for the player root (with the iOS video-element fallback),
 * tracking whether the viewer asked for it so the iOS auto-fullscreen hijack
 * can be told apart.
 */
export function useFullscreen(
  playerRootRef: RefObject<HTMLDivElement>,
  videoRef: RefObject<HTMLVideoElement>
) {
  const userInitiatedFullscreen = useRef(false);
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);

  const exitNativeFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
      screen.orientation?.unlock?.();
    } catch {
      // Browser may reject unlock or exit.
    }
    userInitiatedFullscreen.current = false;
  }, []);

  const enterNativeFullscreen = useCallback(async () => {
    const root = playerRootRef.current;
    const video = videoRef.current;
    if (!root || !video) return;

    userInitiatedFullscreen.current = true;

    const req =
      root.requestFullscreen?.bind(root) ??
      (
        root as HTMLElement & {
          webkitRequestFullscreen?: () => Promise<void>;
        }
      ).webkitRequestFullscreen?.bind(root);
    if (req) {
      try {
        await req();
        try {
          const lock = (
            screen.orientation as ScreenOrientation & {
              lock?: (orientation: string) => Promise<void>;
            }
          ).lock;
          await lock?.("landscape");
        } catch {
          // Orientation lock may be unsupported or denied.
        }
        return;
      } catch {
        userInitiatedFullscreen.current = false;
      }
    }

    const el = video as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    if (el.webkitEnterFullscreen) {
      el.webkitEnterFullscreen();
      return;
    }

    userInitiatedFullscreen.current = false;
  }, [playerRootRef, videoRef]);

  const toggleNativeFullscreen = useCallback(async () => {
    if (document.fullscreenElement || isNativeFullscreen) {
      await exitNativeFullscreen();
    } else {
      await enterNativeFullscreen();
    }
  }, [enterNativeFullscreen, exitNativeFullscreen, isNativeFullscreen]);

  useEffect(() => {
    const onChange = () => {
      const active = !!document.fullscreenElement;
      setIsNativeFullscreen(active);
      document.body.classList.toggle("player-fullscreen", active);
      if (!active) {
        userInitiatedFullscreen.current = false;
        try {
          screen.orientation?.unlock?.();
        } catch {
          // ignore
        }
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.body.classList.remove("player-fullscreen");
    };
  }, []);

  return {
    isNativeFullscreen,
    toggleNativeFullscreen,
    userInitiatedFullscreen,
  };
}
