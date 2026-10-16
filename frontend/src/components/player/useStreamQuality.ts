import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ShakaPlayer } from "shaka-player/dist/shaka-player.dash.js";
import { usePlaybackHealth } from "../../hooks/usePlaybackHealth";
import { useApplyShakaQuality } from "../../hooks/useShakaDash";
import type { StreamQuality } from "../../hooks/useSettings";
import { clearDowngrade, trackQuality } from "../../utils/decodeCapability";
import {
  abrRestrictions,
  streamQualityToChoice,
  type QualityChoice,
} from "../videoPlayerQuality";
import type { StreamType } from "../videoPlayerTypes";

interface Options {
  videoRef: RefObject<HTMLVideoElement>;
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>;
  src: string;
  streamType: StreamType;
  compatMode: boolean;
  shakaReady: boolean;
  dashReloadToken: number;
  setDashReloadToken: Dispatch<SetStateAction<number>>;
  /** Where to resume after a reload that the downgrade triggers. */
  pendingSeekRef: MutableRefObject<number>;
  defaultStreamQuality: StreamQuality;
  /** Tell the viewer why the quality changed. */
  showQualityNotice: (msg: string) => void;
  /** Fires when the live track quality changes (null when unknown). */
  onActiveQualityChange?: (quality: number | null) => void;
}

/**
 * Stream quality for the quality menu and the page chrome: the viewer's pick,
 * the ladder Shaka offers, the quality actually playing, and the automatic
 * downgrade when playback health says the device can't keep up.
 */
export function useStreamQuality({
  videoRef,
  shakaPlayerRef,
  src,
  streamType: effectiveStreamType,
  compatMode,
  shakaReady,
  dashReloadToken,
  setDashReloadToken,
  pendingSeekRef,
  defaultStreamQuality,
  showQualityNotice,
  onActiveQualityChange,
}: Options) {
  const capabilityMaxHeightRef = useRef<number>(2160);
  const [qualityChoice, setQualityChoice] = useState<QualityChoice>(() =>
    streamQualityToChoice(defaultStreamQuality)
  );
  /** Distinct short-side qualities (min(w,h)), not raw frame heights. */
  const [availableHeights, setAvailableHeights] = useState<number[]>([]);
  /** Live ABR / selected track quality (YouTube ladder), when known. */
  const [activeQuality, setActiveQuality] = useState<number | null>(null);
  const qualityChoiceRef = useRef(qualityChoice);
  qualityChoiceRef.current = qualityChoice;
  const variantTracksRef = useRef<
    {
      width?: number | null;
      height?: number | null;
      bandwidth?: number;
    }[]
  >([]);
  /** A new source starts from the setting again with an empty ladder. */
  const resetQuality = useCallback(() => {
    setAvailableHeights([]);
    setActiveQuality(null);
    setQualityChoice(streamQualityToChoice(defaultStreamQuality));
  }, [defaultStreamQuality]);

  // Keep the quality chip honest: Auto often sits well below the ladder ceiling.
  useEffect(() => {
    if (effectiveStreamType !== "dash" || !shakaReady) {
      setActiveQuality(null);
      onActiveQualityChange?.(null);
      return;
    }
    const p = shakaPlayerRef.current;
    if (!p) return;

    const sync = () => {
      try {
        const tracks = p.getVariantTracks() ?? [];
        variantTracksRef.current = tracks;
        const active = tracks.find((t) => t.active);
        const q = active ? trackQuality(active) : null;
        setActiveQuality(q);
        onActiveQualityChange?.(q);
      } catch {
        // player may be mid-destroy
      }
    };
    sync();
    p.addEventListener("adaptation", sync);
    p.addEventListener("variantchanged", sync);
    const id = window.setInterval(sync, 2500);
    return () => {
      p.removeEventListener("adaptation", sync);
      p.removeEventListener("variantchanged", sync);
      window.clearInterval(id);
    };
    // onActiveQualityChange is stable enough via PlaybackContext setter
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActiveQualityChange is a stable setter; re-subscribing on its identity would reset the poll
  }, [effectiveStreamType, shakaReady, dashReloadToken, src]);

  // Progressive / compat: report video element's decoded size when known.
  useEffect(() => {
    if (effectiveStreamType === "dash" && !compatMode) return;
    const el = videoRef.current;
    if (!el) {
      onActiveQualityChange?.(null);
      return;
    }
    const sync = () => {
      const q = trackQuality({
        width: el.videoWidth || null,
        height: el.videoHeight || null,
      });
      const next = q > 0 ? q : null;
      setActiveQuality(next);
      onActiveQualityChange?.(next);
    };
    sync();
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("resize", sync);
    return () => {
      el.removeEventListener("loadedmetadata", sync);
      el.removeEventListener("resize", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActiveQualityChange is a stable setter; listeners re-bind only per stream/src
  }, [effectiveStreamType, compatMode, src]);

  const applyQualityChoice = useApplyShakaQuality(
    shakaPlayerRef,
    capabilityMaxHeightRef,
    variantTracksRef,
    setQualityChoice
  );

  const pickQuality = useCallback(
    (choice: QualityChoice) => {
      // Explicit ladder picks override a persisted auto-downgrade / AV1 blacklist.
      if (choice !== "auto") {
        clearDowngrade();
        capabilityMaxHeightRef.current = Math.max(
          capabilityMaxHeightRef.current,
          typeof choice === "number" ? choice : 2160
        );
      }
      applyQualityChoice(choice);
    },
    [applyQualityChoice]
  );

  usePlaybackHealth({
    enabled: effectiveStreamType === "dash" && shakaReady,
    player: shakaReady ? shakaPlayerRef.current : null,
    onDowngrade: ({ maxHeight, blacklistAv1, notice }) => {
      const p = shakaPlayerRef.current;
      if (!p) return;
      capabilityMaxHeightRef.current = Math.min(
        capabilityMaxHeightRef.current,
        maxHeight
      );
      // Relabel the menu to the new ceiling so UI matches what can play.
      setQualityChoice(maxHeight);
      try {
        if (blacklistAv1) {
          // Codec family change needs a reload so Shaka re-filters AdaptationSets.
          // readDowngrade() is consulted on the next load.
          const t = videoRef.current?.currentTime ?? 0;
          if (t > 1) pendingSeekRef.current = t;
          setDashReloadToken((n) => n + 1);
        } else {
          const tracks = p.getVariantTracks() ?? [];
          variantTracksRef.current = tracks;
          p.configure({
            abr: { enabled: false },
            restrictions: abrRestrictions(maxHeight, tracks),
          });
          const candidates = tracks.filter((t) => trackQuality(t) <= maxHeight);
          candidates.sort((a, b) => {
            const qa = trackQuality(a);
            const qb = trackQuality(b);
            if (qb !== qa) return qb - qa;
            return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
          });
          if (candidates[0]) {
            p.selectVariantTrack(candidates[0], true);
          }
        }
      } catch (err) {
        console.warn("[preview-health] configure failed", err);
      }
      showQualityNotice(notice);
    },
  });

  return {
    qualityChoice,
    setQualityChoice,
    qualityChoiceRef,
    availableHeights,
    setAvailableHeights,
    activeQuality,
    capabilityMaxHeightRef,
    variantTracksRef,
    pickQuality,
    resetQuality,
  };
}
