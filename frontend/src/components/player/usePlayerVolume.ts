import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * Volume and mute state mirrored onto the <video>. The stored volume is
 * re-applied to each new source; slider and key changes go through
 * `applyVolume`, which can also persist the level as the preference.
 */
export function usePlayerVolume(
  videoRef: RefObject<HTMLVideoElement | null>,
  src: string,
  initialVolume: number,
  onVolumeChange?: (volume: number) => void
) {
  const [volume, setVolume] = useState(initialVolume);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-apply the stored volume to each new source only; live volume changes are applied by the slider handlers
  }, [src]);

  const applyVolume = useCallback(
    (value: number, persist: boolean) => {
      setVolume(value);
      setMuted(value === 0);
      if (videoRef.current) {
        videoRef.current.volume = value;
        videoRef.current.muted = value === 0;
      }
      if (persist) onVolumeChange?.(value);
    },
    [videoRef, onVolumeChange]
  );

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  return { volume, muted, applyVolume, toggleMute };
}
