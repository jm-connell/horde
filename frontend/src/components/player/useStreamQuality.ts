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
import {
  selectQualityTrack,
  useApplyShakaQuality,
  type StreamQualityState,
} from "../../hooks/useShakaDash";
import type { StreamQuality } from "../../hooks/useSettings";
import { trackQuality } from "../../utils/decodeCapability";
import {
  abrRestrictions,
  streamQualityToChoice,
  type QualityChoice,
} from "../videoPlayerQuality";
import type { StreamType } from "../videoPlayerTypes";

const freshStreamState = (): StreamQualityState => ({
  downgrade: null,
  pickedCodec: null,
  otherCodecQualities: [],
});

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
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
}: Options) {
  const capabilityMaxHeightRef = useRef<number>(2160);
  /** This stream's quality state; a reload of the stream keeps it. */
  const streamStateRef = useRef<StreamQualityState>(freshStreamState());
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
    streamStateRef.current = freshStreamState();
    setAvailableHeights([]);
    setActiveQuality(null);
    setQualityChoice(streamQualityToChoice(defaultStreamQuality));
  }, [defaultStreamQuality]);

  // Keep the quality chip honest: Auto often sits well below the ladder ceiling.
  useEffect(() => {
    if (effectiveStreamType !== "dash" || !shakaReady) {
      setActiveQuality(null);
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
  }, [effectiveStreamType, shakaReady, dashReloadToken, src, shakaPlayerRef]);

  // Progressive / compat: report video element's decoded size when known.
  useEffect(() => {
    if (effectiveStreamType === "dash" && !compatMode) return;
    const el = videoRef.current;
    if (!el) return;
    const sync = () => {
      const q = trackQuality({
        width: el.videoWidth || null,
        height: el.videoHeight || null,
      });
      const next = q > 0 ? q : null;
      setActiveQuality(next);
    };
    sync();
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("resize", sync);
    return () => {
      el.removeEventListener("loadedmetadata", sync);
      el.removeEventListener("resize", sync);
    };
  }, [effectiveStreamType, compatMode, src, videoRef]);

  const applyQualityChoice = useApplyShakaQuality(
    shakaPlayerRef,
    capabilityMaxHeightRef,
    variantTracksRef,
    setQualityChoice
  );

  /** Load this stream again where it is playing (a codec changes on a load). */
  const reloadHere = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    if (t > 1) pendingSeekRef.current = t;
    setDashReloadToken((n) => n + 1);
  }, [videoRef, pendingSeekRef, setDashReloadToken]);

  const pickQuality = useCallback(
    (choice: QualityChoice) => {
      const stream = streamStateRef.current;
      const other =
        typeof choice === "number"
          ? stream.otherCodecQualities.find((o) => o.quality === choice)
          : undefined;
      if (other) {
        // Only another codec's ladder has it: load this video again with it.
        streamStateRef.current = {
          downgrade: null,
          pickedCodec: other.codec,
          otherCodecQualities: [],
        };
        setQualityChoice(choice);
        reloadHere();
        return;
      }
      if (choice === "auto" && stream.pickedCodec) {
        // Auto plays the codec this device decodes in hardware again.
        streamStateRef.current = { ...stream, pickedCodec: null };
        setQualityChoice("auto");
        reloadHere();
        return;
      }
      // Explicit ladder picks override the step-down / AV1 blacklist.
      if (choice !== "auto") {
        stream.downgrade = null;
        capabilityMaxHeightRef.current = Math.max(
          capabilityMaxHeightRef.current,
          typeof choice === "number" ? choice : 2160
        );
      }
      applyQualityChoice(choice);
    },
    [applyQualityChoice, reloadHere]
  );

  usePlaybackHealth({
    enabled: effectiveStreamType === "dash" && shakaReady,
    player: shakaReady ? shakaPlayerRef.current : null,
    onDowngrade: ({ maxHeight, blacklistAv1, notice }) => {
      const p = shakaPlayerRef.current;
      if (!p) return;
      const stream = streamStateRef.current;
      const prev = stream.downgrade;
      stream.downgrade = {
        maxHeight: Math.min(prev?.maxHeight ?? maxHeight, maxHeight),
        skipCodecs: [
          ...(prev?.skipCodecs ?? []),
          ...(blacklistAv1 && !prev?.skipCodecs.includes("av01")
            ? (["av01"] as const)
            : []),
        ],
      };
      capabilityMaxHeightRef.current = Math.min(
        capabilityMaxHeightRef.current,
        maxHeight
      );
      // Relabel the menu to the new ceiling so UI matches what can play.
      setQualityChoice(maxHeight);
      try {
        if (blacklistAv1) {
          // Codec family change needs a reload so Shaka re-filters AdaptationSets.
          // The reload reads streamStateRef.
          reloadHere();
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
            selectQualityTrack(p, candidates[0]);
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
    streamStateRef,
    variantTracksRef,
    pickQuality,
    resetQuality,
  };
}
