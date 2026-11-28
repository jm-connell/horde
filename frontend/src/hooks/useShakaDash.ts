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
  ShakaVariantTrack,
} from "shaka-player/dist/shaka-player.dash.js";
import {
  codecFamily,
  probeDecodeSupport,
  readBandwidthEstimate,
  trackQuality,
  type CodecFamily,
  type DecodeSupport,
} from "../utils/decodeCapability";
import type { StreamDowngrade } from "./usePlaybackHealth";
import {
  abrRestrictions,
  distinctQualities,
  type QualityChoice,
} from "../components/videoPlayerQuality";
import type { StreamType } from "../components/videoPlayerTypes";

export type { CodecFamily };

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
    maxAttempts: 5,
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

export const LIVE_MANIFEST_CONFIG = {
  retryParameters: {
    maxAttempts: 6,
    baseDelay: 500,
    backoffFactor: 2,
    fuzzFactor: 0.5,
    timeout: 15_000,
  },
  hls: {
    // Append each segment where the last one ended. Segments mode pins every
    // audio segment to its playlist start, 5.000 s apart, while YouTube's AAC
    // segments hold 215 or 216 frames (4.992 or 5.016 s). The gaps left by the
    // short ones make Chrome's audio clock drift ahead of the picture (about
    // 1 s every 10 minutes) until a seek. Shaka still realigns both tracks to
    // the playlist after a seek. See selectQualityTrack for quality switches.
    sequenceMode: true,
  },
};

/**
 * A stream whose media requests keep failing is loaded again after this
 * pause, which gives the server time to fetch fresh media addresses.
 */
const NETWORK_RELOAD_DELAY_MS = 2000;
export const STREAM_FAILED_MESSAGE =
  "The stream stopped loading. Try again or download the video.";
/** Shaka's error category for failed requests (bad status, timeout, offline). */
const SHAKA_NETWORK_CATEGORY = 1;
/** `shaka.net.NetworkingEngine.RequestType.MANIFEST`. */
const SHAKA_MANIFEST_REQUEST = 0;

const LIVE_MAX_RETRIES = 6;
/** Recoverable errors (failed playlist refreshes) in a row before giving up. */
const LIVE_MAX_RECOVERABLE = 40;
export const LIVE_ENDED_MESSAGE = "This live stream has ended.";
export const LIVE_NOT_LIVE_MESSAGE = "This video is not live right now.";

/**
 * Shaka 5 `preferredVideo` entries for codecs in order of preference (it
 * replaced `preferredVideoCodecs`); other fields keep Shaka's defaults.
 */
function preferVideoCodecs(codecs: string[]) {
  return codecs.map((codec) => ({
    codec,
    label: "",
    role: "",
    language: "",
    hdrLevel: "AUTO",
    layout: "",
  }));
}

/**
 * Shaka's codec preference, in order. Live keeps Shaka's default (no
 * preference): its ladder is H.264 up to 1080p and VP9 above, since YouTube
 * serves 1440p and 2160p live only as VP9, and a preference drops every
 * variant in another codec.
 */
export function videoCodecConfig(live: boolean, codecs: CodecFamily[]) {
  if (live) return {};
  return { preferredVideo: preferVideoCodecs(codecs) };
}

/** What one stream has learned or been asked for. Its reloads keep it. */
export type StreamQualityState = {
  /** The automatic step-down in force. */
  downgrade: StreamDowngrade | null;
  /** The viewer picked a quality only this codec offers: load its ladder. */
  pickedCodec: CodecFamily | null;
  /** Qualities only another codec's ladder has, while this one is loaded. */
  otherCodecQualities: { quality: number; codec: CodecFamily }[];
};

/**
 * How a load of a stream plays on Auto. Shaka keeps one codec's ladder per
 * load, the first of `codecs` the manifest offers: H.264 tops out at 1080p,
 * and only AV1 or VP9 go higher. Software decoding of either drops frames at
 * the start of every high-quality video, so a codec is listed only where this
 * device decodes it in hardware, or for a quality the viewer picked that only
 * it offers. A codec the step-down skipped is left out. Above 1080p Auto goes
 * only as high as the listed codecs decode in hardware. Live uses Shaka's
 * default, so `codecs` is empty and its ceiling is VP9's.
 */
export function streamLoadLimits(
  caps: DecodeSupport,
  live: boolean,
  state: StreamQualityState
): { codecs: CodecFamily[]; maxHeight: number } {
  const { downgrade, pickedCodec } = state;
  let codecs: CodecFamily[] = [];
  let hardwareTop = caps.maxVp9Efficient;
  if (!live) {
    codecs = pickedCodec
      ? [pickedCodec, "avc1"]
      : [
          ...(caps.maxAv1Efficient > 0 ? (["av01"] as const) : []),
          ...(caps.maxVp9Efficient > 0 ? (["vp09"] as const) : []),
          "avc1",
        ];
    codecs = codecs.filter((c) => !downgrade?.skipCodecs.includes(c));
    hardwareTop = Math.max(
      codecs.includes("av01") ? caps.maxAv1Efficient : 0,
      codecs.includes("vp09") ? caps.maxVp9Efficient : 0
    );
  }
  const maxHeight = Math.min(
    caps.maxSupportedHeight,
    Math.max(1080, hardwareTop),
    downgrade?.maxHeight ?? Infinity
  );
  return { codecs, maxHeight };
}

/**
 * Auto's ceiling once a video has loaded: only the codec that loaded counts,
 * since `streamLoadLimits` lists every codec that may load but the manifest
 * decides which one does. Software decoding of a higher rung would stutter.
 */
export function loadedCodecCeiling(
  caps: DecodeSupport,
  loaded: CodecFamily | null,
  state: StreamQualityState
): number {
  const hardware =
    loaded === "av01"
      ? caps.maxAv1Efficient
      : loaded === "vp09"
        ? caps.maxVp9Efficient
        : 0;
  return Math.min(
    caps.maxSupportedHeight,
    Math.max(1080, hardware),
    state.downgrade?.maxHeight ?? Infinity
  );
}

const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/**
 * Qualities above `top` that a DASH manifest offers only in AV1 or VP9, read
 * from the manifest text: Shaka drops the other codecs' variants when it
 * loads. Highest first, one entry per quality, with the codec to load for it:
 * VP9 where this device decodes it in hardware, else AV1, else VP9. A quality
 * only codecs the browser cannot decode offer is left out.
 */
export function qualitiesInOtherCodecs(
  mpd: string,
  top: number,
  caps: DecodeSupport
): { quality: number; codec: CodecFamily }[] {
  const offered = new Map<number, Set<CodecFamily>>();
  const sets = mpd.matchAll(
    /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g
  );
  for (const [, setAttrs, body] of sets) {
    const setCodecs = attr(setAttrs, "codecs");
    for (const [tag] of body.matchAll(/<Representation\b[^>]*>/g)) {
      const family = codecFamily(attr(tag, "codecs") ?? setCodecs);
      if (family !== "av01" && family !== "vp09") continue;
      const q = trackQuality({
        width: Number(attr(tag, "width")) || null,
        height: Number(attr(tag, "height")) || null,
      });
      if (q <= top) continue;
      offered.set(q, (offered.get(q) ?? new Set()).add(family));
    }
  }
  const found: { quality: number; codec: CodecFamily }[] = [];
  for (const [quality, families] of offered) {
    const av1 = families.has("av01") && caps.av1Supported;
    const vp9 = families.has("vp09") && caps.vp9Supported;
    const codec =
      vp9 && (!av1 || caps.maxVp9Efficient >= quality)
        ? "vp09"
        : av1
          ? "av01"
          : null;
    if (codec) found.push({ quality, codec });
  }
  return found.sort((a, b) => b.quality - a.quality);
}

export const freshStreamState = (): StreamQualityState => ({
  downgrade: null,
  pickedCodec: null,
  otherCodecQualities: [],
});

/**
 * The stream state after the viewer picks `choice`, or null when the pick
 * needs no reload of the stream: a quality only another codec's ladder has
 * loads that codec, and Auto after such a pick loads the default codecs again.
 */
export function stateAfterPick(
  state: StreamQualityState,
  choice: number | "auto"
): StreamQualityState | null {
  const other =
    typeof choice === "number"
      ? state.otherCodecQualities.find((o) => o.quality === choice)
      : undefined;
  if (other) {
    return {
      downgrade: null,
      pickedCodec: other.codec,
      otherCodecQualities: [],
    };
  }
  if (choice === "auto" && state.pickedCodec) {
    return { ...state, pickedCodec: null };
  }
  return null;
}

/**
 * Whether a frame-drop step-down must reload the video: only when it skips a
 * codec the state has not skipped yet. A repeat (a manifest whose only
 * variants are the skipped codec's) restricts in place instead.
 */
export function downgradeNeedsReload(
  state: StreamQualityState,
  skipCodec: CodecFamily | null
): boolean {
  return (
    skipCodec !== null &&
    !(state.downgrade?.skipCodecs ?? []).includes(skipCodec)
  );
}

/**
 * The stream state after a frame-drop step-down to `maxHeight`: the cut only
 * goes lower, and the codec that was dropping frames (null for H.264, which
 * has no other to fall back to) is skipped for the rest of the video.
 */
export function stateAfterDowngrade(
  state: StreamQualityState,
  maxHeight: number,
  skipCodec: CodecFamily | null
): StreamQualityState {
  const prev = state.downgrade;
  const skipCodecs = prev?.skipCodecs ?? [];
  return {
    ...state,
    downgrade: {
      maxHeight: Math.min(prev?.maxHeight ?? maxHeight, maxHeight),
      skipCodecs:
        skipCodec && !skipCodecs.includes(skipCodec)
          ? [...skipCodecs, skipCodec]
          : skipCodecs,
    },
  };
}

/**
 * Play `track` from now on. A video drops what it has buffered so the new
 * quality shows at once. A live stream keeps its buffer and switches where it
 * ends (a few segments ahead), as Shaka's own ABR does: in sequence mode Shaka
 * appends after a manual clear where the cleared segments ended, away from the
 * playhead, and playback stalls.
 */
export function selectQualityTrack(p: ShakaPlayer, track: ShakaVariantTrack) {
  p.selectVariantTrack(track, /* clearBuffer */ !p.isLive());
}

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
  /**
   * Where to begin, in seconds (`?t=`, a resume position, or the playhead kept
   * across a reload). Given to Shaka's `load`: a seek at `loadedmetadata` is
   * undone when Shaka then sets its own start (the beginning).
   */
  startTimeRef: MutableRefObject<number>;
  shakaPlayerRef: MutableRefObject<ShakaPlayer | null>;
  qualityChoiceRef: MutableRefObject<QualityChoice>;
  capabilityMaxHeightRef: MutableRefObject<number>;
  /** This stream's quality state (read at every load of it). */
  streamStateRef: MutableRefObject<StreamQualityState>;
  variantTracksRef: MutableRefObject<
    {
      width?: number | null;
      height?: number | null;
      bandwidth?: number;
    }[]
  >;
  casting: boolean;
  enterCompatMode: () => boolean;
  /**
   * Load the stream again at the playhead; false when reloads are used up.
   * Read when an error arrives, so it need not be stable.
   */
  reloadStream: () => boolean;
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
  startTimeRef,
  shakaPlayerRef,
  qualityChoiceRef,
  capabilityMaxHeightRef,
  streamStateRef,
  variantTracksRef,
  casting,
  enterCompatMode,
  reloadStream,
  setShakaReady,
  setAvailableHeights,
  setQualityChoice,
  setMediaError,
  setBuffering,
}: UseShakaDashArgs): void {
  const destroyQueueRef = useRef(Promise.resolve());
  const reloadStreamRef = useRef(reloadStream);
  reloadStreamRef.current = reloadStream;

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
    let networkReloadTimer: number | null = null;
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

        const stream = streamStateRef.current;
        const { codecs, maxHeight } = streamLoadLimits(caps, live, stream);
        capabilityMaxHeightRef.current = maxHeight;
        const bwEstimate = persistedBw ?? 5_000_000;
        const initialChoice = qualityChoiceRef.current;

        shaka.polyfill.installAll();
        const p = new shaka.Player();
        created = p;
        await p.attach(videoRef.current);
        if (cancelled) return;

        const abrEnabled = initialChoice === "auto";

        p.configure({
          streaming: live ? LIVE_STREAMING_CONFIG : VOD_STREAMING_CONFIG,
          ...(live ? { manifest: LIVE_MANIFEST_CONFIG } : {}),
          abr: {
            enabled: abrEnabled,
            defaultBandwidthEstimate: bwEstimate,
            switchInterval: 8,
          },
          ...videoCodecConfig(live, codecs),
          restrictions: {
            maxHeight: abrEnabled ? maxHeight : 8192,
            maxWidth: 8192,
          },
          mediaSource: {
            codecSwitchingStrategy: "smooth",
          },
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
          console.error("[preview] critical shaka error", detail);
          if (detail?.category === SHAKA_NETWORK_CATEGORY) {
            // Media requests failed after Shaka's own retries (1001 bad
            // status, 1002, 1003 timeout). The progressive fallback asks the
            // same upstream, so it cannot help; loading the stream again,
            // as a page refresh does, usually can.
            if (networkReloadTimer != null) return;
            setBuffering(true);
            networkReloadTimer = window.setTimeout(() => {
              networkReloadTimer = null;
              if (cancelled || reloadStreamRef.current()) return;
              setMediaError(STREAM_FAILED_MESSAGE);
              setBuffering(false);
            }, NETWORK_RELOAD_DELAY_MS);
            return;
          }
          criticalHits += 1;
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
        // The manifest's text, for the qualities only another codec's ladder has.
        let manifestText: string | null = null;
        if (!live) {
          p.getNetworkingEngine()?.registerResponseFilter((type, response) => {
            if (type === SHAKA_MANIFEST_REQUEST) {
              manifestText = new TextDecoder().decode(response.data);
            }
          });
        }
        const startAt = startTimeRef.current;
        await p.load(src, !live && startAt > 1 ? startAt : undefined);
        if (cancelled) return;

        shakaPlayerRef.current = p;
        const variants = p.getVariantTracks() ?? [];
        variantTracksRef.current = variants;
        const qualities = distinctQualities(variants);
        const others = manifestText
          ? qualitiesInOtherCodecs(manifestText, qualities[0] ?? 0, caps)
          : [];
        stream.otherCodecQualities = others;
        setAvailableHeights([...others.map((o) => o.quality), ...qualities]);
        const ceiling = live
          ? maxHeight
          : loadedCodecCeiling(
              caps,
              codecFamily(variants[0]?.videoCodec),
              stream
            );
        capabilityMaxHeightRef.current = ceiling;
        if (abrEnabled) {
          p.configure({
            restrictions: abrRestrictions(ceiling, variants),
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
              const family = codecFamily(candidates[0].videoCodec);
              if (family && family !== "avc1") {
                p.configure({
                  preferredVideo: preferVideoCodecs([family, "avc1"]),
                });
              }
              selectQualityTrack(p, candidates[0]);
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
      if (networkReloadTimer != null) window.clearTimeout(networkReloadTimer);
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

/**
 * Play the best track at or below `choice`, with ABR off. Returns the stream's
 * tracks and the quality picked (null when there are none). The cap an
 * automatic step-down set goes first: Shaka leaves tracks over it out of
 * getVariantTracks(), so a pick above it would land on the cap.
 */
export function applyQualityPick(p: ShakaPlayer, choice: number) {
  p.configure({
    abr: { enabled: false },
    restrictions: { maxHeight: 8192, maxWidth: 8192 },
  });
  const tracks = p.getVariantTracks() ?? [];
  const qualities = distinctQualities(tracks);
  const target =
    qualities.find((q) => q <= choice) ?? qualities[qualities.length - 1];
  if (target == null) return { tracks, target: null };
  const candidates = tracks.filter((t) => trackQuality(t) === target);
  candidates.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  if (candidates[0]) {
    // YouTube 1440/4K is typically AV1 or VP9 only; honor an explicit pick
    // even when Auto prefers H.264 for power efficiency.
    const family = codecFamily(candidates[0].videoCodec);
    if (family && family !== "avc1") {
      p.configure({
        preferredVideo: preferVideoCodecs([family, "avc1"]),
      });
    }
    selectQualityTrack(p, candidates[0]);
  }
  return { tracks, target };
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
        if (choice === "auto") {
          const tracks = p.getVariantTracks() ?? [];
          variantTracksRef.current = tracks;
          const cap = capabilityMaxHeightRef.current;
          p.configure({
            abr: { enabled: true },
            restrictions: abrRestrictions(cap, tracks),
          });
          return;
        }
        const picked = applyQualityPick(p, choice);
        variantTracksRef.current = picked.tracks;
        if (picked.target != null && picked.target !== choice) {
          setQualityChoice(picked.target);
        }
      } catch (err) {
        console.warn("[stream-quality] apply failed", err);
      }
    },
    [shakaPlayerRef, capabilityMaxHeightRef, variantTracksRef, setQualityChoice]
  );
}
