/**
 * Adaptive DASH load / destroy / quality apply for VideoPlayer preview, and the
 * HLS load for live streams (`live`). Library progressive playback does not use
 * this hook's load path.
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

const VOD_STREAMING_CONFIG = {
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
};

/**
 * Live: a smaller buffer (the edge is only a few segments ahead) and more
 * patient retries, since a 502 while the server refreshes YouTube's URLs
 * clears up within seconds.
 */
const LIVE_STREAMING_CONFIG = {
  ...VOD_STREAMING_CONFIG,
  bufferingGoal: 20,
  rebufferingGoal: 2,
  bufferBehind: 30,
  retryParameters: {
    maxAttempts: 6,
    baseDelay: 500,
    backoffFactor: 2,
    fuzzFactor: 0.5,
    timeout: 20_000,
  },
};

const LIVE_MANIFEST_CONFIG = {
  retryParameters: {
    maxAttempts: 6,
    baseDelay: 500,
    backoffFactor: 2,
    fuzzFactor: 0.5,
    timeout: 15_000,
  },
};

const LIVE_MAX_RETRIES = 6;
/** Recoverable errors (failed playlist refreshes) in a row before giving up. */
const LIVE_MAX_RECOVERABLE = 40;
export const LIVE_ENDED_MESSAGE = "This live stream has ended.";
export const LIVE_NOT_LIVE_MESSAGE = "This video is not live right now.";

/** HTTP status of a Shaka BAD_HTTP_STATUS (1001) error: `data[1]`. */
export function httpStatusOf(
  error: ShakaError | null | undefined
): number | null {
  if (!error || error.code !== 1001 || !Array.isArray(error.data)) return null;
  const status = error.data[1];
  return typeof status === "number" ? status : null;
}

export interface UseShakaDashArgs {
  src: string;
  effectiveStreamType: StreamType;
  dashReloadToken: number;
  /** Drop the live DASH session without unmounting the player chrome. */
  mediaSuspended?: boolean;
  /**
   * A live broadcast (HLS through `/api/live`). Loads the HLS build, retries a
   * stalled stream in place instead of falling back, and reports the end.
   */
  live?: boolean;
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
  live = false,
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
    // Live: consecutive failures since the stream last played.
    let liveFailures = 0;
    let liveRecoverable = 0;
    let liveStopped = false;
    const onLivePlaying = () => {
      liveFailures = 0;
      liveRecoverable = 0;
    };
    /** Show `message` and stop the player's own retries (Retry reloads). */
    const stopLive = (message: string) => {
      if (liveStopped) return;
      liveStopped = true;
      setMediaError(message);
      setBuffering(false);
      videoRef.current?.pause();
      const p = shakaPlayerRef.current ?? created;
      void p?.unload?.().catch(() => undefined);
    };
    if (live) video.addEventListener("playing", onLivePlaying);

    const loadDash = async () => {
      try {
        await destroyQueueRef.current;
        if (cancelled || !videoRef.current) return;

        const mod = live
          ? await import("shaka-player/dist/shaka-player.hls.js")
          : await import("shaka-player/dist/shaka-player.dash.js");
        const shaka = mod as unknown as ShakaNamespace;
        if (cancelled || !videoRef.current) return;

        if (!shaka.Player.isBrowserSupported()) {
          if (!enterCompatMode()) {
            setMediaError(
              live
                ? "Live streams are not supported in this browser"
                : "Adaptive streaming is not supported in this browser"
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
          streaming: live ? LIVE_STREAMING_CONFIG : VOD_STREAMING_CONFIG,
          ...(live ? { manifest: LIVE_MANIFEST_CONFIG } : {}),
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
            if (!live) return;
            // Shaka keeps retrying a failing playlist refresh on its own and
            // reports each failure as recoverable: watch for the end (409)
            // and give up after a long run of failures without playback.
            if (httpStatusOf(detail) === 409) {
              stopLive(LIVE_ENDED_MESSAGE);
              return;
            }
            liveRecoverable += 1;
            if (liveRecoverable >= LIVE_MAX_RECOVERABLE) {
              stopLive("The live stream stopped responding.");
            }
            return;
          }
          if (live) {
            console.error("[live] shaka error", detail);
            if (httpStatusOf(detail) === 409) {
              stopLive(LIVE_ENDED_MESSAGE);
              return;
            }
            // The server refreshes YouTube's URLs on its side; give it time and
            // pick the stream up again where it stopped.
            liveFailures += 1;
            if (liveFailures <= LIVE_MAX_RETRIES) {
              setBuffering(true);
              const delay = Math.min(16, 2 ** (liveFailures - 1));
              if (p.retryStreaming(delay)) return;
            }
            stopLive("The live stream stopped responding.");
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

        if (live) {
          // Ask once before handing the URL to Shaka: a stream that is not
          // live answers 409 at once instead of after Shaka's six retries.
          const probe = await fetch(src, { credentials: "same-origin" }).catch(
            () => null
          );
          if (cancelled) return;
          if (probe?.status === 409) {
            setMediaError(LIVE_NOT_LIVE_MESSAGE);
            setBuffering(false);
            return;
          }
        }
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
        if (live) {
          setMediaError(
            httpStatusOf(err as ShakaError) === 409
              ? LIVE_NOT_LIVE_MESSAGE
              : "Could not start the live stream."
          );
          setBuffering(false);
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to start adaptive stream";
        if (!enterCompatMode()) {
          setMediaError(msg);
          setBuffering(false);
        }
      }
    };

    void loadDash();

    return () => {
      cancelled = true;
      video.removeEventListener("playing", onLivePlaying);
      setShakaReady(false);
      const active = created ?? shakaPlayerRef.current;
      shakaPlayerRef.current = null;
      enqueueDestroy(active);
    };
    // Intentionally omit casting — only checked at load time for autoplay.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- casting is read once at load time; re-running would tear down the player
  }, [
    src,
    effectiveStreamType,
    dashReloadToken,
    mediaSuspended,
    enterCompatMode,
    live,
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
    [shakaPlayerRef, capabilityMaxHeightRef, variantTracksRef, setQualityChoice]
  );
}
