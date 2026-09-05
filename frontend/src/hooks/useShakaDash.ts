/**
 * Adaptive DASH load / destroy / quality apply for VideoPlayer preview.
 * Library progressive playback does not use this hook's load path.
 */
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  ShakaError,
  ShakaNamespace,
  ShakaPlayer,
} from "shaka-player/dist/shaka-player.dash.js";
import {
  probeDecodeSupport,
  readBandwidthEstimate,
  readDowngrade,
  trackQuality,
  type DecodeSupport,
} from "../utils/decodeCapability";
import {
  abrRestrictions,
  distinctQualities,
  type QualityChoice,
} from "../components/videoPlayerQuality";
import type { StreamType } from "../components/videoPlayerTypes";

export interface UseShakaDashArgs {
  src: string;
  effectiveStreamType: StreamType;
  dashReloadToken: number;
  /** Drop the live DASH session without unmounting the player chrome. */
  mediaSuspended?: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>;
  qualityChoiceRef: MutableRefObject<QualityChoice>;
  capabilityMaxHeightRef: MutableRefObject<number>;
  variantTracksRef: MutableRefObject<
    {
      width?: number | null;
      height?: number | null;
      bandwidth?: number;
    }[]
  >;
  casting: boolean;
  enterCompatMode: () => boolean;
  setShakaReady: Dispatch<SetStateAction<boolean>>;
  setAvailableHeights: Dispatch<SetStateAction<number[]>>;
  setQualityChoice: Dispatch<SetStateAction<QualityChoice>>;
  setMediaError: Dispatch<SetStateAction<string | null>>;
  setBuffering: Dispatch<SetStateAction<boolean>>;
}

export function useShakaDashLoad({
  src,
  effectiveStreamType,
  dashReloadToken,
  mediaSuspended = false,
  videoRef,
  shakaPlayerRef,
  qualityChoiceRef,
  capabilityMaxHeightRef,
  variantTracksRef,
  casting,
  enterCompatMode,
  setShakaReady,
  setAvailableHeights,
  setQualityChoice,
  setMediaError,
  setBuffering,
}: UseShakaDashArgs): void {
  const destroyQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    let created: ShakaPlayer | null = null;

    const enqueueDestroy = (player: ShakaPlayer | null) => {
      if (!player) return;
      destroyQueueRef.current = destroyQueueRef.current
        .then(() => player.destroy())
        .catch(() => undefined);
    };

    if (mediaSuspended) {
      const existing = shakaPlayerRef.current;
      shakaPlayerRef.current = null;
      setShakaReady(false);
      setBuffering(true);
      enqueueDestroy(existing);
      return () => {
        cancelled = true;
      };
    }

    if (effectiveStreamType !== "dash" || !src) {
      const existing = shakaPlayerRef.current;
      shakaPlayerRef.current = null;
      setShakaReady(false);
      enqueueDestroy(existing);
      return () => {
        cancelled = true;
      };
    }

    const video = videoRef.current;
    if (!video) return;

    let criticalHits = 0;

    const loadDash = async () => {
      try {
        await destroyQueueRef.current;
        if (cancelled || !videoRef.current) return;

        const mod = await import("shaka-player/dist/shaka-player.dash.js");
        const shaka = mod as unknown as ShakaNamespace;
        if (cancelled || !videoRef.current) return;

        if (!shaka.Player.isBrowserSupported()) {
          if (!enterCompatMode()) {
            setMediaError(
              "Adaptive streaming is not supported in this browser"
            );
            setBuffering(false);
          }
          return;
        }

        const prev = shakaPlayerRef.current;
        shakaPlayerRef.current = null;
        setShakaReady(false);
        if (prev) {
          await prev.destroy().catch(() => undefined);
        }
        if (cancelled || !videoRef.current) return;

        const [caps, persistedBw]: [DecodeSupport, number | null] =
          await Promise.all([
            probeDecodeSupport(),
            Promise.resolve(readBandwidthEstimate()),
          ]);
        if (cancelled || !videoRef.current) return;

        const downgrade = readDowngrade();
        // Allow the full supported ladder (incl. 4K AV1). Health monitor
        // downgrades if the decoder starts dropping frames.
        const maxHeight = Math.min(
          caps.maxSupportedHeight,
          downgrade?.maxHeight ?? Infinity
        );
        capabilityMaxHeightRef.current = maxHeight;
        const preferAv1 = caps.av1Supported && !downgrade?.blacklistAv1;
        const bwEstimate = persistedBw ?? 5_000_000;
        const initialChoice = qualityChoiceRef.current;

        shaka.polyfill.installAll();
        const p = new shaka.Player();
        created = p;
        await p.attach(videoRef.current);
        if (cancelled) return;

        const abrEnabled = initialChoice === "auto";
        const videoEl = videoRef.current;
        const SimpleTextDisplayer = shaka.text?.SimpleTextDisplayer;

        p.configure({
          streaming: {
            bufferingGoal: 30,
            rebufferingGoal: 4,
            bufferBehind: 60,
            stallEnabled: true,
            stallThreshold: 1,
            stallSkip: 0.1,
            gapDetectionThreshold: 0.5,
            gapJumpTimerTime: 0.25,
            retryParameters: {
              maxAttempts: 4,
              baseDelay: 400,
              backoffFactor: 2,
              fuzzFactor: 0.5,
              timeout: 30_000,
            },
          },
          abr: {
            enabled: abrEnabled,
            defaultBandwidthEstimate: bwEstimate,
            switchInterval: 8,
          },
          preferredVideoCodecs: preferAv1 ? ["av01", "avc1"] : ["avc1"],
          restrictions: {
            maxHeight: abrEnabled ? maxHeight : 8192,
            maxWidth: 8192,
          },
          mediaSource: {
            codecSwitchingStrategy: "smooth",
          },
          ...(videoEl && SimpleTextDisplayer
            ? {
                textDisplayFactory: () =>
                  new SimpleTextDisplayer(videoEl, "Horde Text"),
              }
            : {}),
        });

        p.addEventListener("error", ((event: Event) => {
          const detail = (event as CustomEvent<ShakaError>).detail;
          const severity = detail?.severity ?? 2;
          const msg =
            detail?.message ||
            (detail?.code != null
              ? `Playback error (${detail.code})`
              : "Adaptive playback failed");
          if (severity === 1) {
            console.warn("[preview] recoverable shaka error", detail);
            return;
          }
          criticalHits += 1;
          console.error("[preview] critical shaka error", detail);
          if (criticalHits >= 2 && enterCompatMode()) {
            return;
          }
          setMediaError(msg);
          setBuffering(false);
        }) as EventListener);

        await p.load(src);
        if (cancelled) return;

        shakaPlayerRef.current = p;
        const variants = p.getVariantTracks() ?? [];
        variantTracksRef.current = variants;
        const qualities = distinctQualities(variants);
        setAvailableHeights(qualities);
        if (abrEnabled) {
          p.configure({
            restrictions: abrRestrictions(maxHeight, variants),
          });
        } else {
          const target =
            qualities.find((q) => q <= initialChoice) ??
            qualities[qualities.length - 1];
          if (target != null) {
            p.configure({
              abr: { enabled: false },
              restrictions: { maxHeight: 8192, maxWidth: 8192 },
            });
            const candidates = variants.filter(
              (t) => trackQuality(t) === target
            );
            candidates.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
            if (candidates[0]) {
              const codec = (candidates[0].videoCodec ?? "").toLowerCase();
              if (codec.startsWith("av01")) {
                p.configure({ preferredVideoCodecs: ["av01", "avc1"] });
              }
              p.selectVariantTrack(candidates[0], /* clearBuffer */ true);
            }
            if (target !== initialChoice) {
              setQualityChoice(target);
            }
          }
        }
        setShakaReady(true);
        setBuffering(false);

        if (!casting) {
          videoRef.current?.play().catch(() => undefined);
        }
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Failed to start adaptive stream";
        if (!enterCompatMode()) {
          setMediaError(msg);
          setBuffering(false);
        }
      }
    };

    void loadDash();

    return () => {
      cancelled = true;
      setShakaReady(false);
      const active = created ?? shakaPlayerRef.current;
      shakaPlayerRef.current = null;
      enqueueDestroy(active);
    };
    // Intentionally omit casting — only checked at load time for autoplay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    src,
    effectiveStreamType,
    dashReloadToken,
    mediaSuspended,
    enterCompatMode,
  ]);
}

export function useApplyShakaQuality(
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>,
  capabilityMaxHeightRef: MutableRefObject<number>,
  variantTracksRef: MutableRefObject<
    {
      width?: number | null;
      height?: number | null;
      bandwidth?: number;
    }[]
  >,
  setQualityChoice: Dispatch<SetStateAction<QualityChoice>>
) {
  return useCallback(
    (choice: QualityChoice) => {
      const p = shakaPlayerRef.current;
      if (!p) return;
      setQualityChoice(choice);
      try {
        const tracks = p.getVariantTracks() ?? [];
        variantTracksRef.current = tracks;
        if (choice === "auto") {
          const cap = capabilityMaxHeightRef.current;
          p.configure({
            abr: { enabled: true },
            restrictions: abrRestrictions(cap, tracks),
          });
          return;
        }
        p.configure({
          abr: { enabled: false },
          restrictions: { maxHeight: 8192, maxWidth: 8192 },
        });
        const qualities = distinctQualities(tracks);
        const target =
          qualities.find((q) => q <= choice) ?? qualities[qualities.length - 1];
        if (target == null) return;
        const candidates = tracks.filter((t) => trackQuality(t) === target);
        candidates.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
        if (candidates[0]) {
          // YouTube 1440/4K is typically AV1-only; honor an explicit pick even
          // when Auto prefers H.264 for power efficiency.
          const codec = (candidates[0].videoCodec ?? "").toLowerCase();
          if (codec.startsWith("av01")) {
            p.configure({ preferredVideoCodecs: ["av01", "avc1"] });
          }
          p.selectVariantTrack(candidates[0], /* clearBuffer */ true);
        }
        if (target !== choice) setQualityChoice(target);
      } catch (err) {
        console.warn("[stream-quality] apply failed", err);
      }
    },
    [
      shakaPlayerRef,
      capabilityMaxHeightRef,
      variantTracksRef,
      setQualityChoice,
    ]
  );
}
